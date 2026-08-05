#!/usr/bin/env bash
set -euo pipefail

prototype_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
experiment=${B3_EXPERIMENT:-transactional-outbox}
sequence_stripes=${B3_SEQUENCE_STRIPES:-4}
case "$sequence_stripes" in
  4|16|64) ;;
  *) echo "B3_SEQUENCE_STRIPES must be 4, 16, or 64" >&2; exit 2 ;;
esac
if [[ "$experiment" == "transactional-outbox" ]]; then
  state_file="$prototype_dir/.b3-run.env"
  default_prefix=osfo-b3-38
else
  state_file="$prototype_dir/.b3-$experiment.env"
  default_prefix="osfo-b3-38-$experiment"
fi
evidence_root="$prototype_dir/evidence/b3-$experiment"

project_id=${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}
region=${GCP_REGION:-northamerica-northeast1}
prefix=${RESOURCE_PREFIX:-$default_prefix}
sql_instance="$prefix-sql"
artifact_repository="$prefix-repo"
image_uri="$region-docker.pkg.dev/$project_id/$artifact_repository/prototype:latest"
worker_service_account="$prefix-worker@$project_id.iam.gserviceaccount.com"
ingress_service_account="$prefix-ingress@$project_id.iam.gserviceaccount.com"
relay_service_account="$prefix-relay@$project_id.iam.gserviceaccount.com"
push_auth_service_account="$prefix-push-auth@$project_id.iam.gserviceaccount.com"
worker_service="$prefix-worker"
ingress_service="$prefix-ingress"
relay_service="$prefix-relay"
topic_id="$prefix-agent-runs"
subscription_id="$prefix-agent-runs"
database_secret="$prefix-database-url"
proxy_port=55438
proxy_pid=""

cleanup_proxy() {
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
    proxy_pid=""
  fi
}
trap cleanup_proxy EXIT

load_state() {
  if [[ ! -f "$state_file" ]]; then
    echo "Missing $state_file. Run ./b3-run.sh provision first." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$state_file"
}

start_proxy() {
  load_state
  if [[ -n "$proxy_pid" ]]; then
    return
  fi
  mkdir -p "$evidence_root"
  cloud-sql-proxy --address 127.0.0.1 --port "$proxy_port" "$sql_connection_name" >"$evidence_root/cloud-sql-proxy.log" 2>&1 &
  proxy_pid=$!
  for _ in $(seq 1 60); do
    if (echo >"/dev/tcp/127.0.0.1/$proxy_port") 2>/dev/null; then
      return
    fi
    sleep 1
  done
  echo "Cloud SQL proxy did not become ready" >&2
  exit 1
}

local_database_url() {
  echo "postgres://benchmark:$database_password@127.0.0.1:$proxy_port/benchmark?sslmode=disable"
}

ensure_service_account() {
  local account_name=$1
  if ! gcloud iam service-accounts describe "$account_name@$project_id.iam.gserviceaccount.com" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$account_name"
  fi
}

bind_project_role() {
  local member=$1
  local role=$2
  gcloud projects add-iam-policy-binding "$project_id" \
    --member="serviceAccount:$member" --role="$role" --condition=None --quiet >/dev/null
}

provision() {
  mkdir -p "$evidence_root"
  gcloud services enable run.googleapis.com pubsub.googleapis.com sqladmin.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com \
    monitoring.googleapis.com logging.googleapis.com --project="$project_id"

  if ! gcloud artifacts repositories describe "$artifact_repository" --location="$region" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$artifact_repository" --location="$region" --repository-format=docker
  fi
  if ! gcloud sql instances describe "$sql_instance" >/dev/null 2>&1; then
    gcloud sql instances create "$sql_instance" --project="$project_id" --region="$region" \
      --database-version=POSTGRES_17 --edition=enterprise --cpu=4 --memory=15360MiB \
      --storage-size=100 --availability-type=zonal --assign-ip
  fi

  database_password=$(openssl rand -hex 24)
  if gcloud sql users list --instance="$sql_instance" --format='value(name)' | rg -q '^benchmark$'; then
    gcloud sql users set-password benchmark --instance="$sql_instance" --password="$database_password"
  else
    gcloud sql users create benchmark --instance="$sql_instance" --password="$database_password"
  fi
  if ! gcloud sql databases describe benchmark --instance="$sql_instance" >/dev/null 2>&1; then
    gcloud sql databases create benchmark --instance="$sql_instance"
  fi
  sql_connection_name=$(gcloud sql instances describe "$sql_instance" --format='value(connectionName)')

  ensure_service_account "$prefix-worker"
  ensure_service_account "$prefix-ingress"
  ensure_service_account "$prefix-relay"
  ensure_service_account "$prefix-push-auth"
  bind_project_role "$worker_service_account" roles/cloudsql.client
  bind_project_role "$worker_service_account" roles/pubsub.subscriber
  bind_project_role "$ingress_service_account" roles/cloudsql.client
  bind_project_role "$relay_service_account" roles/cloudsql.client
  bind_project_role "$relay_service_account" roles/pubsub.publisher

  cloud_database_url="postgres://benchmark:$database_password@/benchmark?host=/cloudsql/$sql_connection_name&sslmode=disable"
  if gcloud secrets describe "$database_secret" >/dev/null 2>&1; then
    printf '%s' "$cloud_database_url" | gcloud secrets versions add "$database_secret" --data-file=- >/dev/null
  else
    printf '%s' "$cloud_database_url" | gcloud secrets create "$database_secret" --replication-policy=automatic --data-file=- >/dev/null
  fi
  for account in "$worker_service_account" "$ingress_service_account" "$relay_service_account"; do
    gcloud secrets add-iam-policy-binding "$database_secret" \
      --member="serviceAccount:$account" --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
  done

  umask 077
  {
    printf 'database_password=%q\n' "$database_password"
    printf 'sql_connection_name=%q\n' "$sql_connection_name"
  } >"$state_file"

  gcloud builds submit "$prototype_dir" --tag="$image_uri" --project="$project_id"

  gcloud pubsub topics describe "$topic_id" >/dev/null 2>&1 || gcloud pubsub topics create "$topic_id"
  gcloud run deploy "$worker_service" --image="$image_uri" --region="$region" --project="$project_id" \
    --service-account="$worker_service_account" --no-allow-unauthenticated --cpu=1 --memory=1Gi \
    --concurrency=32 --min=0 --max=8 --cpu-throttling --timeout=600 \
    --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="ROLE=push,DB_POOL_SIZE=4,WORKER_SLOTS=32,CLAIM_LEASE_SECONDS=15"
  gcloud run services add-iam-policy-binding "$worker_service" --region="$region" \
    --member="serviceAccount:$push_auth_service_account" --role=roles/run.invoker --condition=None --quiet >/dev/null
  worker_url=$(gcloud run services describe "$worker_service" --region="$region" --format='value(status.url)')
  if ! gcloud pubsub subscriptions describe "$subscription_id" >/dev/null 2>&1; then
    gcloud pubsub subscriptions create "$subscription_id" --topic="$topic_id" --ack-deadline=10 \
      --message-retention-duration=7d --min-retry-delay=10s --max-retry-delay=600s \
      --enable-message-ordering --push-endpoint="$worker_url/v1/pubsub/push" \
      --push-auth-service-account="$push_auth_service_account" \
      --push-auth-token-audience="$worker_url"
  fi

  gcloud run deploy "$ingress_service" --image="$image_uri" --command=/b3-ingress \
    --region="$region" --project="$project_id" --service-account="$ingress_service_account" \
    --no-allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=80 --min=0 --max=8 \
    --cpu-throttling --timeout=60 --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="DB_POOL_SIZE=8,B3_SEQUENCE_STRIPES=$sequence_stripes"
  ingress_url=$(gcloud run services describe "$ingress_service" --region="$region" --format='value(status.url)')
  active_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)
  gcloud run services add-iam-policy-binding "$ingress_service" --region="$region" \
    --member="user:$active_account" --role=roles/run.invoker --condition=None --quiet >/dev/null

  start_proxy
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness migrate)
  capture_inventory "$evidence_root/provisioned-inventory.json"
  capture_frozen_topology "$evidence_root/frozen-topology"
}

deploy_images() {
  load_state
  gcloud builds submit "$prototype_dir" --tag="$image_uri" --project="$project_id"
  gcloud run deploy "$worker_service" --image="$image_uri" --region="$region" --project="$project_id" \
    --service-account="$worker_service_account" --no-allow-unauthenticated --cpu=1 --memory=1Gi \
    --concurrency=32 --min=0 --max=8 --cpu-throttling --timeout=600 \
    --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="ROLE=push,DB_POOL_SIZE=4,WORKER_SLOTS=32,CLAIM_LEASE_SECONDS=15"
  gcloud run deploy "$ingress_service" --image="$image_uri" --command=/b3-ingress \
    --region="$region" --project="$project_id" --service-account="$ingress_service_account" \
    --no-allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=80 --min=0 --max=8 \
    --cpu-throttling --timeout=60 --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="DB_POOL_SIZE=8,B3_SEQUENCE_STRIPES=$sequence_stripes"
  deploy_relay
}

deploy_relay() {
  load_state
  gcloud run deploy "$relay_service" --image="$image_uri" --command=/b3-relay \
    --region="$region" --project="$project_id" --service-account="$relay_service_account" \
    --no-allow-unauthenticated --cpu=1 --memory=512Mi --concurrency=80 --min=1 --max=2 \
    --no-cpu-throttling --timeout=300 --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="GCP_PROJECT_ID=$project_id,PUBSUB_TOPIC_ID=$topic_id,DB_POOL_SIZE=4,RELAY_BATCH_SIZE=128,B3_SEQUENCE_STRIPES=$sequence_stripes"
}

reset_subscription() {
  gcloud pubsub subscriptions delete "$subscription_id" --quiet >/dev/null 2>&1 || true
  local worker_url
  worker_url=$(gcloud run services describe "$worker_service" --region="$region" --format='value(status.url)')
  gcloud pubsub subscriptions create "$subscription_id" --topic="$topic_id" --ack-deadline=10 \
    --message-retention-duration=7d --min-retry-delay=10s --max-retry-delay=600s \
    --enable-message-ordering --push-endpoint="$worker_url/v1/pubsub/push" \
    --push-auth-service-account="$push_auth_service_account" \
    --push-auth-token-audience="$worker_url" >/dev/null
}

capture_frozen_topology() {
  local destination=$1
  mkdir -p "$destination"
  gcloud run services describe "$worker_service" --region="$region" --format=json >"$destination/worker-service.json"
  gcloud run services describe "$ingress_service" --region="$region" --format=json >"$destination/ingress-service.json"
  if gcloud run services describe "$relay_service" --region="$region" >/dev/null 2>&1; then
    gcloud run services describe "$relay_service" --region="$region" --format=json >"$destination/relay-service.json"
    gcloud run services get-iam-policy "$relay_service" --region="$region" --format=json >"$destination/relay-iam.json"
  fi
  gcloud pubsub topics describe "$topic_id" --format=json >"$destination/topic.json"
  gcloud pubsub subscriptions describe "$subscription_id" --format=json >"$destination/subscription.json"
  gcloud sql instances describe "$sql_instance" --format=json >"$destination/cloud-sql.json"
  gcloud projects get-iam-policy "$project_id" --format=json >"$destination/project-iam.json"
  gcloud run services get-iam-policy "$worker_service" --region="$region" --format=json >"$destination/worker-iam.json"
  gcloud run services get-iam-policy "$ingress_service" --region="$region" --format=json >"$destination/ingress-iam.json"
  git -C "$prototype_dir" rev-parse HEAD >"$destination/source-commit.txt"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$destination/captured-at.txt"
}

run_cut_matrix() {
  load_state
  reset_subscription
  start_proxy
  local destination="$evidence_root/cut-matrix"
  mkdir -p "$destination"
  capture_frozen_topology "$destination/topology"
  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (cd "$prototype_dir" && \
    DATABASE_URL=$(local_database_url) GCP_PROJECT_ID="$project_id" PUBSUB_TOPIC_ID="$topic_id" \
    go run ./cmd/b3-harness matrix --repetitions=100 --seeds=3 --batch-size=128 \
      >"$destination/audits.jsonl" 2>"$destination/controller.log")
  local ended_at
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg started_at "$started_at" --arg ended_at "$ended_at" \
    '{manifest:"pubsub-handoff-v1",lane:"deterministic-cut-matrix",started_at:$started_at,ended_at:$ended_at,repetitions_per_cut:100,seeds:3}' \
    >"$destination/scenario.json"
  capture_logs "$destination/runtime-logs.json" "$started_at"
  seal_directory "$destination"
}

hard_crash_smoke() {
  load_state
  reset_subscription
  start_proxy
  local destination="$evidence_root/hard-process-cuts"
  mkdir -p "$destination"
  local fault benchmark_id
  for fault in before_admission_commit after_admission_commit commit_uncertain_succeeded commit_uncertain_failed; do
    benchmark_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness prepare \
      --benchmark="$benchmark_id" --lane="hard-crash/admission/$fault" --expected-incoming=1)
    set +e
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness admit \
      --benchmark="$benchmark_id" --ordinal=0 --attempt=1 --fault="$fault" --hard-crash) \
      >"$destination/admission-$fault.stdout" 2>"$destination/admission-$fault.stderr"
    local exit_code=$?
    set -e
    printf '%s\n' "$exit_code" >"$destination/admission-$fault.exit-code"
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness admit \
      --benchmark="$benchmark_id" --ordinal=0 --attempt=2 --fault=none) \
      >"$destination/admission-$fault-retry.json"
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) GCP_PROJECT_ID="$project_id" PUBSUB_TOPIC_ID="$topic_id" \
      go run ./cmd/b3-harness drain --benchmark="$benchmark_id")
    sleep 10
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness audit \
      --benchmark="$benchmark_id" --expected-incoming=1) >"$destination/admission-$fault.audit.json"
  done
  for fault in ambiguous_after_confirmation after_confirmation_before_progress; do
    benchmark_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness prepare \
      --benchmark="$benchmark_id" --lane="hard-crash/relay/$fault" --expected-incoming=1)
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness admit \
      --benchmark="$benchmark_id" --ordinal=0 --attempt=1 --fault=none) >/dev/null
    set +e
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) GCP_PROJECT_ID="$project_id" PUBSUB_TOPIC_ID="$topic_id" \
      go run ./cmd/b3-harness relay-once --benchmark="$benchmark_id" --fault="$fault" --hard-crash) \
      >"$destination/relay-$fault.stdout" 2>"$destination/relay-$fault.stderr"
    local exit_code=$?
    set -e
    printf '%s\n' "$exit_code" >"$destination/relay-$fault.exit-code"
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) GCP_PROJECT_ID="$project_id" PUBSUB_TOPIC_ID="$topic_id" \
      go run ./cmd/b3-harness drain --benchmark="$benchmark_id")
    sleep 10
    (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness audit \
      --benchmark="$benchmark_id" --expected-incoming=1) >"$destination/relay-$fault.audit.json"
  done
  seal_directory "$destination"
}

authentication_smoke() {
  load_state
  local destination="$evidence_root/authentication-smoke"
  mkdir -p "$destination"
  ingress_url=$(gcloud run services describe "$ingress_service" --region="$region" --format='value(status.url)')
  curl -sS -o "$destination/missing-token.body" -w '%{http_code}\n' \
    -X POST "$ingress_url/v1/admissions" -H 'content-type: application/json' -d '{}' \
    >"$destination/missing-token.status"
  curl -sS -o "$destination/wrong-token.body" -w '%{http_code}\n' \
    -X POST "$ingress_url/v1/admissions" -H 'authorization: Bearer invalid' \
    -H 'content-type: application/json' -d '{}' >"$destination/wrong-token.status"
  local identity_token
  identity_token=$(gcloud auth print-identity-token)
  curl -sS -o "$destination/malformed.body" -w '%{http_code}\n' \
    -X POST "$ingress_url/v1/admissions" -H "authorization: Bearer $identity_token" \
    -H 'content-type: application/json' -d '{' >"$destination/malformed.status"
  seal_directory "$destination"
}

load_lane() {
  load_state
  local lane=$1
  local rate=$2
  local duration=$3
  local repetition=${4:-1}
  local end_rate=${5:-$rate}
  local benchmark_id
  benchmark_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  local count
  count=$(python3 -c 'import sys; print(int((float(sys.argv[1])+float(sys.argv[2]))/2*float(sys.argv[3])))' "$rate" "$end_rate" "$duration")
  local destination="$evidence_root/load/$lane-$repetition"
  mkdir -p "$destination"
  if ! gcloud run services describe "$relay_service" --region="$region" >/dev/null 2>&1; then
    deploy_relay
  fi
  reset_subscription
  start_proxy
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness prepare \
    --benchmark="$benchmark_id" --lane="$lane-$repetition" --expected-incoming="$count")
  capture_frozen_topology "$destination/topology"
  ingress_url=$(gcloud run services describe "$ingress_service" --region="$region" --format='value(status.url)')
  local identity_token
  identity_token=$(gcloud auth print-identity-token)
  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (cd "$prototype_dir" && GCP_IDENTITY_TOKEN="$identity_token" go run ./cmd/b3-load \
    --url="$ingress_url" --benchmark="$benchmark_id" --rate="$rate" --end-rate="$end_rate" \
    --duration="${duration}s" --count="$count" \
    >"$destination/caller-samples.jsonl" 2>"$destination/load-client.log")
  local offer_ended_at
  offer_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sleep 60
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness audit \
    --benchmark="$benchmark_id" --expected-incoming="$count") >"$destination/audit.json"
  local ended_at
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg benchmark_id "$benchmark_id" --arg lane "$lane" --arg started_at "$started_at" \
    --arg offer_ended_at "$offer_ended_at" --arg ended_at "$ended_at" \
    --argjson rate "$rate" --argjson end_rate "$end_rate" --argjson duration "$duration" \
    --argjson count "$count" --argjson repetition "$repetition" --argjson sequence_stripes "$sequence_stripes" \
    '{manifest:"pubsub-handoff-v1",benchmark_id:$benchmark_id,lane:$lane,repetition:$repetition,handoff:"transactional-outbox",sequence_stripes:$sequence_stripes,relay_owners:4,rate_per_second:$rate,end_rate_per_second:$end_rate,duration_seconds:$duration,count:$count,started_at:$started_at,offer_ended_at:$offer_ended_at,ended_at:$ended_at}' \
    >"$destination/scenario.json"
  capture_logs "$destination/runtime-logs.json" "$started_at"
  collect_monitoring "$destination" "$started_at" "$ended_at"
  gzip -9 "$destination/caller-samples.jsonl" "$destination/runtime-logs.json"
  seal_directory "$destination"
}

load_manifest() {
  load_lane baseline-23 23 600 1
  for repetition in 1 2 3; do
    load_lane target-232 232 1800 "$repetition"
  done
  for repetition in 1 2 3; do
    load_lane stress-464 464 900 "$repetition"
  done
  load_lane linear-ramp 23 900 1 464
}

finalize_interrupted_lane() {
  load_state
  local destination=$1
  local benchmark_id=$2
  local expected=$3
  local rate=$4
  local duration=$5
  local lane=$6
  start_proxy
  local started_at offer_ended_at ended_at
  started_at=$(jq -rs 'map(.offered_at) | min' "$destination/caller-samples.jsonl")
  offer_ended_at=$(jq -rs 'map(.completed_at) | max' "$destination/caller-samples.jsonl")
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness audit \
    --benchmark="$benchmark_id" --expected-incoming="$expected") >"$destination/audit.json"
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg benchmark_id "$benchmark_id" --arg lane "$lane" --arg started_at "$started_at" \
    --arg offer_ended_at "$offer_ended_at" --arg ended_at "$ended_at" \
    --argjson rate "$rate" --argjson duration "$duration" --argjson count "$expected" \
    '{manifest:"pubsub-handoff-v1",benchmark_id:$benchmark_id,lane:$lane,repetition:1,handoff:"transactional-outbox",rate_per_second:$rate,end_rate_per_second:$rate,duration_seconds:$duration,count:$count,started_at:$started_at,offer_ended_at:$offer_ended_at,ended_at:$ended_at,audit_recovered_after_controller_interrupt:true}' \
    >"$destination/scenario.json"
  capture_logs "$destination/runtime-logs.json" "$started_at"
  collect_monitoring "$destination" "$started_at" "$ended_at"
  gzip -9 "$destination/caller-samples.jsonl" "$destination/runtime-logs.json"
  seal_directory "$destination"
}

scale_from_zero() {
  load_state
  gcloud run services update "$worker_service" --region="$region" --min=0 --max=8 >/dev/null
  gcloud run services update "$ingress_service" --region="$region" --min=0 --max=8 >/dev/null
  sleep 1800
  load_lane idle-to-burst-232 232 15 1
}

capture_logs() {
  local destination=$1
  local started_at=$2
  gcloud logging read "timestamp>=\"$started_at\" AND (resource.labels.service_name=\"$worker_service\" OR resource.labels.service_name=\"$ingress_service\" OR resource.labels.service_name=\"$relay_service\")" \
    --format=json --limit=100000 >"$destination"
}

monitoring_query() {
  local destination=$1
  local filter=$2
  local start_time=$3
  local end_time=$4
  local access_token
  access_token=$(gcloud auth print-access-token)
  printf 'header = "Authorization: Bearer %s"\n' "$access_token" | curl --config - -fsS -G \
    --data-urlencode "filter=$filter" --data-urlencode "interval.startTime=$start_time" \
    --data-urlencode "interval.endTime=$end_time" --data-urlencode "pageSize=100000" \
    "https://monitoring.googleapis.com/v3/projects/$project_id/timeSeries" >"$destination"
}

collect_monitoring() {
  local destination=$1
  local start_time=$2
  local end_time=$3
  mkdir -p "$destination/monitoring"
  local metric service safe_name
  for service in "$worker_service" "$ingress_service" "$relay_service"; do
    for metric in \
      run.googleapis.com/container/instance_count \
      run.googleapis.com/container/cpu/utilizations \
      run.googleapis.com/container/memory/utilizations \
      run.googleapis.com/container/billable_instance_time \
      run.googleapis.com/request_count \
      run.googleapis.com/request_latencies; do
      safe_name=${service}__${metric//\//__}
      monitoring_query "$destination/monitoring/$safe_name.json" \
        "metric.type=\"$metric\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$service\"" \
        "$start_time" "$end_time"
    done
  done
  for metric in \
    pubsub.googleapis.com/subscription/num_undelivered_messages \
    pubsub.googleapis.com/subscription/oldest_unacked_message_age \
    pubsub.googleapis.com/subscription/expired_ack_deadlines_count \
    pubsub.googleapis.com/subscription/ack_latencies \
    pubsub.googleapis.com/subscription/push_request_count \
    pubsub.googleapis.com/subscription/push_request_latencies; do
    safe_name=${metric//\//__}
    monitoring_query "$destination/monitoring/$safe_name.json" \
      "metric.type=\"$metric\" AND resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"$subscription_id\"" \
      "$start_time" "$end_time"
  done
  for metric in \
    cloudsql.googleapis.com/database/cpu/utilization \
    cloudsql.googleapis.com/database/memory/utilization \
    cloudsql.googleapis.com/database/postgresql/num_backends \
    cloudsql.googleapis.com/database/disk/write_ops_count \
    cloudsql.googleapis.com/database/disk/read_ops_count; do
    safe_name=${metric//\//__}
    monitoring_query "$destination/monitoring/$safe_name.json" \
      "metric.type=\"$metric\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"$project_id:$sql_instance\"" \
      "$start_time" "$end_time"
  done
}

capture_inventory() {
  local destination=$1
  jq -n \
    --argjson services "$(gcloud run services list --region="$region" --filter="metadata.name~^$prefix" --format=json)" \
    --argjson sql "$(gcloud sql instances list --filter="name~^$prefix" --format=json)" \
    --argjson topics "$(gcloud pubsub topics list --filter="name~$prefix" --format=json)" \
    --argjson subscriptions "$(gcloud pubsub subscriptions list --filter="name~$prefix" --format=json)" \
    --argjson repositories "$(gcloud artifacts repositories list --location="$region" --filter="name~$prefix" --format=json)" \
    --argjson secrets "$(gcloud secrets list --filter="name~$prefix" --format=json)" \
    --argjson service_accounts "$(gcloud iam service-accounts list --filter="email~$prefix" --format=json)" \
    '{services:$services,sql:$sql,topics:$topics,subscriptions:$subscriptions,repositories:$repositories,secrets:$secrets,service_accounts:$service_accounts}' >"$destination"
}

seal_directory() {
  local destination=$1
  local checksum_file
  checksum_file=$(mktemp)
  (cd "$destination" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum) >"$checksum_file"
  mv "$checksum_file" "$destination/SHA256SUMS"
  (cd "$destination" && sha256sum --check SHA256SUMS >/dev/null)
}

seal_root() {
  local checksum_file
  checksum_file=$(mktemp)
  (
    cd "$evidence_root"
    find . -type f \
      ! -name SEALED-SHA256SUMS \
      ! -name cloud-sql-proxy.log \
      -print0 | sort -z | xargs -0 sha256sum
  ) >"$checksum_file"
  mv "$checksum_file" "$evidence_root/SEALED-SHA256SUMS"
  (cd "$evidence_root" && sha256sum --check SEALED-SHA256SUMS >/dev/null)
}

teardown() {
  set +e
  gcloud run services delete "$ingress_service" --region="$region" --quiet
  gcloud run services delete "$relay_service" --region="$region" --quiet
  gcloud run services delete "$worker_service" --region="$region" --quiet
  gcloud pubsub subscriptions delete "$subscription_id" --quiet
  gcloud pubsub topics delete "$topic_id" --quiet
  gcloud secrets delete "$database_secret" --quiet
  gcloud sql instances delete "$sql_instance" --quiet
  gcloud artifacts repositories delete "$artifact_repository" --location="$region" --quiet
  gcloud iam service-accounts delete "$worker_service_account" --quiet
  gcloud iam service-accounts delete "$ingress_service_account" --quiet
  gcloud iam service-accounts delete "$relay_service_account" --quiet
  gcloud iam service-accounts delete "$push_auth_service_account" --quiet
  set -e
  mkdir -p "$evidence_root"
  capture_inventory "$evidence_root/teardown-inventory.json"
  jq '{manifest_owned_cloud_residue: ([.services,.sql,.topics,.subscriptions,.repositories,.secrets,.service_accounts] | map(length) | add), inventory:.}' \
    "$evidence_root/teardown-inventory.json" >"$evidence_root/teardown-verification.json"
  rm -f "$state_file"
}

run_decision_evidence() {
  provision
  authentication_smoke
  hard_crash_smoke
  run_cut_matrix
  deploy_relay
  load_lane baseline-smoke-23 23 60 1
  load_lane target-smoke-232 232 60 1
  load_lane stress-smoke-464 464 60 1
  start_proxy
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness retention-plan) \
    >"$evidence_root/retention-plan.json"
  capture_inventory "$evidence_root/final-inventory.json"
}

usage() {
  echo "Usage: ./b3-run.sh provision|deploy|relay|auth-smoke|hard-crash-smoke|cut-matrix|load <lane> <rate> <seconds> [repetition] [end-rate]|finalize <directory> <benchmark> <expected> <rate> <seconds> <lane>|load-manifest|scale-zero|inventory|seal|teardown|decision"
}

command=${1:-}
case "$command" in
  provision) provision ;;
  deploy) deploy_images ;;
  relay) deploy_relay ;;
  auth-smoke) authentication_smoke ;;
  hard-crash-smoke) hard_crash_smoke ;;
  cut-matrix) run_cut_matrix ;;
  load) load_state; shift; load_lane "$@" ;;
  finalize) load_state; shift; finalize_interrupted_lane "$@" ;;
  load-manifest) load_state; load_manifest ;;
  scale-zero) load_state; scale_from_zero ;;
  inventory) capture_inventory "$evidence_root/final-inventory.json" ;;
  seal) seal_root ;;
  teardown) teardown ;;
  decision) run_decision_evidence ;;
  *) usage; exit 2 ;;
esac

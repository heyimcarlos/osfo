#!/usr/bin/env bash
set -euo pipefail

prototype_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
experiment=${B3_EXPERIMENT:-transactional-outbox}
manifest_version=${B3_MANIFEST_VERSION:-pubsub-handoff-v2}
sequence_stripes=${B3_SEQUENCE_STRIPES:-4}
inflight_agent_runs=${B3_INFLIGHT_AGENT_RUNS:-1024}
inflight_budget_stripes=${B3_INFLIGHT_BUDGET_STRIPES:-16}
worker_concurrency=${B3_WORKER_CONCURRENCY:-32}
worker_slots=${B3_WORKER_SLOTS:-$worker_concurrency}
worker_db_pool=${B3_WORKER_DB_POOL:-4}
worker_min_instances=${B3_WORKER_MIN_INSTANCES:-0}
enable_ordering=${B3_ENABLE_ORDERING:-1}
ingress_admission_slots=${B3_INGRESS_ADMISSION_SLOTS:-0}
ingress_concurrency=${B3_INGRESS_CONCURRENCY:-80}
ingress_min_instances=${B3_INGRESS_MIN_INSTANCES:-0}
capture_attempt_evidence=${B3_CAPTURE_ATTEMPT_EVIDENCE:-1}
ack_deadline=${B3_ACK_DEADLINE:-10}
reset_subscription_before_lane=${B3_RESET_SUBSCRIPTION:-1}
case "$sequence_stripes" in
  4|16|64) ;;
  *) echo "B3_SEQUENCE_STRIPES must be 4, 16, or 64" >&2; exit 2 ;;
esac
for setting in inflight_agent_runs inflight_budget_stripes worker_concurrency worker_slots worker_db_pool ingress_concurrency ack_deadline; do
  value=${!setting}
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$setting must be a positive integer" >&2
    exit 2
  fi
done
if (( inflight_budget_stripes > 64 || inflight_budget_stripes > inflight_agent_runs )); then
  echo "B3_INFLIGHT_BUDGET_STRIPES must be at most 64 and no greater than B3_INFLIGHT_AGENT_RUNS" >&2
  exit 2
fi
export B3_INFLIGHT_AGENT_RUNS="$inflight_agent_runs"
export B3_INFLIGHT_BUDGET_STRIPES="$inflight_budget_stripes"
if [[ ! "$ingress_admission_slots" =~ ^[0-9]+$ ]]; then
  echo "B3_INGRESS_ADMISSION_SLOTS must be a non-negative integer" >&2
  exit 2
fi
if (( ingress_admission_slots > 0 && ingress_admission_slots >= ingress_concurrency )); then
  echo "B3_INGRESS_ADMISSION_SLOTS must be lower than B3_INGRESS_CONCURRENCY" >&2
  exit 2
fi
if [[ ! "$worker_min_instances" =~ ^[0-9]+$ ]] || (( worker_min_instances > 8 )); then
  echo "B3_WORKER_MIN_INSTANCES must be an integer from 0 through 8" >&2
  exit 2
fi
if [[ ! "$ingress_min_instances" =~ ^[0-9]+$ ]] || (( ingress_min_instances > 8 )); then
  echo "B3_INGRESS_MIN_INSTANCES must be an integer from 0 through 8" >&2
  exit 2
fi
case "$reset_subscription_before_lane" in
  0|1) ;;
  *) echo "B3_RESET_SUBSCRIPTION must be 0 or 1" >&2; exit 2 ;;
esac
case "$enable_ordering" in
  0|1) ;;
  *) echo "B3_ENABLE_ORDERING must be 0 or 1" >&2; exit 2 ;;
esac
case "$capture_attempt_evidence" in
  0|1) ;;
  *) echo "B3_CAPTURE_ATTEMPT_EVIDENCE must be 0 or 1" >&2; exit 2 ;;
esac
if [[ "$experiment" == "transactional-outbox" ]]; then
  state_file="$prototype_dir/.b3-run.env"
  default_prefix=osfo-b3-38
else
  state_file="$prototype_dir/.b3-$experiment.env"
  case "$experiment" in
    stripes-*) default_prefix="osfo-b3-38-${experiment/stripes-/s}" ;;
    flow-control-*) default_prefix="osfo-b3-38-${experiment/flow-control-/fc}" ;;
    warm-workers-*) default_prefix="osfo-b3-38-${experiment/warm-workers-/ww}" ;;
    qualification-push) default_prefix="osfo-b3-38-qp" ;;
    qualification-buffer-80) default_prefix="osfo-b3-38-qb80" ;;
    qualification-ingress-min2) default_prefix="osfo-b3-38-qim2" ;;
    qualification-authority-only) default_prefix="osfo-b3-38-qao" ;;
    qualification-runtime-budget) default_prefix="osfo-b3-38-qrb" ;;
    *) default_prefix="osfo-b3-38-$experiment" ;;
  esac
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
  local attempt
  for attempt in {1..12}; do
    if gcloud projects add-iam-policy-binding "$project_id" \
      --member="serviceAccount:$member" --role="$role" --condition=None --quiet >/dev/null; then
      return
    fi
    if [[ "$attempt" == "12" ]]; then
      return 1
    fi
    echo "IAM binding for $member is not visible yet, retrying" >&2
    sleep 2
  done
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

  start_proxy
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness migrate)

  gcloud builds submit "$prototype_dir" --tag="$image_uri" --project="$project_id"

  gcloud pubsub topics describe "$topic_id" >/dev/null 2>&1 || gcloud pubsub topics create "$topic_id"
  gcloud run deploy "$worker_service" --image="$image_uri" --region="$region" --project="$project_id" \
    --service-account="$worker_service_account" --no-allow-unauthenticated --cpu=1 --memory=1Gi \
    --concurrency="$worker_concurrency" --min="$worker_min_instances" --max=8 --cpu-throttling --timeout=600 \
    --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="ROLE=push,DB_POOL_SIZE=$worker_db_pool,WORKER_SLOTS=$worker_slots,CLAIM_LEASE_SECONDS=15"
  gcloud run services add-iam-policy-binding "$worker_service" --region="$region" \
    --member="serviceAccount:$push_auth_service_account" --role=roles/run.invoker --condition=None --quiet >/dev/null
  worker_url=$(gcloud run services describe "$worker_service" --region="$region" --format='value(status.url)')
  if ! gcloud pubsub subscriptions describe "$subscription_id" >/dev/null 2>&1; then
    create_subscription "$worker_url"
  fi

  gcloud run deploy "$ingress_service" --image="$image_uri" --command=/b3-ingress \
    --region="$region" --project="$project_id" --service-account="$ingress_service_account" \
    --no-allow-unauthenticated --cpu=1 --memory=1Gi --concurrency="$ingress_concurrency" \
    --min="$ingress_min_instances" --max=8 \
    --cpu-throttling --timeout=60 --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="DB_POOL_SIZE=8,B3_SEQUENCE_STRIPES=$sequence_stripes,B3_INFLIGHT_AGENT_RUNS=$inflight_agent_runs,B3_INFLIGHT_BUDGET_STRIPES=$inflight_budget_stripes,ADMISSION_SLOTS=$ingress_admission_slots,CAPTURE_ATTEMPT_EVIDENCE=$capture_attempt_evidence"
  ingress_url=$(gcloud run services describe "$ingress_service" --region="$region" --format='value(status.url)')
  active_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)
  gcloud run services add-iam-policy-binding "$ingress_service" --region="$region" \
    --member="user:$active_account" --role=roles/run.invoker --condition=None --quiet >/dev/null

  capture_inventory "$evidence_root/provisioned-inventory.json"
  capture_frozen_topology "$evidence_root/frozen-topology"
}

deploy_images() {
  load_state
  gcloud builds submit "$prototype_dir" --tag="$image_uri" --project="$project_id"
  gcloud run deploy "$worker_service" --image="$image_uri" --region="$region" --project="$project_id" \
    --service-account="$worker_service_account" --no-allow-unauthenticated --cpu=1 --memory=1Gi \
    --concurrency="$worker_concurrency" --min="$worker_min_instances" --max=8 --cpu-throttling --timeout=600 \
    --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="ROLE=push,DB_POOL_SIZE=$worker_db_pool,WORKER_SLOTS=$worker_slots,CLAIM_LEASE_SECONDS=15"
  gcloud run deploy "$ingress_service" --image="$image_uri" --command=/b3-ingress \
    --region="$region" --project="$project_id" --service-account="$ingress_service_account" \
    --no-allow-unauthenticated --cpu=1 --memory=1Gi --concurrency="$ingress_concurrency" \
    --min="$ingress_min_instances" --max=8 \
    --cpu-throttling --timeout=60 --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="DB_POOL_SIZE=8,B3_SEQUENCE_STRIPES=$sequence_stripes,B3_INFLIGHT_AGENT_RUNS=$inflight_agent_runs,B3_INFLIGHT_BUDGET_STRIPES=$inflight_budget_stripes,ADMISSION_SLOTS=$ingress_admission_slots,CAPTURE_ATTEMPT_EVIDENCE=$capture_attempt_evidence"
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
  create_subscription "$worker_url" >/dev/null
}

create_subscription() {
  local worker_url=$1
  local ordering_args=()
  if [[ "$enable_ordering" == "1" ]]; then
    ordering_args+=(--enable-message-ordering)
  fi
  gcloud pubsub subscriptions create "$subscription_id" --topic="$topic_id" --ack-deadline="$ack_deadline" \
    --message-retention-duration=7d --min-retry-delay=10s --max-retry-delay=600s \
    "${ordering_args[@]}" --push-endpoint="$worker_url/v1/pubsub/push" \
    --push-auth-service-account="$push_auth_service_account" \
    --push-auth-token-audience="$worker_url"
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
  git -C "$prototype_dir" status --short --untracked-files=all -- . \
    ':(exclude)evidence' ':(exclude).b3-*.env' >"$destination/source-status.txt"
  (
    cd "$prototype_dir"
    find . -type f \
      \( -name '*.go' -o -name '*.sql' -o -name '*.sh' -o -name 'Dockerfile' -o -name 'go.mod' -o -name 'go.sum' \) \
      ! -path './evidence/*' -print0 | sort -z | xargs -0 sha256sum
  ) >"$destination/source-tree-sha256.txt"
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
  jq -n --arg manifest "$manifest_version" --arg started_at "$started_at" --arg ended_at "$ended_at" \
    '{manifest:$manifest,lane:"deterministic-cut-matrix",started_at:$started_at,ended_at:$ended_at,repetitions_per_cut:100,seeds:3}' \
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

worker_crash_smoke() {
  load_state
  reset_subscription
  start_proxy
  local destination="$evidence_root/worker-process-loss"
  if [[ -e "$destination" ]]; then
    echo "Refusing to overwrite existing worker process-loss evidence: $destination" >&2
    return 1
  fi
  mkdir -p "$destination"
  local benchmark_id
  benchmark_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness prepare \
    --benchmark="$benchmark_id" --lane="worker-process-loss/after-claim" --expected-incoming=1)
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness admit \
    --benchmark="$benchmark_id" --ordinal=0 --attempt=1 --fault=none) >"$destination/admission.json"
  local agent_run_id
  agent_run_id=$(jq -er '.receipt.agent_run_ids[0]' "$destination/admission.json")
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness inject-worker-crash \
    --benchmark="$benchmark_id" --agent-run="$agent_run_id")
  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) \
    GCP_PROJECT_ID="$project_id" PUBSUB_TOPIC_ID="$topic_id" \
    go run ./cmd/b3-harness drain --benchmark="$benchmark_id")
  local ended_at
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness audit \
    --benchmark="$benchmark_id" --expected-incoming=1) >"$destination/audit.json"
  jq -e '
    .verdict == "PASS" and
    .accepted_incoming == 1 and
    .authoritative_agent_runs == 1 and
    .succeeded_agent_runs == 1 and
    .agent_run_attempts >= 2 and
    .unfinished_agent_run_attempts == 0 and
    .model_calls == 1 and
    .model_call_attempts == 1 and
    .inflight_agent_run_budget_used == 0 and
    .inflight_agent_run_budget_mismatch == 0
  ' "$destination/audit.json" >/dev/null
  jq -n --arg benchmark_id "$benchmark_id" --arg agent_run_id "$agent_run_id" \
    --arg started_at "$started_at" --arg ended_at "$ended_at" \
    '{lane:"worker-process-loss-after-claim",benchmark_id:$benchmark_id,agent_run_id:$agent_run_id,started_at:$started_at,ended_at:$ended_at}' \
    >"$destination/scenario.json"
  capture_logs "$destination/runtime-logs.json" "$started_at"
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

summarize_caller_samples() {
  local source=$1
  local destination=$2
  jq -s '
    ([.[].latency_ms] | sort) as $latencies |
    {
      count: length,
      outcomes: (group_by(.caller_outcome) | map({outcome: .[0].caller_outcome, count: length})),
      latency_ms: {
        count: ($latencies | length),
        p50: $latencies[((($latencies | length) - 1) * 0.50 | floor)],
        p90: $latencies[((($latencies | length) - 1) * 0.90 | floor)],
        p95: $latencies[((($latencies | length) - 1) * 0.95 | floor)],
        p99: $latencies[((($latencies | length) - 1) * 0.99 | floor)],
        max: ($latencies | max)
      }
    }
  ' "$source" >"$destination"
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
  if [[ -e "$destination" ]]; then
    echo "Refusing to overwrite existing lane evidence: $destination" >&2
    return 1
  fi
  mkdir -p "$destination"
  if ! gcloud run services describe "$relay_service" --region="$region" >/dev/null 2>&1; then
    deploy_relay
  fi
  if [[ "$reset_subscription_before_lane" == "1" ]]; then
    reset_subscription
  fi
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
  summarize_caller_samples "$destination/caller-samples.jsonl" "$destination/caller-summary.json"
  local offer_ended_at
  offer_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sleep 60
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/b3-harness audit \
    --benchmark="$benchmark_id" --expected-incoming="$count") >"$destination/audit.json"
  local ended_at
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg manifest "$manifest_version" --arg benchmark_id "$benchmark_id" --arg lane "$lane" --arg started_at "$started_at" \
    --arg offer_ended_at "$offer_ended_at" --arg ended_at "$ended_at" \
    --argjson rate "$rate" --argjson end_rate "$end_rate" --argjson duration "$duration" \
    --argjson count "$count" --argjson repetition "$repetition" --argjson sequence_stripes "$sequence_stripes" \
    --argjson worker_concurrency "$worker_concurrency" --argjson worker_slots "$worker_slots" \
    --argjson worker_db_pool "$worker_db_pool" --argjson worker_min_instances "$worker_min_instances" \
    --argjson inflight_agent_runs "$inflight_agent_runs" --argjson inflight_budget_stripes "$inflight_budget_stripes" \
    --argjson enable_ordering "$enable_ordering" --argjson ingress_admission_slots "$ingress_admission_slots" \
    --argjson ingress_concurrency "$ingress_concurrency" --argjson ingress_min_instances "$ingress_min_instances" \
    --argjson capture_attempt_evidence "$capture_attempt_evidence" \
    --argjson ack_deadline "$ack_deadline" \
    --argjson subscription_reset_before_lane "$reset_subscription_before_lane" \
    '{manifest:$manifest,benchmark_id:$benchmark_id,lane:$lane,repetition:$repetition,handoff:"transactional-outbox",sequence_stripes:$sequence_stripes,relay_owners:4,inflight_agent_run_capacity:$inflight_agent_runs,inflight_budget_stripes:$inflight_budget_stripes,ingress_admission_slots:$ingress_admission_slots,ingress_concurrency:$ingress_concurrency,ingress_min_instances:$ingress_min_instances,capture_attempt_evidence:($capture_attempt_evidence == 1),worker_concurrency:$worker_concurrency,worker_slots:$worker_slots,worker_db_pool:$worker_db_pool,worker_min_instances:$worker_min_instances,subscription_ordering_enabled:($enable_ordering == 1),ack_deadline_seconds:$ack_deadline,subscription_reset_before_lane:($subscription_reset_before_lane == 1),rate_per_second:$rate,end_rate_per_second:$end_rate,duration_seconds:$duration,count:$count,started_at:$started_at,offer_ended_at:$offer_ended_at,ended_at:$ended_at}' \
    >"$destination/scenario.json"
  capture_logs "$destination/runtime-logs.json" "$started_at"
  collect_monitoring "$destination" "$started_at" "$ended_at"
  gzip -9 "$destination/caller-samples.jsonl" "$destination/runtime-logs.json"
  seal_directory "$destination"
}

load_manifest() {
	local configured_reset=$reset_subscription_before_lane
	reset_subscription_before_lane=1
	load_lane manifest-warmup-23 23 10 1
	reset_subscription_before_lane=0
	load_lane baseline-23 23 600 1
  for repetition in 1 2 3; do
    load_lane target-232 232 1800 "$repetition"
  done
  for repetition in 1 2 3; do
    load_lane stress-464 464 900 "$repetition"
	done
	load_lane linear-ramp 23 900 1 464
	reset_subscription_before_lane=$configured_reset
}

check_qualification_lane() {
  local destination=$1
  local mode=$2
  local p99_limit=1000
  if [[ "$mode" == "stress" ]]; then
    p99_limit=2000
  fi
  if ! jq -e --arg mode "$mode" --argjson p99_limit "$p99_limit" '
    .accepted_incoming > 0 and
    ($mode != "target" or .accepted_incoming == .expected_incoming) and
    .authoritative_agent_runs == .succeeded_agent_runs and
    .authoritative_agent_runs == .outbox_records and
    .confirmed_publications >= .outbox_records and
    .nonterminal_agent_runs == 0 and
    .unpublished_outbox_records == 0 and
    .stranded_accepted_runs == 0 and
    .ghost_delivery_attempts == 0 and
    .duplicate_terminal_commits == 0 and
    .unknown_caller_outcomes == 0 and
    .good_root_outcomes == .accepted_incoming and
    .good_root_outcome_ratio == 1 and
    .distinct_execution_profiles == 1 and
    .model_calls == .authoritative_agent_runs and
    .model_call_attempts >= .model_calls and
    .unfinished_agent_run_attempts == 0 and
    .unfinished_model_call_attempts == 0 and
    .inflight_agent_run_budget_used == 0 and
    .inflight_agent_run_budget_mismatch == 0 and
    ($mode == "diagnostic" or
      ($mode == "target" and
        (.publish_to_point_claim_ms.p95 // 1e99) <= 250 and
        (.publish_to_point_claim_ms.p99 // 1e99) <= $p99_limit) or
      ($mode == "stress" and
        (.publish_to_point_claim_ms.p99 // 1e99) <= $p99_limit))
  ' "$destination/audit.json" >/dev/null; then
    echo "$destination failed the $mode audit gate" >&2
    return 1
  fi

  local invalid_samples
  if [[ "$mode" == "target" ]]; then
    invalid_samples=$(gzip -cd "$destination/caller-samples.jsonl.gz" |
      jq -c 'select(.caller_outcome != "accepted")' | wc -l)
  else
    invalid_samples=$(gzip -cd "$destination/caller-samples.jsonl.gz" |
      jq -c 'select((.caller_outcome == "accepted" or (.caller_outcome == "rejected" and .error_class == "overloaded" and .retry_after_ms > 0)) | not)' |
      wc -l)
  fi
  if [[ "$invalid_samples" != "0" ]]; then
    echo "$destination has $invalid_samples invalid caller outcomes" >&2
    return 1
  fi
  if [[ "$mode" == "stress" ]] && ! jq -e --slurpfile scenario "$destination/scenario.json" '
    (.accepted_incoming / $scenario[0].duration_seconds) >= 232
  ' "$destination/audit.json" >/dev/null; then
    echo "$destination did not preserve 232 incoming messages/s of accepted Goodput" >&2
    return 1
  fi
  if [[ "$mode" == "target" ]]; then
    if [[ -f "$destination/caller-summary.json" ]]; then
      if ! jq -e '.latency_ms.p95 <= 250 and .latency_ms.p99 <= 500' \
        "$destination/caller-summary.json" >/dev/null; then
        echo "$destination failed the target caller latency gate" >&2
        return 1
      fi
    elif ! jq -e '.caller_to_receipt_ms.p95 <= 250 and .caller_to_receipt_ms.p99 <= 500' \
      "$destination/audit.json" >/dev/null; then
      echo "$destination failed the target receipt latency gate" >&2
      return 1
    fi
  fi
}

run_or_resume_checked_lane() {
  local lane=$1
  local rate=$2
  local duration=$3
  local repetition=$4
  local mode=$5
  local end_rate=${6:-$rate}
  local destination="$evidence_root/load/$lane-$repetition"
  if [[ -f "$destination/SHA256SUMS" ]]; then
    (cd "$destination" && sha256sum --check SHA256SUMS >/dev/null)
    check_qualification_lane "$destination" "$mode" || return $?
    echo "Reusing sealed passing lane: $destination"
    return
  fi
  if [[ -e "$destination" ]]; then
    echo "Unsealed lane requires explicit recovery before resume: $destination" >&2
    return 1
  fi
  load_lane "$lane" "$rate" "$duration" "$repetition" "$end_rate" || return $?
  check_qualification_lane "$destination" "$mode"
}

run_target_control_study() {
  local lane_prefix=$1
  local configured_reset=$reset_subscription_before_lane
  reset_subscription_before_lane=1
  run_or_resume_checked_lane "$lane_prefix-warmup-23" 23 10 1 diagnostic || {
    local status=$?
    reset_subscription_before_lane=$configured_reset
    return "$status"
  }
  reset_subscription_before_lane=0
  run_or_resume_checked_lane "$lane_prefix-prelude-232" 232 60 1 stress || {
    local status=$?
    reset_subscription_before_lane=$configured_reset
    return "$status"
  }
  run_or_resume_checked_lane "$lane_prefix-target-232" 232 600 1 target || {
    local status=$?
    reset_subscription_before_lane=$configured_reset
    return "$status"
  }
  reset_subscription_before_lane=$configured_reset
}

write_controller_status() {
  local workflow=$1
  local controller_state=$2
  local exit_code=$3
  local destination="$evidence_root/controller-status.json"
  local status_tmp
  status_tmp=$(mktemp)
  jq -n --arg workflow "$workflow" --arg state "$controller_state" \
    --arg experiment "$experiment" --arg manifest "$manifest_version" \
    --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson pid "$$" --argjson exit_code "$exit_code" \
    '{workflow:$workflow,state:$state,experiment:$experiment,manifest:$manifest,pid:$pid,exit_code:$exit_code,updated_at:$updated_at}' \
    >"$status_tmp"
  mkdir -p "$evidence_root"
  mv "$status_tmp" "$destination"
}

run_controller() {
  local workflow=$1
  write_controller_status "$workflow" running 0
  trap 'write_controller_status "$workflow" interrupted 130; exit 130' INT TERM HUP
  local controller_exit=0
  case "$workflow" in
    target-buffer-study)
      if run_target_control_study buffer; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-ingress-min-study)
      if run_target_control_study ingress-min; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-authority-study)
      if run_target_control_study authority; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-runtime-budget-study)
      if run_target_control_study runtime-budget; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-runtime-budget-nolocal-study)
      if run_target_control_study runtime-budget-nolocal; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-runtime-budget-s64-study)
      if run_target_control_study runtime-budget-s64; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-runtime-budget-s64-independent-study)
      if run_target_control_study runtime-budget-s64-independent; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    target-runtime-budget-s64-terminal-study)
      if run_target_control_study runtime-budget-s64-terminal; then
        controller_exit=0
      else
        controller_exit=$?
      fi
      ;;
    *)
      echo "Unknown controller workflow: $workflow" >&2
      controller_exit=2
      ;;
  esac
  if [[ "$controller_exit" == "0" ]]; then
    write_controller_status "$workflow" completed 0
  else
    write_controller_status "$workflow" failed "$controller_exit"
  fi
  return "$controller_exit"
}

start_controller() {
  load_state
  local workflow=$1
  local unit_name="$prefix-${workflow//[^a-zA-Z0-9]/-}"
  systemd-run --user --unit="$unit_name" --collect \
    --working-directory="$prototype_dir" --setenv="PATH=$PATH" \
    --setenv="B3_EXPERIMENT=$experiment" --setenv="B3_MANIFEST_VERSION=$manifest_version" \
    --setenv="B3_SEQUENCE_STRIPES=$sequence_stripes" --setenv="B3_WORKER_CONCURRENCY=$worker_concurrency" \
    --setenv="B3_INFLIGHT_AGENT_RUNS=$inflight_agent_runs" --setenv="B3_INFLIGHT_BUDGET_STRIPES=$inflight_budget_stripes" \
    --setenv="B3_WORKER_SLOTS=$worker_slots" --setenv="B3_WORKER_DB_POOL=$worker_db_pool" \
    --setenv="B3_WORKER_MIN_INSTANCES=$worker_min_instances" --setenv="B3_ENABLE_ORDERING=$enable_ordering" \
    --setenv="B3_INGRESS_ADMISSION_SLOTS=$ingress_admission_slots" \
    --setenv="B3_INGRESS_CONCURRENCY=$ingress_concurrency" \
    --setenv="B3_INGRESS_MIN_INSTANCES=$ingress_min_instances" --setenv="B3_ACK_DEADLINE=$ack_deadline" \
    --setenv="B3_CAPTURE_ATTEMPT_EVIDENCE=$capture_attempt_evidence" \
    /usr/bin/bash "$prototype_dir/b3-run.sh" controller "$workflow"
  echo "$unit_name"
}

load_remaining_manifest() {
  reset_subscription_before_lane=0
  local repetition destination
  load_lane sustained-warmup-232 232 60 1
  check_qualification_lane "$evidence_root/load/sustained-warmup-232-1" stress
  for repetition in 1 2 3; do
    load_lane target-232 232 1800 "$repetition"
    destination="$evidence_root/load/target-232-$repetition"
    check_qualification_lane "$destination" target
  done
  for repetition in 1 2 3; do
    load_lane stress-464 464 900 "$repetition"
    destination="$evidence_root/load/stress-464-$repetition"
    check_qualification_lane "$destination" stress
  done
  load_lane linear-ramp 23 900 1 464
  check_qualification_lane "$evidence_root/load/linear-ramp-1" stress
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
  jq -n --arg manifest "$manifest_version" --arg benchmark_id "$benchmark_id" --arg lane "$lane" --arg started_at "$started_at" \
    --arg offer_ended_at "$offer_ended_at" --arg ended_at "$ended_at" \
    --argjson rate "$rate" --argjson duration "$duration" --argjson count "$expected" \
    '{manifest:$manifest,benchmark_id:$benchmark_id,lane:$lane,repetition:1,handoff:"transactional-outbox",rate_per_second:$rate,end_rate_per_second:$rate,duration_seconds:$duration,count:$count,started_at:$started_at,offer_ended_at:$offer_ended_at,ended_at:$ended_at,audit_recovered_after_controller_interrupt:true}' \
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
  gcloud logging read "timestamp>=\"$started_at\" AND (resource.labels.service_name=\"$worker_service\" OR resource.labels.service_name=\"$ingress_service\" OR resource.labels.service_name=\"$relay_service\") AND (logName!=\"projects/$project_id/logs/run.googleapis.com%2Frequests\" OR httpRequest.status>=400)" \
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
  echo "Usage: ./b3-run.sh provision|deploy|relay|auth-smoke|hard-crash-smoke|worker-crash-smoke|cut-matrix|load <lane> <rate> <seconds> [repetition] [end-rate]|finalize <directory> <benchmark> <expected> <rate> <seconds> <lane>|load-manifest|remaining-manifest|controller <workflow>|start-controller <workflow>|scale-zero|inventory|seal|teardown|decision"
}

command=${1:-}
case "$command" in
  provision) provision ;;
  deploy) deploy_images ;;
  relay) deploy_relay ;;
  auth-smoke) authentication_smoke ;;
  hard-crash-smoke) hard_crash_smoke ;;
  worker-crash-smoke) worker_crash_smoke ;;
  cut-matrix) run_cut_matrix ;;
  load) load_state; shift; load_lane "$@" ;;
  finalize) load_state; shift; finalize_interrupted_lane "$@" ;;
  load-manifest) load_state; load_manifest ;;
  remaining-manifest) load_state; load_remaining_manifest ;;
  controller) load_state; shift; run_controller "$@" ;;
  start-controller) shift; start_controller "$@" ;;
  scale-zero) load_state; scale_from_zero ;;
  inventory) capture_inventory "$evidence_root/final-inventory.json" ;;
  seal) seal_root ;;
  teardown) teardown ;;
  decision) run_decision_evidence ;;
  *) usage; exit 2 ;;
esac

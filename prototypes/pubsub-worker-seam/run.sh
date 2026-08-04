#!/usr/bin/env bash
set -euo pipefail

prototype_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
state_file="$prototype_dir/.run.env"
evidence_root="$prototype_dir/evidence"

project_id=${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}
region=${GCP_REGION:-northamerica-northeast1}
prefix=${RESOURCE_PREFIX:-osfo-b0-39}
sql_instance="$prefix-sql"
artifact_repository="$prefix-repo"
image_uri="$region-docker.pkg.dev/$project_id/$artifact_repository/worker:latest"
worker_service_account="$prefix-worker@$project_id.iam.gserviceaccount.com"
push_auth_service_account="$prefix-push-auth@$project_id.iam.gserviceaccount.com"
crema_service_account="$prefix-crema@$project_id.iam.gserviceaccount.com"
push_service="$prefix-push"
pull_worker_pool="$prefix-pull"
push_topic="$prefix-push"
pull_topic="$prefix-pull"
push_subscription="$prefix-push"
pull_subscription="$prefix-pull"
database_secret="$prefix-database-url"
crema_parameter="$prefix-crema"
crema_service="$prefix-crema"
proxy_port=55439
proxy_pid=""

cleanup_proxy() {
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
}
trap cleanup_proxy EXIT

load_state() {
  if [[ ! -f "$state_file" ]]; then
    echo "Missing $state_file. Run ./run.sh provision first." >&2
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
    parametermanager.googleapis.com monitoring.googleapis.com --project="$project_id"

  if ! gcloud artifacts repositories describe "$artifact_repository" --location="$region" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$artifact_repository" --location="$region" --repository-format=docker
  fi
  if ! gcloud sql instances describe "$sql_instance" >/dev/null 2>&1; then
    gcloud sql instances create "$sql_instance" --project="$project_id" --region="$region" \
      --database-version=POSTGRES_17 --edition=enterprise --cpu=4 --memory=15360MiB --storage-size=100 \
      --availability-type=zonal --assign-ip
  fi

  database_password=$(openssl rand -hex 24)
  if gcloud sql users list --instance="$sql_instance" --format='value(name)' | grep -qx benchmark; then
    gcloud sql users set-password benchmark --instance="$sql_instance" --password="$database_password"
  else
    gcloud sql users create benchmark --instance="$sql_instance" --password="$database_password"
  fi
  if ! gcloud sql databases describe benchmark --instance="$sql_instance" >/dev/null 2>&1; then
    gcloud sql databases create benchmark --instance="$sql_instance"
  fi
  sql_connection_name=$(gcloud sql instances describe "$sql_instance" --format='value(connectionName)')

  ensure_service_account "$prefix-worker"
  ensure_service_account "$prefix-push-auth"
  ensure_service_account "$prefix-crema"
  bind_project_role "$worker_service_account" roles/cloudsql.client
  bind_project_role "$worker_service_account" roles/pubsub.subscriber
  bind_project_role "$crema_service_account" roles/parametermanager.parameterViewer
  bind_project_role "$crema_service_account" roles/run.developer
  bind_project_role "$crema_service_account" roles/iam.serviceAccountUser
  bind_project_role "$crema_service_account" roles/monitoring.viewer
  bind_project_role "$crema_service_account" roles/monitoring.metricWriter

  cloud_database_url="postgres://benchmark:$database_password@/benchmark?host=/cloudsql/$sql_connection_name&sslmode=disable"
  if gcloud secrets describe "$database_secret" >/dev/null 2>&1; then
    printf '%s' "$cloud_database_url" | gcloud secrets versions add "$database_secret" --data-file=- >/dev/null
  else
    printf '%s' "$cloud_database_url" | gcloud secrets create "$database_secret" --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$database_secret" \
    --member="serviceAccount:$worker_service_account" --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null

  umask 077
  {
    printf 'database_password=%q\n' "$database_password"
    printf 'sql_connection_name=%q\n' "$sql_connection_name"
  } >"$state_file"

  gcloud builds submit "$prototype_dir" --tag="$image_uri" --project="$project_id"

  gcloud pubsub topics describe "$push_topic" >/dev/null 2>&1 || gcloud pubsub topics create "$push_topic"
  gcloud pubsub topics describe "$pull_topic" >/dev/null 2>&1 || gcloud pubsub topics create "$pull_topic"
  gcloud pubsub subscriptions describe "$pull_subscription" >/dev/null 2>&1 || \
    gcloud pubsub subscriptions create "$pull_subscription" --topic="$pull_topic" --ack-deadline=10 --enable-message-ordering
  gcloud pubsub subscriptions add-iam-policy-binding "$pull_subscription" \
    --member="serviceAccount:$worker_service_account" --role=roles/pubsub.subscriber --quiet >/dev/null

  gcloud run deploy "$push_service" --image="$image_uri" --region="$region" --project="$project_id" \
    --service-account="$worker_service_account" --no-allow-unauthenticated --cpu=1 --memory=1Gi \
    --concurrency=32 --min=4 --max=4 --cpu-throttling \
    --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="ROLE=push,DB_POOL_SIZE=4,WORKER_SLOTS=32,CLAIM_LEASE_SECONDS=15"
  gcloud run services add-iam-policy-binding "$push_service" --region="$region" \
    --member="serviceAccount:$push_auth_service_account" --role=roles/run.invoker --condition=None --quiet >/dev/null
  push_url=$(gcloud run services describe "$push_service" --region="$region" --format='value(status.url)')
  gcloud pubsub subscriptions describe "$push_subscription" >/dev/null 2>&1 || \
    gcloud pubsub subscriptions create "$push_subscription" --topic="$push_topic" --ack-deadline=10 \
      --enable-message-ordering --push-endpoint="$push_url/v1/pubsub/push" \
      --push-auth-service-account="$push_auth_service_account"

  gcloud run worker-pools deploy "$pull_worker_pool" --image="$image_uri" --region="$region" --project="$project_id" \
    --service-account="$worker_service_account" --instances=4 --cpu=1 --memory=1Gi \
    --add-cloudsql-instances="$sql_connection_name" \
    --set-secrets="DATABASE_URL=$database_secret:latest" \
    --set-env-vars="ROLE=pull,DB_POOL_SIZE=4,WORKER_SLOTS=32,CLAIM_LEASE_SECONDS=15,GCP_PROJECT_ID=$project_id,PUBSUB_SUBSCRIPTION_ID=$pull_subscription"

  start_proxy
  (cd "$prototype_dir" && DATABASE_URL=$(local_database_url) go run ./cmd/harness migrate)
  capture_inventory "$evidence_root/provisioned-inventory.json"
}

configure_fixed() {
  gcloud run services update "$push_service" --region="$region" --min=4 --max=4 --concurrency=32 >/dev/null
  gcloud run worker-pools update "$pull_worker_pool" --region="$region" --instances=4 >/dev/null
}

configure_elastic() {
  gcloud run services update "$push_service" --region="$region" --min=0 --max=8 --concurrency=32 >/dev/null
  gcloud run worker-pools update "$pull_worker_pool" --region="$region" --instances=0 >/dev/null
  deploy_crema
}

deploy_crema() {
  local crema_config="$evidence_root/crema-config.yaml"
  cat >"$crema_config" <<EOF
apiVersion: crema/v1
kind: CremaConfig
metadata:
  name: $prefix
spec:
  pollingInterval: 10
  triggerAuthentications:
    - metadata:
        name: adc-trigger-auth
      spec:
        podIdentity:
          provider: gcp
  scaledObjects:
    - spec:
        scaleTargetRef:
          name: projects/$project_id/locations/$region/workerpools/$pull_worker_pool
        minReplicaCount: 0
        maxReplicaCount: 8
        triggers:
          - type: gcp-pubsub
            metadata:
              subscriptionName: "$pull_subscription"
              value: "32"
              mode: "SubscriptionSize"
            authenticationRef:
              name: adc-trigger-auth
        advanced:
          horizontalPodAutoscalerConfig:
            behavior:
              scaleDown:
                stabilizationWindowSeconds: 30
              scaleUp:
                stabilizationWindowSeconds: 0
                policies:
                  - type: Pods
                    value: 8
                    periodSeconds: 10
EOF
  gcloud parametermanager parameters describe "$crema_parameter" --location=global >/dev/null 2>&1 || \
    gcloud parametermanager parameters create "$crema_parameter" --location=global --parameter-format=YAML
  if gcloud parametermanager parameters versions describe 1 --parameter="$crema_parameter" --location=global >/dev/null 2>&1; then
    gcloud parametermanager parameters versions delete 1 --parameter="$crema_parameter" --location=global --quiet
  fi
  gcloud parametermanager parameters versions create 1 --parameter="$crema_parameter" --location=global \
    --payload-data-from-file="$crema_config"
  gcloud pubsub subscriptions add-iam-policy-binding "$pull_subscription" \
    --member="serviceAccount:$crema_service_account" --role=roles/pubsub.viewer --quiet >/dev/null
  gcloud run deploy "$crema_service" \
    --image=us-central1-docker.pkg.dev/cloud-run-oss-images/crema-v1/autoscaler:1.0 \
    --region="$region" --service-account="$crema_service_account" --no-allow-unauthenticated \
    --no-cpu-throttling --base-image=us-central1-docker.pkg.dev/serverless-runtimes/google-24/runtimes/java25 \
    --memory=1Gi --min=1 --labels=created-by=crema \
    --set-env-vars="CREMA_CONFIG=projects/$project_id/locations/global/parameters/$crema_parameter/versions/1,OUTPUT_SCALER_METRICS=True"
}

scenario() {
  local candidate=$1
  local lane=$2
  local rate=$3
  local duration=$4
  shift 4
  local count=$((rate * duration))
  local benchmark_id
  benchmark_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  local scenario_dir="$evidence_root/$candidate/$lane"
  local topic_id="$push_topic"
  local subscription_id="$push_subscription"
  if [[ "$candidate" == pull* ]]; then
    topic_id="$pull_topic"
    subscription_id="$pull_subscription"
  fi
  mkdir -p "$scenario_dir/topology"
  local seek_time
  seek_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gcloud pubsub subscriptions seek "$subscription_id" --time="$seek_time" >/dev/null
  start_proxy
  local dsn
  dsn=$(local_database_url)
  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (cd "$prototype_dir" && DATABASE_URL="$dsn" go run ./cmd/harness prepare \
    --benchmark="$benchmark_id" --candidate="$candidate" --lane="$lane" --count="$count" "$@")
  (cd "$prototype_dir" && DATABASE_URL="$dsn" go run ./cmd/harness phase --benchmark="$benchmark_id" start)
  local access_token
  access_token=$(gcloud auth application-default print-access-token)
  (cd "$prototype_dir" && GCP_PROJECT_ID="$project_id" GCP_ACCESS_TOKEN="$access_token" go run ./cmd/harness publish \
    --benchmark="$benchmark_id" --topic="$topic_id" --count="$count" --rate="$rate" "$@")
  (cd "$prototype_dir" && DATABASE_URL="$dsn" go run ./cmd/harness phase --benchmark="$benchmark_id" end)
  (cd "$prototype_dir" && DATABASE_URL="$dsn" go run ./cmd/harness wait --benchmark="$benchmark_id" --timeout=15m)
  (cd "$prototype_dir" && DATABASE_URL="$dsn" go run ./cmd/harness audit --benchmark="$benchmark_id") >"$scenario_dir/audit.json"
  local ended_at
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg benchmark_id "$benchmark_id" --arg candidate "$candidate" --arg lane "$lane" \
    --arg started_at "$started_at" --arg ended_at "$ended_at" --argjson rate "$rate" \
    --argjson duration "$duration" --argjson count "$count" \
    '{benchmark_id:$benchmark_id,candidate:$candidate,lane:$lane,rate_per_second:$rate,duration_seconds:$duration,count:$count,started_at:$started_at,ended_at:$ended_at}' \
    >"$scenario_dir/scenario.json"
  capture_scenario "$scenario_dir" "$started_at"
  local checksum_file
  checksum_file=$(mktemp)
  (cd "$scenario_dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum) >"$checksum_file"
  mv "$checksum_file" "$scenario_dir/SHA256SUMS"
  jq . "$scenario_dir/audit.json"
}

capture_scenario() {
  local destination=$1
  local started_at=$2
  gcloud run services describe "$push_service" --region="$region" --format=json >"$destination/topology/push-service.json"
  gcloud run worker-pools describe "$pull_worker_pool" --region="$region" --format=json >"$destination/topology/pull-worker-pool.json"
  gcloud pubsub subscriptions describe "$push_subscription" --format=json >"$destination/topology/push-subscription.json"
  gcloud pubsub subscriptions describe "$pull_subscription" --format=json >"$destination/topology/pull-subscription.json"
  gcloud sql instances describe "$sql_instance" --format=json >"$destination/topology/cloud-sql.json"
  gcloud logging read "timestamp>=\"$started_at\" AND (resource.labels.service_name=\"$push_service\" OR resource.labels.worker_pool_name=\"$pull_worker_pool\" OR resource.labels.service_name=\"$crema_service\")" \
    --format=json --limit=10000 >"$destination/runtime-logs.json"
}

monitoring_query() {
  local destination=$1
  local filter=$2
  local start_time=$3
  local end_time=$4
  local access_token
  access_token=$(gcloud auth print-access-token)
  printf 'header = "Authorization: Bearer %s"\n' "$access_token" | curl --config - -fsS -G \
    --data-urlencode "filter=$filter" \
    --data-urlencode "interval.startTime=$start_time" \
    --data-urlencode "interval.endTime=$end_time" \
    --data-urlencode "pageSize=100000" \
    "https://monitoring.googleapis.com/v3/projects/$project_id/timeSeries" >"$destination"
}

collect_monitoring() {
  local candidate=$1
  local lane=$2
  local scenario_dir="$evidence_root/$candidate/$lane"
  if [[ ! -f "$scenario_dir/scenario.json" ]]; then
    echo "Missing scenario evidence: $scenario_dir/scenario.json" >&2
    exit 1
  fi
  local start_time
  local end_time
  start_time=$(date -u -d "$(jq -r .started_at "$scenario_dir/scenario.json") - 60 seconds" +%Y-%m-%dT%H:%M:%SZ)
  end_time=$(date -u -d "$(jq -r .ended_at "$scenario_dir/scenario.json") + 300 seconds" +%Y-%m-%dT%H:%M:%SZ)
  local run_resource_type=cloud_run_revision
  local run_resource_label=service_name
  local run_resource_name=$push_service
  local subscription_name=$push_subscription
  if [[ "$candidate" == pull* ]]; then
    run_resource_type=cloud_run_worker_pool
    run_resource_label=worker_pool_name
    run_resource_name=$pull_worker_pool
    subscription_name=$pull_subscription
  fi
  mkdir -p "$scenario_dir/monitoring"
  local metric
  for metric in \
    run.googleapis.com/container/instance_count \
    run.googleapis.com/container/cpu/utilizations \
    run.googleapis.com/container/memory/utilizations \
    run.googleapis.com/container/billable_instance_time \
    run.googleapis.com/request_count \
    pubsub.googleapis.com/subscription/num_undelivered_messages \
    pubsub.googleapis.com/subscription/oldest_unacked_message_age \
    pubsub.googleapis.com/subscription/expired_ack_deadlines_count \
    pubsub.googleapis.com/subscription/ack_latencies \
    pubsub.googleapis.com/subscription/push_request_count \
    pubsub.googleapis.com/subscription/push_request_latencies \
    pubsub.googleapis.com/subscription/streaming_pull_message_operation_count \
    pubsub.googleapis.com/subscription/streaming_pull_ack_message_operation_count; do
    if [[ "$candidate" == pull* && "$metric" == run.googleapis.com/request_count ]]; then
      continue
    fi
    local safe_name=${metric//\//__}
    local filter="metric.type=\"$metric\" AND resource.type=\"$run_resource_type\" AND resource.labels.$run_resource_label=\"$run_resource_name\""
    if [[ "$metric" == pubsub.googleapis.com/* ]]; then
      filter="metric.type=\"$metric\" AND resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"$subscription_name\""
    fi
    monitoring_query "$scenario_dir/monitoring/$safe_name.json" "$filter" "$start_time" "$end_time"
  done
  for metric in \
    cloudsql.googleapis.com/database/cpu/utilization \
    cloudsql.googleapis.com/database/postgresql/num_backends; do
    local safe_name=${metric//\//__}
    monitoring_query "$scenario_dir/monitoring/$safe_name.json" \
      "metric.type=\"$metric\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"$project_id:$sql_instance\"" \
      "$start_time" "$end_time"
  done
  local checksum_file
  checksum_file=$(mktemp)
  (cd "$scenario_dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum) >"$checksum_file"
  mv "$checksum_file" "$scenario_dir/SHA256SUMS"
}

capture_inventory() {
  local destination=$1
  jq -n \
    --argjson services "$(gcloud run services list --region="$region" --filter="metadata.name~^$prefix" --format=json)" \
    --argjson pools "$(gcloud run worker-pools list --region="$region" --filter="metadata.name~^$prefix" --format=json)" \
    --argjson sql "$(gcloud sql instances list --filter="name~^$prefix" --format=json)" \
    --argjson topics "$(gcloud pubsub topics list --filter="name~$prefix" --format=json)" \
    --argjson subscriptions "$(gcloud pubsub subscriptions list --filter="name~$prefix" --format=json)" \
    --argjson repositories "$(gcloud artifacts repositories list --location="$region" --filter="name~$prefix" --format=json)" \
    --argjson secrets "$(gcloud secrets list --filter="name~$prefix" --format=json)" \
    --argjson service_accounts "$(gcloud iam service-accounts list --filter="email~$prefix" --format=json)" \
    --argjson parameters "$(gcloud parametermanager parameters list --location=global --filter="name~$prefix" --format=json)" \
    '{services:$services,worker_pools:$pools,sql:$sql,topics:$topics,subscriptions:$subscriptions,repositories:$repositories,secrets:$secrets,service_accounts:$service_accounts,parameters:$parameters}' >"$destination"
}

run_matrix() {
  configure_fixed
  scenario push-fixed smoke 23 5 --workload-ms=15
  scenario pull-fixed smoke 23 5 --workload-ms=15
  scenario push-fixed target-232 232 60 --workload-ms=15
  scenario pull-fixed target-232 232 60 --workload-ms=15
  scenario push-fixed stress-464 464 60 --workload-ms=15
  scenario pull-fixed stress-464 464 60 --workload-ms=15
  scenario push-fixed duplicate-and-ack-expiry 23 4 --workload-ms=15 --duplicate-every=7 --long-every=23 --cancel-every=29 --missing-every=31
  scenario pull-fixed duplicate-and-ack-expiry 23 4 --workload-ms=15 --duplicate-every=7 --long-every=23 --cancel-every=29 --missing-every=31
  scenario push-fixed worker-termination 232 5 --workload-ms=15 --crash-every=290
  scenario pull-fixed worker-termination 232 5 --workload-ms=15 --crash-every=290
  configure_elastic
  sleep 120
  scenario push-elastic idle-to-burst 232 15 --workload-ms=15
  scenario pull-crema idle-to-burst 232 15 --workload-ms=15
}

teardown() {
  set +e
  gcloud run services delete "$crema_service" --region="$region" --quiet
  gcloud run services delete "$push_service" --region="$region" --quiet
  gcloud run worker-pools delete "$pull_worker_pool" --region="$region" --quiet
  gcloud pubsub subscriptions delete "$push_subscription" --quiet
  gcloud pubsub subscriptions delete "$pull_subscription" --quiet
  gcloud pubsub topics delete "$push_topic" --quiet
  gcloud pubsub topics delete "$pull_topic" --quiet
  gcloud parametermanager parameters versions delete 1 --parameter="$crema_parameter" --location=global --quiet
  gcloud parametermanager parameters delete "$crema_parameter" --location=global --quiet
  gcloud secrets delete "$database_secret" --quiet
  gcloud sql instances delete "$sql_instance" --quiet
  gcloud artifacts repositories delete "$artifact_repository" --location="$region" --quiet
  gcloud iam service-accounts delete "$worker_service_account" --quiet
  gcloud iam service-accounts delete "$push_auth_service_account" --quiet
  gcloud iam service-accounts delete "$crema_service_account" --quiet
  set -e
  capture_inventory "$evidence_root/teardown-inventory.json"
  jq '{manifest_owned_cloud_residue: ([.services,.worker_pools,.sql,.topics,.subscriptions,.repositories,.secrets,.service_accounts,.parameters] | map(length) | add), inventory:.}' \
    "$evidence_root/teardown-inventory.json" >"$evidence_root/teardown-verification.json"
  rm -f "$state_file"
}

usage() {
  echo "Usage: ./run.sh provision|fixed|elastic|scenario <candidate> <lane> <rate> <duration> [harness flags]|collect <candidate> <lane>|inventory|matrix|teardown"
}

command=${1:-}
case "$command" in
  provision) provision ;;
  fixed) load_state; configure_fixed ;;
  elastic) load_state; configure_elastic ;;
  scenario) load_state; shift; scenario "$@" ;;
  collect) load_state; shift; collect_monitoring "$@" ;;
  inventory) capture_inventory "$evidence_root/final-inventory.json" ;;
  matrix) load_state; run_matrix ;;
  teardown) teardown ;;
  *) usage; exit 2 ;;
esac

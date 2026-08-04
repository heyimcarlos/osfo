#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT is required}"
region="${OSFO_DEPLOY_REGION:?OSFO_DEPLOY_REGION is required}"
runtime_image="${OSFO_RUNTIME_IMAGE:?OSFO_RUNTIME_IMAGE must be an immutable digest reference}"
schema_service_account="${OSFO_SCHEMA_SERVICE_ACCOUNT:?OSFO_SCHEMA_SERVICE_ACCOUNT is required}"
database_user="${OSFO_SCHEMA_DB_IAM_USER:?OSFO_SCHEMA_DB_IAM_USER is required}"
connection_name="${OSFO_CLOUD_SQL_CONNECTION_NAME:?OSFO_CLOUD_SQL_CONNECTION_NAME is required}"
schema_action="${OSFO_SCHEMA_ACTION:?OSFO_SCHEMA_ACTION must be initialize or migrate}"
schema_worker_pool="${OSFO_SCHEMA_WORKER_POOL:-osfo-schema-command}"
proxy_image="gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.22.0@sha256:fa4c7308245407157c5e9c4e16f1c0f1113899d6f29dc8f8be3e30efae86467f"
deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$deploy_dir/schema-worker-pool.yaml.tpl"

case "$schema_action" in
  initialize)
    schema_command=/usr/local/bin/dispatch_schema_initialize
    expected_log='Empty AgentRun lifecycle schema initialized'
    ;;
  migrate)
    schema_command=/usr/local/bin/dispatch_schema_migrate
    expected_log='AgentRun dispatch schema is current'
    ;;
  *)
    printf 'OSFO_SCHEMA_ACTION must be initialize or migrate\n' >&2
    exit 2
    ;;
esac

database_user_encoded="${database_user//@/%40}"
database_url="postgresql://${database_user_encoded}@127.0.0.1:5432/osfo_v1?sslmode=disable"

export OSFO_SCHEMA_WORKER_POOL="$schema_worker_pool"
export OSFO_DEPLOY_REGION="$region"
export OSFO_SCHEMA_SERVICE_ACCOUNT="$schema_service_account"
export OSFO_CLOUD_SQL_PROXY_IMAGE="$proxy_image"
export OSFO_CLOUD_SQL_CONNECTION_NAME="$connection_name"
export OSFO_RUNTIME_IMAGE="$runtime_image"
export OSFO_SCHEMA_COMMAND="$schema_command"
export OSFO_DATABASE_URL="$database_url"

template_variables='${OSFO_SCHEMA_WORKER_POOL} ${OSFO_DEPLOY_REGION} ${OSFO_SCHEMA_SERVICE_ACCOUNT} ${OSFO_CLOUD_SQL_PROXY_IMAGE} ${OSFO_CLOUD_SQL_CONNECTION_NAME} ${OSFO_RUNTIME_IMAGE} ${OSFO_SCHEMA_COMMAND} ${OSFO_DATABASE_URL}'

envsubst "$template_variables" <"$template" |
  gcloud beta run worker-pools replace - \
    --project="$project" \
    --quiet

for _ in {1..60}; do
  if gcloud logging read \
    "resource.type=cloud_run_worker_pool AND resource.labels.worker_pool_name=$schema_worker_pool AND textPayload=\"$expected_log\"" \
    --project="$project" \
    --freshness=10m \
    --limit=1 \
    --format='value(textPayload)' | grep -Fxq "$expected_log"; then
    gcloud beta run worker-pools delete "$schema_worker_pool" \
      --project="$project" \
      --region="$region" \
      --quiet >/dev/null
    printf '%s\n' "$expected_log"
    exit 0
  fi
  sleep 2
done

printf 'schema command did not report success within 120 seconds\n' >&2
exit 1

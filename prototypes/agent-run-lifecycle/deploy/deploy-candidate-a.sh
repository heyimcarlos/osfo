#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT is required}"
region="${OSFO_DEPLOY_REGION:-northamerica-northeast2}"
runtime_image="${OSFO_RUNTIME_IMAGE:?OSFO_RUNTIME_IMAGE must be an immutable digest reference}"
runtime_service_account="${OSFO_RUNTIME_SERVICE_ACCOUNT:?OSFO_RUNTIME_SERVICE_ACCOUNT is required}"
database_user="${OSFO_RUNTIME_DB_IAM_USER:?OSFO_RUNTIME_DB_IAM_USER is required}"
connection_name="${OSFO_CLOUD_SQL_CONNECTION_NAME:?OSFO_CLOUD_SQL_CONNECTION_NAME is required}"
ingress_service="${OSFO_INGRESS_SERVICE:-osfo-ingress}"
stream_service="${OSFO_STREAM_SERVICE:-osfo-stream}"
worker_pool="${OSFO_AGENT_RUN_WORKER_POOL:-osfo-agent-run-worker}"
ingress_min_instances="${OSFO_INGRESS_MIN_INSTANCES:-4}"
ingress_max_instances="${OSFO_INGRESS_MAX_INSTANCES:-12}"
ingress_concurrency="${OSFO_INGRESS_CONCURRENCY:-16}"
ingress_database_pool_size="${OSFO_INGRESS_DATABASE_POOL_SIZE:-4}"
stream_min_instances="${OSFO_STREAM_MIN_INSTANCES:-2}"
stream_max_instances="${OSFO_STREAM_MAX_INSTANCES:-8}"
stream_concurrency="${OSFO_STREAM_CONCURRENCY:-500}"
stream_database_pool_size="${OSFO_STREAM_DATABASE_POOL_SIZE:-4}"
ingress_secret="${OSFO_INGRESS_SECRET_NAME:-osfo-ingress-bearer-token}"
ingress_secret_version="${OSFO_INGRESS_SECRET_VERSION:-latest}"
deploy_target="${OSFO_DEPLOY_TARGET:-all}"
proxy_image="gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.22.0@sha256:fa4c7308245407157c5e9c4e16f1c0f1113899d6f29dc8f8be3e30efae86467f"
deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_pool_template="$deploy_dir/candidate-a-worker-pool.yaml.tpl"

database_user_encoded="${database_user//@/%40}"
database_url="postgresql://${database_user_encoded}@127.0.0.1:5432/osfo_v1?sslmode=disable"

if [[ "$deploy_target" != "all" && "$deploy_target" != "ingress" && "$deploy_target" != "worker" ]]; then
  printf 'OSFO_DEPLOY_TARGET must be all, ingress, or worker\n' >&2
  exit 2
fi

if [[ "$deploy_target" == "all" || "$deploy_target" == "ingress" ]]; then
gcloud run deploy "$ingress_service" \
  --project="$project" \
  --region="$region" \
  --platform=managed \
  --service-account="$runtime_service_account" \
  --allow-unauthenticated \
  --min="$ingress_min_instances" \
  --max="$ingress_max_instances" \
  --concurrency="$ingress_concurrency" \
  --timeout=3600 \
  --quiet \
  --container=cloud-sql-proxy \
  --image="$proxy_image" \
  --args=--auto-iam-authn,--structured-logs,--address=0.0.0.0,--port=5432,--health-check,--http-address=0.0.0.0,--http-port=9090,"$connection_name" \
  --cpu=0.25 \
  --memory=256Mi \
  --startup-probe=httpGet.path=/startup,httpGet.port=9090,initialDelaySeconds=1,timeoutSeconds=1,periodSeconds=1,failureThreshold=30 \
  --container=ingress \
  --image="$runtime_image" \
  --port=8080 \
  --depends-on=cloud-sql-proxy \
  --cpu=1 \
  --memory=512Mi \
  --set-env-vars="OSFO_DATABASE_URL=$database_url,OSFO_INGRESS_ACCOUNT_ID=general-magic-demo,OSFO_INGRESS_DATABASE_POOL_SIZE=$ingress_database_pool_size" \
  --set-secrets="OSFO_INGRESS_BEARER_TOKEN=$ingress_secret:$ingress_secret_version" \
  --startup-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=1,timeoutSeconds=5,periodSeconds=5,failureThreshold=24

gcloud run deploy "$stream_service" \
  --project="$project" \
  --region="$region" \
  --platform=managed \
  --service-account="$runtime_service_account" \
  --allow-unauthenticated \
  --min="$stream_min_instances" \
  --max="$stream_max_instances" \
  --concurrency="$stream_concurrency" \
  --timeout=3600 \
  --quiet \
  --container=cloud-sql-proxy \
  --image="$proxy_image" \
  --args=--auto-iam-authn,--structured-logs,--address=0.0.0.0,--port=5432,--health-check,--http-address=0.0.0.0,--http-port=9090,"$connection_name" \
  --cpu=0.25 \
  --memory=256Mi \
  --startup-probe=httpGet.path=/startup,httpGet.port=9090,initialDelaySeconds=1,timeoutSeconds=1,periodSeconds=1,failureThreshold=30 \
  --container=stream \
  --image="$runtime_image" \
  --port=8080 \
  --depends-on=cloud-sql-proxy \
  --cpu=1 \
  --memory=512Mi \
  --set-env-vars="OSFO_DATABASE_URL=$database_url,OSFO_INGRESS_ACCOUNT_ID=general-magic-demo,OSFO_INGRESS_DATABASE_POOL_SIZE=$stream_database_pool_size" \
  --set-secrets="OSFO_INGRESS_BEARER_TOKEN=$ingress_secret:$ingress_secret_version" \
  --startup-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=1,timeoutSeconds=5,periodSeconds=5,failureThreshold=24
fi

if [[ "$deploy_target" == "all" || "$deploy_target" == "worker" ]]; then
  export OSFO_AGENT_RUN_WORKER_POOL="$worker_pool"
  export OSFO_AGENT_RUN_WORKER_INSTANCES="${OSFO_AGENT_RUN_WORKER_INSTANCES:-2}"
  export OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE="${OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE:-8}"
  export OSFO_AGENT_RUN_WORKER_CONCURRENCY="${OSFO_AGENT_RUN_WORKER_CONCURRENCY:-16}"
  export OSFO_DEPLOY_REGION="$region"
  export OSFO_RUNTIME_SERVICE_ACCOUNT="$runtime_service_account"
  export OSFO_CLOUD_SQL_PROXY_IMAGE="$proxy_image"
  export OSFO_CLOUD_SQL_CONNECTION_NAME="$connection_name"
  export OSFO_RUNTIME_IMAGE="$runtime_image"
  export OSFO_DATABASE_URL="$database_url"

  template_variables='${OSFO_AGENT_RUN_WORKER_POOL} ${OSFO_DEPLOY_REGION} ${OSFO_AGENT_RUN_WORKER_INSTANCES} ${OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE} ${OSFO_AGENT_RUN_WORKER_CONCURRENCY} ${OSFO_RUNTIME_SERVICE_ACCOUNT} ${OSFO_CLOUD_SQL_PROXY_IMAGE} ${OSFO_CLOUD_SQL_CONNECTION_NAME} ${OSFO_RUNTIME_IMAGE} ${OSFO_DATABASE_URL}'

  envsubst "$template_variables" <"$worker_pool_template" |
    gcloud beta run worker-pools replace - \
      --project="$project" \
      --quiet
fi

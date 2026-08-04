#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT is required}"
region="${OSFO_DEPLOY_REGION:-northamerica-northeast2}"
worker_pool="${OSFO_TEMPORAL_WORKER_POOL:-osfo-temporal-cloud-worker}"
worker_image="${OSFO_TEMPORAL_WORKER_IMAGE:?OSFO_TEMPORAL_WORKER_IMAGE must be an immutable digest reference}"
runtime_service_account="${OSFO_RUNTIME_SERVICE_ACCOUNT:?OSFO_RUNTIME_SERVICE_ACCOUNT is required}"
temporal_address="${TEMPORAL_ADDRESS:?TEMPORAL_ADDRESS is required}"
temporal_namespace="${TEMPORAL_NAMESPACE:?TEMPORAL_NAMESPACE is required}"
temporal_task_queue="${TEMPORAL_TASK_QUEUE:?TEMPORAL_TASK_QUEUE is required}"
api_key_secret="${OSFO_TEMPORAL_API_KEY_SECRET_NAME:-osfo-temporal-api-key}"
api_key_version="${OSFO_TEMPORAL_API_KEY_SECRET_VERSION:?OSFO_TEMPORAL_API_KEY_SECRET_VERSION is required}"
deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$deploy_dir/temporal-cloud-worker-pool.yaml.tpl"

export OSFO_DEPLOY_REGION="$region"
export OSFO_TEMPORAL_WORKER_POOL="$worker_pool"
export OSFO_TEMPORAL_WORKER_IMAGE="$worker_image"
export OSFO_RUNTIME_SERVICE_ACCOUNT="$runtime_service_account"
export TEMPORAL_ADDRESS="$temporal_address"
export TEMPORAL_NAMESPACE="$temporal_namespace"
export TEMPORAL_TASK_QUEUE="$temporal_task_queue"
export OSFO_TEMPORAL_API_KEY_SECRET_NAME="$api_key_secret"
export OSFO_TEMPORAL_API_KEY_SECRET_VERSION="$api_key_version"
export OSFO_TEMPORAL_WORKER_INSTANCES="${OSFO_TEMPORAL_WORKER_INSTANCES:-2}"
export OSFO_TEMPORAL_WORKER_FLEET_ID="${OSFO_TEMPORAL_WORKER_FLEET_ID:-osfo-temporal-cloud-worker}"
export OSFO_TEMPORAL_WORKER_SLOTS="${OSFO_TEMPORAL_WORKER_SLOTS:-32}"

template_variables='${OSFO_DEPLOY_REGION} ${OSFO_TEMPORAL_WORKER_POOL} ${OSFO_TEMPORAL_WORKER_IMAGE} ${OSFO_RUNTIME_SERVICE_ACCOUNT} ${TEMPORAL_ADDRESS} ${TEMPORAL_NAMESPACE} ${TEMPORAL_TASK_QUEUE} ${OSFO_TEMPORAL_API_KEY_SECRET_NAME} ${OSFO_TEMPORAL_API_KEY_SECRET_VERSION} ${OSFO_TEMPORAL_WORKER_INSTANCES} ${OSFO_TEMPORAL_WORKER_FLEET_ID} ${OSFO_TEMPORAL_WORKER_SLOTS}'

envsubst "$template_variables" <"$template" |
  gcloud beta run worker-pools replace - \
    --project="$project" \
    --quiet

#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_log="$(mktemp)"
trap 'rm -f "$test_log"' EXIT

gcloud() {
  printf '%q ' "$@" >>"$OSFO_DEPLOY_TEST_LOG"
  printf '\n' >>"$OSFO_DEPLOY_TEST_LOG"
  command cat >/dev/null
}
export -f gcloud
export OSFO_DEPLOY_TEST_LOG="$test_log"

GOOGLE_CLOUD_PROJECT=test-project \
OSFO_DEPLOY_REGION=northamerica-northeast1 \
OSFO_TEMPORAL_WORKER_IMAGE='example.invalid/temporal@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
OSFO_RUNTIME_SERVICE_ACCOUNT='runtime@test-project.iam.gserviceaccount.com' \
TEMPORAL_ADDRESS='namespace.tmprl.cloud:7233' \
TEMPORAL_NAMESPACE='namespace.account' \
TEMPORAL_TASK_QUEUE='osfo-temporal-test' \
OSFO_TEMPORAL_API_KEY_SECRET_VERSION=1 \
bash "$prototype_dir/deploy/deploy-temporal-cloud-worker.sh"

[[ "$(wc -l <"$test_log")" -eq 1 ]]
grep -q 'worker-pools replace -' "$test_log"
grep -q 'OSFO_SANDBOX_PROVIDER' "$prototype_dir/deploy/temporal-cloud-worker-pool.yaml.tpl"
grep -q 'value: disabled' "$prototype_dir/deploy/temporal-cloud-worker-pool.yaml.tpl"
grep -q 'startupProbe:' "$prototype_dir/deploy/temporal-cloud-worker-pool.yaml.tpl"
grep -q 'secretKeyRef:' "$prototype_dir/deploy/temporal-cloud-worker-pool.yaml.tpl"

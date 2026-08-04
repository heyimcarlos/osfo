#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_log="$(mktemp)"
trap 'rm -f "$test_log"' EXIT

gcloud() {
  printf '%q ' "$@" >>"$OSFO_DEPLOY_TEST_LOG"
  printf '\n' >>"$OSFO_DEPLOY_TEST_LOG"
  if [[ "$*" == *"worker-pools replace -"* ]]; then
    command cat >/dev/null
  fi
}
export -f gcloud
export OSFO_DEPLOY_TEST_LOG="$test_log"

GOOGLE_CLOUD_PROJECT=test-project \
OSFO_DEPLOY_REGION=northamerica-northeast1 \
OSFO_RUNTIME_IMAGE='example.invalid/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
OSFO_RUNTIME_SERVICE_ACCOUNT='runtime@test-project.iam.gserviceaccount.com' \
OSFO_RUNTIME_DB_IAM_USER='runtime@test-project.iam' \
OSFO_CLOUD_SQL_CONNECTION_NAME='test-project:northamerica-northeast1:test-instance' \
OSFO_DEPLOY_TARGET=worker \
bash "$prototype_dir/deploy/deploy-candidate-a.sh"

[[ "$(wc -l <"$test_log")" -eq 1 ]]
grep -q 'worker-pools replace -' "$test_log"
grep -q 'startupProbe:' "$prototype_dir/deploy/candidate-a-worker-pool.yaml.tpl"
grep -q 'container-dependencies:' "$prototype_dir/deploy/candidate-a-worker-pool.yaml.tpl"
[[ "$(grep -c "OSFO_INGRESS_DATABASE_POOL_SIZE=4" "$prototype_dir/deploy/deploy-candidate-a.sh")" -eq 2 ]]
grep -A1 -q "OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE.*value: '8'" \
  "$prototype_dir/deploy/candidate-a-worker-pool.yaml.tpl"
grep -A1 -q "OSFO_AGENT_RUN_WORKER_CONCURRENCY.*value: '16'" \
  "$prototype_dir/deploy/candidate-a-worker-pool.yaml.tpl"
if grep -q 'run deploy osfo-ingress' "$test_log"; then
  printf 'worker-only deployment unexpectedly included ingress\n' >&2
  exit 1
fi

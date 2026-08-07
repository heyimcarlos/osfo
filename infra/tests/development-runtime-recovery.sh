#!/usr/bin/env bash

set -euo pipefail

project_id=${GCP_DEVELOPMENT_PROJECT_ID:-}
region=${GCP_REGION:-us-east4}
prefix=${OSFO_NAME_PREFIX:-osfo-dev}
evidence_directory=${OSFO_RUNTIME_EVIDENCE_DIRECTORY:-.plans/development-runtime-evidence}
smoke_evidence="$evidence_directory/smoke.json"

if [[ -z "$project_id" ]]; then
  printf 'MISSING: development runtime recovery input project_id\n' >&2
  exit 2
fi
if [[ ! -f "$smoke_evidence" ]]; then
  printf 'MISSING: run the exact-head development runtime smoke first\n' >&2
  exit 2
fi

source_sha=$(jq -er '.sourceSha' "$smoke_evidence")
agent_run_id=$(jq -er '.agentRunId' "$smoke_evidence")
thread_id=$(jq -er '.threadId' "$smoke_evidence")
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT
reconciliation_index=0

read_reconciliation() {
  local destination=$1
  local encoded execution_name log_filter
  reconciliation_index=$((reconciliation_index + 1))
  if ! gcloud run jobs execute "$prefix-reconciliation" \
    --project="$project_id" \
    --region="$region" \
    --container=reconciliation \
    --update-env-vars="OSFO_RECONCILIATION_AGENT_RUN_ID=$agent_run_id,OSFO_RECONCILIATION_REQUIRE_PASS=true" \
    --wait \
    --format=json >"$work_directory/reconciliation-execution-$reconciliation_index.json"; then
    return 1
  fi

  execution_name=$(jq -r '.metadata.name // .name // empty' \
    "$work_directory/reconciliation-execution-$reconciliation_index.json")
  execution_name=${execution_name##*/}
  log_filter="resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$prefix-reconciliation\""
  if [[ -n "$execution_name" ]]; then
    log_filter="$log_filter AND labels.\"run.googleapis.com/execution_name\"=\"$execution_name\""
  fi

  encoded=""
  for _ in $(seq 1 30); do
    gcloud logging read "$log_filter" \
      --project="$project_id" --limit=100 --order=desc --format=json \
      >"$work_directory/reconciliation-logs-$reconciliation_index.json"
    encoded=$(jq -r '
      [.. | strings
        | select(contains("OSFO_RECONCILIATION_EVIDENCE:"))
        | capture("OSFO_RECONCILIATION_EVIDENCE:(?<value>[A-Za-z0-9+/=]+)").value][0] // empty
    ' "$work_directory/reconciliation-logs-$reconciliation_index.json")
    if [[ -n "$encoded" ]]; then
      break
    fi
    sleep 2
  done
  if [[ -z "$encoded" ]]; then
    return 1
  fi
  printf '%s' "$encoded" | base64 --decode >"$destination"
  jq -e --arg agent_run_id "$agent_run_id" '
    .verdict == "PASS"
    and .agentRunId == $agent_run_id
    and .executionProfileRef == "oz.openrouter.minimax.minimax-m3.chat-completions.v1"
    and .modelBinding == "openrouter.chat-completions.minimax.minimax-m3.v1"
    and .modelCallAttemptCount == "1"
    and .confirmedProviderRequestCount == "1"
    and .distinctProviderRequestCount == "1"
    and .reportedUsageAttemptCount == "1"
    and .positiveReasoningUsageAttemptCount == "1"
  ' "$destination" >/dev/null
}

if ! read_reconciliation "$work_directory/before-duplicate.json"; then
  printf 'FAIL: smoke AgentRun did not retain the exact sanitized MiniMax proof\n' >&2
  exit 1
fi

delivery=$(jq -c '{
  version: 1,
  deliveryId,
  agentRunId,
  threadId,
  executionProfileRef
}' "$work_directory/before-duplicate.json")
delivery_id=$(jq -r '.deliveryId' "$work_directory/before-duplicate.json")
execution_profile_ref=$(jq -r '.executionProfileRef' "$work_directory/before-duplicate.json")
duplicate_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gcloud pubsub topics publish "$prefix-agentruns" \
  --project="$project_id" \
  --message="$delivery" \
  --attribute="executionProfileRef=$execution_profile_ref" \
  --ordering-key="$thread_id" \
  --format=json >"$work_directory/duplicate-publication.json"

duplicate_settled=0
for _ in $(seq 1 60); do
  gcloud logging read \
    "resource.type=\"cloud_run_worker_pool_revision\" AND resource.labels.worker_pool_name=\"$prefix-agentrun\" AND timestamp>=\"$duplicate_started_at\" AND \"OSFO_AGENT_RUN_DELIVERY_SETTLED\" AND \"$delivery_id\" AND \"alreadyTerminal\"" \
    --project="$project_id" --limit=1 --format=json >"$work_directory/duplicate-logs.json"
  if jq -e 'length == 1' "$work_directory/duplicate-logs.json" >/dev/null; then
    duplicate_settled=1
    break
  fi
  sleep 2
done
if ((duplicate_settled == 0)); then
  printf 'FAIL: duplicate delivery did not settle as already terminal\n' >&2
  exit 1
fi

if ! read_reconciliation "$work_directory/after-duplicate.json" ||
  ! jq --sort-keys . "$work_directory/before-duplicate.json" \
    >"$work_directory/before-duplicate.sorted.json" ||
  ! jq --sort-keys . "$work_directory/after-duplicate.json" \
    >"$work_directory/after-duplicate.sorted.json" ||
  ! cmp --silent "$work_directory/before-duplicate.sorted.json" \
    "$work_directory/after-duplicate.sorted.json"; then
  printf 'FAIL: duplicate delivery changed the authoritative identity graph\n' >&2
  exit 1
fi

jq -n \
  --arg source_sha "$source_sha" \
  --arg agent_run_id "$agent_run_id" \
  '{
    sourceSha: $source_sha,
    agentRunId: $agent_run_id,
    duplicateDelivery: "PASS",
    leaseTakeover: "MISSING",
    processReplacement: "MISSING",
    replacementBeforeProviderContact: "MISSING",
    productionQualification: "MISSING"
  }' >"$evidence_directory/recovery.json"

printf 'PASS: duplicate Pub/Sub delivery preserved one authoritative MiniMax outcome\n'
printf 'MISSING: replacement-before-provider-contact needs an explicit pre-provider qualification seam\n'
printf 'MISSING: lease takeover, saved-plan rollback, and exact runtime teardown remain protected lifecycle stages\n'

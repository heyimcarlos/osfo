#!/usr/bin/env bash

set -euo pipefail

project_id=${GCP_DEVELOPMENT_PROJECT_ID:-}
region=${GCP_REGION:-us-east4}
prefix=${OSFO_NAME_PREFIX:-osfo-dev}
origin=${OSFO_RUNTIME_ORIGIN:-}
authentication_token=${OSFO_REFERENCE_AUTHENTICATION_TOKEN:-}
thread_id=${OSFO_REFERENCE_THREAD_ID:-}
database_url=${OSFO_DATABASE_URL:-}
evidence_directory=${OSFO_RUNTIME_EVIDENCE_DIRECTORY:-.plans/development-runtime-evidence}

missing=0
for input in project_id origin authentication_token thread_id database_url; do
  if [[ -z ${!input} ]]; then
    printf 'MISSING: development runtime smoke input %s\n' "$input" >&2
    missing=1
  fi
done
if ((missing != 0)); then
  exit 2
fi
if [[ ! "$origin" =~ ^https:// ]]; then
  printf 'FAIL: OSFO_RUNTIME_ORIGIN must use HTTPS\n' >&2
  exit 1
fi

mkdir -p "$evidence_directory"
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT

authenticated_curl() {
  curl --silent --show-error --config - "$@" <<EOF
header = "Authorization: Bearer $authentication_token"
EOF
}

read_reconciliation() {
  local agent_run_id=$1
  local destination=$2
  local encoded
  if ! OSFO_DATABASE_URL="$database_url" \
    OSFO_RECONCILIATION_AGENT_RUN_ID="$agent_run_id" \
    OSFO_RECONCILIATION_REQUIRE_PASS=true \
    node --conditions=development --import tsx \
      scripts/qualification/reconcile-agent-run.ts \
      >"$work_directory/reconciliation-output.log" 2>&1; then
    return 1
  fi
  encoded=$(sed -n \
    's/.*OSFO_RECONCILIATION_EVIDENCE:\([A-Za-z0-9+/=]*\).*/\1/p' \
    "$work_directory/reconciliation-output.log" | head -1)
  if [[ -z "$encoded" ]]; then
    return 1
  fi
  printf '%s' "$encoded" | base64 --decode >"$destination"
}

health_status=$(curl --silent --show-error --output "$work_directory/health.json" \
  --write-out '%{http_code}' "$origin/healthz")
if [[ "$health_status" != 200 ]] ||
  ! jq -e '.status == "ready" and .profile == "oz.openrouter.minimax.minimax-m3.chat-completions.v1"' \
    "$work_directory/health.json" >/dev/null; then
  printf 'FAIL: Oz OpenRouter HTTPS readiness returned status %s\n' "$health_status" >&2
  exit 1
fi
printf 'PASS: Oz OpenRouter transport readiness over HTTPS\n'

unauthenticated_status=$(curl --silent --show-error --output "$work_directory/unauthenticated.json" \
  --write-out '%{http_code}' "$origin/v1/threads/$thread_id/snapshot")
if [[ "$unauthenticated_status" != 401 ]] ||
  ! jq -e '._tag == "AuthenticationRejected"' "$work_directory/unauthenticated.json" >/dev/null; then
  printf 'FAIL: unauthenticated transport was not rejected with the typed 401 response\n' >&2
  exit 1
fi
printf 'PASS: transport authentication rejects a missing bearer\n'

snapshot_status=$(authenticated_curl --output "$work_directory/snapshot-before.json" \
  --write-out '%{http_code}' "$origin/v1/threads/$thread_id/snapshot")
if [[ "$snapshot_status" != 200 ]] ||
  ! jq -e --arg thread_id "$thread_id" \
    '.threadId == $thread_id and (.throughCursor | length > 0)' \
    "$work_directory/snapshot-before.json" >/dev/null; then
  printf 'FAIL: authenticated snapshot returned status %s\n' "$snapshot_status" >&2
  exit 1
fi
initial_cursor=$(jq -r '.throughCursor' "$work_directory/snapshot-before.json")
initial_position=$(jq -r '.throughPosition' "$work_directory/snapshot-before.json")
initial_assistant_outputs=$(jq '[.timeline[] | select(.type == "assistantOutput")] | length' \
  "$work_directory/snapshot-before.json")

idempotency_key=$(< /proc/sys/kernel/random/uuid)
command_body=$(jq -nc --arg key "$idempotency_key" \
  '{protocolVersion: 1, idempotencyKey: $key, message: {content: "Development Oz MiniMax M3 proof"}}')
command_status=$(authenticated_curl --request POST --header 'content-type: application/json' \
  --data "$command_body" --output "$work_directory/receipt.json" --write-out '%{http_code}' \
  "$origin/v1/threads/$thread_id/messages")
if [[ "$command_status" != 200 ]] ||
  ! jq -e --arg key "$idempotency_key" --arg thread_id "$thread_id" \
    '.idempotencyKey == $key and .threadId == $thread_id and (.agentRunId | length > 0)' \
    "$work_directory/receipt.json" >/dev/null; then
  printf 'FAIL: Oz command admission returned status %s\n' "$command_status" >&2
  exit 1
fi
printf 'PASS: Oz command returned a durable acceptance receipt\n'
proof_agent_run_id=$(jq -r '.agentRunId' "$work_directory/receipt.json")

duplicate_status=$(authenticated_curl --request POST --header 'content-type: application/json' \
  --data "$command_body" --output "$work_directory/receipt-duplicate.json" --write-out '%{http_code}' \
  "$origin/v1/threads/$thread_id/messages")
if [[ "$duplicate_status" != 200 ]] ||
  ! jq -e --slurp '.[0] == .[1]' \
    "$work_directory/receipt.json" "$work_directory/receipt-duplicate.json" >/dev/null; then
  printf 'FAIL: repeated command admission did not return the same durable receipt\n' >&2
  exit 1
fi
printf 'PASS: repeated command admission returned the same durable receipt\n'

completed=0
for _ in $(seq 1 120); do
  authenticated_curl --output "$work_directory/snapshot-after.json" \
    "$origin/v1/threads/$thread_id/snapshot"
  current_position=$(jq -r '.throughPosition' "$work_directory/snapshot-after.json")
  if [[ "$current_position" != "$initial_position" ]] &&
    jq -e --argjson initial_assistant_outputs "$initial_assistant_outputs" \
      '[.timeline[] | select(.type == "assistantOutput")] | length > $initial_assistant_outputs' \
      "$work_directory/snapshot-after.json" >/dev/null; then
    completed=1
    break
  fi
  sleep 1
done
if ((completed == 0)); then
  printf 'FAIL: Oz AgentRun did not reach authoritative assistant output\n' >&2
  exit 1
fi
printf 'PASS: ordered delivery committed authoritative Oz output\n'
first_cursor=$(jq -r '.throughCursor' "$work_directory/snapshot-after.json")
first_position=$current_position

if ! read_reconciliation "$proof_agent_run_id" "$work_directory/reconciliation.json" ||
  ! jq -e --arg agent_run_id "$proof_agent_run_id" '
    .verdict == "PASS"
    and .agentRunId == $agent_run_id
    and .executionProfileRef == "oz.openrouter.minimax.minimax-m3.chat-completions.v1"
    and .modelBinding == "openrouter.chat-completions.minimax.minimax-m3.v1"
    and .modelCallAttemptCount == "1"
    and .terminalModelCallAttemptCount == "1"
    and .openModelCallAttemptCount == "0"
    and .confirmedProviderRequestCount == "1"
    and .distinctProviderRequestCount == "1"
    and .completedAssistantOutputCount == "1"
    and .reportedUsageAttemptCount == "1"
    and .positiveReasoningUsageAttemptCount == "1"
  ' "$work_directory/reconciliation.json" >/dev/null; then
  printf 'FAIL: exact Oz AgentRun did not retain one sanitized MiniMax provider proof\n' >&2
  exit 1
fi
printf 'PASS: exact Oz AgentRun retained one MiniMax request, terminal output, and reported reasoning usage\n'

checkpoint_key=$(< /proc/sys/kernel/random/uuid)
checkpoint_body=$(jq -nc --arg key "$checkpoint_key" \
  '{protocolVersion: 1, idempotencyKey: $key, message: {content: "Development cursor checkpoint"}}')
checkpoint_outputs=$(jq '[.timeline[] | select(.type == "assistantOutput")] | length' \
  "$work_directory/snapshot-after.json")
authenticated_curl --request POST --header 'content-type: application/json' \
  --data "$checkpoint_body" --output "$work_directory/checkpoint-receipt.json" \
  "$origin/v1/threads/$thread_id/messages"
checkpoint_completed=0
for _ in $(seq 1 120); do
  authenticated_curl --output "$work_directory/snapshot-checkpoint.json" \
    "$origin/v1/threads/$thread_id/snapshot"
  if jq -e --argjson checkpoint_outputs "$checkpoint_outputs" \
    '[.timeline[] | select(.type == "assistantOutput")] | length > $checkpoint_outputs' \
    "$work_directory/snapshot-checkpoint.json" >/dev/null; then
    checkpoint_completed=1
    break
  fi
  sleep 1
done
if ((checkpoint_completed == 0)); then
  printf 'FAIL: cursor checkpoint did not reach authoritative output\n' >&2
  exit 1
fi
checkpoint_cursor=$(jq -r '.throughCursor' "$work_directory/snapshot-checkpoint.json")
current_position=$(jq -r '.throughPosition' "$work_directory/snapshot-checkpoint.json")
if [[ "$initial_cursor" == "$first_cursor" || "$first_cursor" == "$checkpoint_cursor" || "$initial_cursor" == "$checkpoint_cursor" ]]; then
  printf 'FAIL: three clients did not retain distinct cursor checkpoints\n' >&2
  exit 1
fi

tabs=(a b c)
cursors=("$initial_cursor" "$first_cursor" "$checkpoint_cursor")
for index in "${!tabs[@]}"; do
  tab=${tabs[$index]}
  cursor=${cursors[$index]}
  resume_status=0
  authenticated_curl --max-time 5 --no-buffer --header 'accept: text/event-stream' \
    "$origin/v1/threads/$thread_id/events?after=$cursor" \
    >"$work_directory/resume-$tab.sse" || resume_status=$?
  if ((resume_status != 0 && resume_status != 28)) ||
    ! rg --fixed-strings --quiet 'event: caught_up' "$work_directory/resume-$tab.sse"; then
    printf 'FAIL: tab %s did not resume and catch up from its own cursor\n' "$tab" >&2
    exit 1
  fi
done
printf 'PASS: three independent clients resumed from distinct cursor checkpoints\n'

cancellation_key=$(< /proc/sys/kernel/random/uuid)
cancellation_body=$(jq -nc --arg key "$cancellation_key" \
  '{protocolVersion: 1, idempotencyKey: $key, message: {content: "Development cancellation proof"}}')
authenticated_curl --request POST --header 'content-type: application/json' \
  --data "$cancellation_body" --output "$work_directory/cancellation-receipt.json" \
  "$origin/v1/threads/$thread_id/messages"
cancellation_agent_run_id=$(jq -r '.agentRunId' "$work_directory/cancellation-receipt.json")
cancellation_request='{"protocolVersion":1}'
cancel_status=$(authenticated_curl --request POST --header 'content-type: application/json' \
  --data "$cancellation_request" --output "$work_directory/cancellation.json" --write-out '%{http_code}' \
  "$origin/v1/threads/$thread_id/agent-runs/$cancellation_agent_run_id/cancellation")
if [[ "$cancel_status" != 200 ]] ||
  ! jq -e '.outcome == "cancellationRequested" or .outcome == "canceled" or .outcome == "alreadyTerminal"' \
    "$work_directory/cancellation.json" >/dev/null; then
  printf 'FAIL: AgentRun cancellation returned status %s\n' "$cancel_status" >&2
  exit 1
fi
printf 'PASS: authenticated AgentRun cancellation returned a typed outcome\n'

gcloud run services describe "$prefix-transport" --project="$project_id" --region="$region" \
  --format=json >"$work_directory/transport.json"
gcloud beta run worker-pools describe "$prefix-relay" --project="$project_id" --region="$region" \
  --format=json >"$work_directory/relay.json"
gcloud beta run worker-pools describe "$prefix-agentrun" --project="$project_id" --region="$region" \
  --format=json >"$work_directory/agentrun.json"
gcloud pubsub subscriptions describe "$prefix-agentruns" --project="$project_id" \
  --format=json >"$work_directory/subscription.json"
gcloud sql instances describe "$prefix-postgres" --project="$project_id" \
  --format=json >"$work_directory/database.json"

if ! jq -e '.scaling.manualInstanceCount == 1' "$work_directory/relay.json" >/dev/null; then
  printf 'FAIL: relay worker pool is not fixed at one instance\n' >&2
  exit 1
fi
if ! jq -e '.scaling.manualInstanceCount == 6' "$work_directory/agentrun.json" >/dev/null; then
  printf 'FAIL: AgentRun candidate is not fixed at six workers\n' >&2
  exit 1
fi
if ! jq -e '.enableMessageOrdering == true' "$work_directory/subscription.json" >/dev/null; then
  printf 'FAIL: AgentRun subscription is not ordered\n' >&2
  exit 1
fi
if ! jq -e '
  .settings.ipConfiguration.ipv4Enabled == false
  and any(.ipAddresses[]; .type == "PRIVATE")
  and any(.settings.databaseFlags[]; .name == "cloudsql.iam_authentication" and .value == "on")
' "$work_directory/database.json" >/dev/null; then
  printf 'FAIL: Cloud SQL does not retain private-IP IAM authentication\n' >&2
  exit 1
fi
printf 'PASS: fixed-one relay, six-worker candidate, ordered Pub/Sub, and private Cloud SQL observed\n'

jq -n \
  --arg source_sha "${GITHUB_SHA:-$(git rev-parse HEAD)}" \
  --arg origin "$origin" \
  --arg thread_id "$thread_id" \
  --arg agent_run_id "$proof_agent_run_id" \
  --arg initial_position "$initial_position" \
  --arg first_position "$first_position" \
  --arg final_position "$current_position" \
  --arg cancellation_outcome "$(jq -r '.outcome' "$work_directory/cancellation.json")" \
  --slurpfile reconciliation "$work_directory/reconciliation.json" \
  '{
    sourceSha: $source_sha,
    origin: $origin,
    threadId: $thread_id,
    agentRunId: $agent_run_id,
    initialPosition: $initial_position,
    firstPosition: $first_position,
    finalPosition: $final_position,
    cancellationOutcome: $cancellation_outcome,
    providerQualification: {
      executionProfileRef: $reconciliation[0].executionProfileRef,
      modelBinding: $reconciliation[0].modelBinding,
      modelCallAttemptCount: $reconciliation[0].modelCallAttemptCount,
      confirmedProviderRequestCount: $reconciliation[0].confirmedProviderRequestCount,
      distinctProviderRequestCount: $reconciliation[0].distinctProviderRequestCount,
      reportedUsageAttemptCount: $reconciliation[0].reportedUsageAttemptCount,
      positiveReasoningUsageAttemptCount: $reconciliation[0].positiveReasoningUsageAttemptCount
    },
    productionQualification: "MISSING"
  }' >"$evidence_directory/smoke.json"

printf 'MISSING: duplicate Pub/Sub delivery, forced process replacement, rollout, rollback, and teardown evidence require the protected lifecycle\n'
printf 'MISSING: the six-worker candidate remains unqualified for production\n'

#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

origin=${OSFO_RUNTIME_ORIGIN:-}
authentication_token=${OSFO_REFERENCE_AUTHENTICATION_TOKEN:-}
thread_id=${OSFO_REFERENCE_THREAD_ID:-}
database_url=${OSFO_DATABASE_URL:-}
project_id=${GCP_DEVELOPMENT_PROJECT_ID:-}
region=${GCP_REGION:-us-east4}
prefix=${OSFO_NAME_PREFIX:-osfo-dev}
device_count=${OSFO_SSE_DEVICE_COUNT:-4}
command_count=${OSFO_SSE_COMMAND_COUNT:-6}
command_interval_ms=${OSFO_SSE_COMMAND_INTERVAL_MS:-500}
drain_deadline_seconds=${OSFO_SSE_DRAIN_DEADLINE_SECONDS:-180}
request_timeout_seconds=${OSFO_SSE_REQUEST_TIMEOUT_SECONDS:-30}
capture_timeout_seconds=${OSFO_SSE_CAPTURE_TIMEOUT_SECONDS:-30}
capture_hook=${OSFO_SSE_CAPTURE_HOOK:-}
evidence_root=${OSFO_SSE_EVIDENCE_DIRECTORY:-tmp/issue-100-sse-qualification}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
evidence_directory="$evidence_root/$run_id"
work_directory=$(mktemp -d)
gate_file="$evidence_directory/gates.ndjson"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
started_epoch_ms=$(date +%s%3N)
finalized=0
declare -a stream_pids command_pids

mkdir -p "$evidence_directory/raw" "$evidence_directory/reconciliation" \
  "$evidence_directory/topology" "$evidence_directory/monitoring" \
  "$evidence_directory/captures"

record_gate() {
  local verdict=$1
  local gate=$2
  local detail=$3
  jq -cn --arg verdict "$verdict" --arg gate "$gate" --arg detail "$detail" \
    '{verdict:$verdict,gate:$gate,detail:$detail}' >>"$gate_file"
  printf '%s: %s, %s\n' "$verdict" "$gate" "$detail"
}

fail_gate() {
  record_gate FAIL "$1" "$2" >&2
  exit 1
}

missing_gate() {
  record_gate MISSING "$1" "$2"
}

pass_gate() {
  record_gate PASS "$1" "$2"
}

seal_evidence() {
  local exit_code=$?
  if ((finalized != 0)); then
    return
  fi
  finalized=1
  trap - EXIT
  set +e

  while IFS= read -r background_pid; do
    kill "$background_pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  wait 2>/dev/null || true

  local finished_at finished_epoch_ms elapsed_ms lane_verdict seal_status
  local manifest_device_count manifest_command_count manifest_command_interval_ms
  seal_status=0
  manifest_device_count=0
  manifest_command_count=0
  manifest_command_interval_ms=0
  [[ "$device_count" =~ ^[0-9]+$ ]] && manifest_device_count=$device_count
  [[ "$command_count" =~ ^[0-9]+$ ]] && manifest_command_count=$command_count
  [[ "$command_interval_ms" =~ ^[0-9]+$ ]] && manifest_command_interval_ms=$command_interval_ms
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  finished_epoch_ms=$(date +%s%3N)
  elapsed_ms=$((finished_epoch_ms - started_epoch_ms))

  for fixed_gate in \
    healthy_concurrent_stream_ceiling \
    breaking_point \
    several_account_matrix \
    deployed_slow_consumer_cut \
    deployed_lost_notification_hint \
    deployed_process_replacement \
    deployed_authorization_revocation \
    deployed_planned_runtime_drain \
    broker_backlog_drain \
    return_to_steady_state \
    production_topology \
    production_qualification; do
    if ! jq -e --arg gate "$fixed_gate" 'select(.gate == $gate)' "$gate_file" >/dev/null 2>&1; then
      record_gate MISSING "$fixed_gate" "outside the four-hour development demo lane" || seal_status=1
    fi
  done

  if jq -e 'select(.verdict == "FAIL")' "$gate_file" >/dev/null 2>&1; then
    lane_verdict=FAIL
  elif ((exit_code == 2)); then
    lane_verdict=MISSING
  elif ((exit_code != 0)); then
    lane_verdict=FAIL
  else
    lane_verdict=PASS
  fi

  jq -s --arg verdict "$lane_verdict" '{verdict:$verdict,gates:.}' "$gate_file" \
    >"$evidence_directory/verdicts.json" || seal_status=1
  jq -n \
    --arg schema_version "1" \
    --arg lane "issue-100-development-sse-demo" \
    --arg source_sha "$(git rev-parse HEAD)" \
    --arg source_status "$(git status --short --untracked-files=no)" \
    --arg origin "$origin" \
    --arg thread_id "$thread_id" \
    --arg started_at "$started_at" \
    --arg finished_at "$finished_at" \
    --argjson elapsed_ms "$elapsed_ms" \
    --argjson device_count "$manifest_device_count" \
    --argjson command_count "$manifest_command_count" \
    --argjson command_interval_ms "$manifest_command_interval_ms" \
    --arg verdict "$lane_verdict" \
    '{
      schemaVersion:($schema_version|tonumber),
      lane:$lane,
      sourceSha:$source_sha,
      sourceStatus:$source_status,
      target:{environment:"development",origin:$origin,threadId:$thread_id},
      workload:{deviceCount:$device_count,commandCount:$command_count,commandIntervalMs:$command_interval_ms},
      startedAt:$started_at,
      finishedAt:$finished_at,
      elapsedMs:$elapsed_ms,
      verdict:$verdict,
      productionQualification:"MISSING"
    }' >"$evidence_directory/manifest.json" || seal_status=1

  if ! (
    cd "$evidence_directory" || exit 1
    checksum_temp=$(mktemp .SHA256SUMS.XXXXXX)
    find . -type f ! -name 'SHA256SUMS' ! -name '.SHA256SUMS.*' -print0 | \
      sort -z | xargs -0 sha256sum >"$checksum_temp" || exit 1
    mv "$checksum_temp" SHA256SUMS || exit 1
    sha256sum --check SHA256SUMS >/dev/null
  ); then
    seal_status=1
  fi
  rm -rf "$work_directory"
  if ((seal_status != 0)); then
    printf 'FAIL: evidence bundle could not be sealed: %s\n' "$evidence_directory" >&2
    exit 1
  fi
  printf 'Evidence: %s\n' "$evidence_directory"
  exit "$exit_code"
}
trap seal_evidence EXIT

for dependency in curl jq awk rg sha256sum timeout; do
  command -v "$dependency" >/dev/null || fail_gate harness_dependency "$dependency is required"
done

missing_input=0
for input in origin authentication_token thread_id; do
  if [[ -z ${!input} ]]; then
    missing_gate runtime_input "$input"
    missing_input=1
  fi
done
if ((missing_input != 0)); then
  exit 2
fi
if [[ ! "$origin" =~ ^https:// ]]; then
  fail_gate runtime_origin "OSFO_RUNTIME_ORIGIN must use HTTPS"
fi
if [[ ! "$device_count" =~ ^[234]$ ]]; then
  fail_gate workload_contract "OSFO_SSE_DEVICE_COUNT must be 2, 3, or 4"
fi
if [[ ! "$command_count" =~ ^[1-9][0-9]*$ ]] || ((command_count < 2 || command_count > 24)); then
  fail_gate workload_contract "OSFO_SSE_COMMAND_COUNT must be between 2 and 24"
fi
if [[ ! "$command_interval_ms" =~ ^[1-9][0-9]*$ ]]; then
  fail_gate workload_contract "OSFO_SSE_COMMAND_INTERVAL_MS must be positive"
fi
if [[ ! "$drain_deadline_seconds" =~ ^[1-9][0-9]*$ ]]; then
  fail_gate workload_contract "OSFO_SSE_DRAIN_DEADLINE_SECONDS must be positive"
fi
if [[ ! "$request_timeout_seconds" =~ ^[1-9][0-9]*$ ]] ||
  [[ ! "$capture_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  fail_gate workload_contract "request and capture timeouts must be positive"
fi

authenticated_curl() {
  curl --silent --show-error --connect-timeout 10 --max-time "$request_timeout_seconds" \
    --config - "$@" <<EOF
header = "Authorization: Bearer $authentication_token"
EOF
}

capture_phase() {
  local phase=$1
  if [[ -z "$capture_hook" ]]; then
    return
  fi
  if [[ ! -x "$capture_hook" ]]; then
    fail_gate capture_hook "OSFO_SSE_CAPTURE_HOOK is not executable"
  fi
  mkdir -p "$evidence_directory/captures/$phase"
  if timeout --kill-after=5s "$capture_timeout_seconds" env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    DISPLAY="${DISPLAY:-}" \
    WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
    GCP_DEVELOPMENT_PROJECT_ID="$project_id" \
    GCP_REGION="$region" \
    OSFO_NAME_PREFIX="$prefix" \
    OSFO_RUNTIME_ORIGIN="$origin" \
    OSFO_REFERENCE_THREAD_ID="$thread_id" \
    "$capture_hook" "$phase" "$evidence_directory/captures/$phase" \
    >"$evidence_directory/captures/$phase/hook.log" 2>&1; then
    pass_gate "capture_$phase" "capture hook completed"
  else
    fail_gate "capture_$phase" "capture hook failed"
  fi
}

snapshot() {
  local destination=$1
  local timeout_seconds=${2:-$request_timeout_seconds}
  local status
  status=$(authenticated_curl --max-time "$timeout_seconds" \
    --output "$destination" --write-out '%{http_code}' \
    "$origin/v1/threads/$thread_id/snapshot")
  [[ "$status" == 200 ]] && jq -e --arg thread_id "$thread_id" \
    '.threadId == $thread_id and (.throughCursor | length > 0)' "$destination" >/dev/null
}

history() {
  local after_position=$1
  local through_position=$2
  local destination=$3
  local timeout_seconds=${4:-$request_timeout_seconds}
  local status
  status=$(authenticated_curl --max-time "$timeout_seconds" \
    --header 'accept: application/json' --output "$destination" \
    --write-out '%{http_code}' \
    "$origin/v1/threads/$thread_id/events?afterPosition=$after_position&throughPosition=$through_position&limit=1000")
  [[ "$status" == 200 ]] && jq -e --arg thread_id "$thread_id" \
    '.threadId == $thread_id and .hasMore == false' "$destination" >/dev/null
}

extract_thread_events() {
  local source=$1
  local destination=$2
  awk '
    /^event: thread_event$/ { wants_data = 1; next }
    wants_data == 1 && /^data: / { sub(/^data: /, ""); print; wants_data = 0 }
    /^$/ { wants_data = 0 }
  ' "$source" | jq -c . >"$destination"
}

encoded_cursor() {
  jq -rn --arg cursor "$1" '$cursor | @uri'
}

start_stream() {
  local name=$1
  local cursor=$2
  local encoded
  encoded=$(encoded_cursor "$cursor")
  curl --silent --show-error --connect-timeout 10 --config - --no-buffer \
    --max-time "$((drain_deadline_seconds + 60))" \
    --header 'accept: text/event-stream' \
    "$origin/v1/threads/$thread_id/events?after=$encoded" \
    >"$evidence_directory/raw/$name.sse" \
    2>"$evidence_directory/raw/$name.stderr" <<EOF &
header = "Authorization: Bearer $authentication_token"
EOF
  stream_pid=$!
}

wait_for_text() {
  local file=$1
  local text=$2
  local attempts=${3:-300}
  for _ in $(seq 1 "$attempts"); do
    if [[ -f "$file" ]] && rg --fixed-strings --quiet "$text" "$file"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

assert_observer_streams_live() {
  local index
  for index in $(seq 1 $((device_count - 1))); do
    if ! kill -0 "${stream_pids[$index]}" >/dev/null 2>&1; then
      return 1
    fi
  done
}

submit_command() {
  local name=$1
  local content=$2
  local idempotency_key body
  idempotency_key=$(< /proc/sys/kernel/random/uuid)
  body=$(jq -nc --arg key "$idempotency_key" --arg content "$content" \
    '{protocolVersion:1,idempotencyKey:$key,message:{content:$content}}')
  printf '%s\n' "$idempotency_key" >"$evidence_directory/raw/$name.idempotency-key"
  authenticated_curl --max-time 30 --request POST --header 'content-type: application/json' \
    --data "$body" --output "$evidence_directory/raw/$name.receipt.json" \
    --write-out '%{http_code}\t%{time_total}\n' \
    "$origin/v1/threads/$thread_id/messages" \
    >"$evidence_directory/raw/$name.http" \
    2>"$evidence_directory/raw/$name.stderr"
}

if ! snapshot "$evidence_directory/raw/snapshot-before.json"; then
  fail_gate authenticated_snapshot "deployed thread snapshot was unavailable"
fi
initial_position=$(jq -r '.throughPosition' "$evidence_directory/raw/snapshot-before.json")
if ((initial_position < device_count)); then
  missing_gate independent_signed_cursors "the seeded thread has fewer canonical events than devices"
  exit 2
fi
history_start=$((initial_position - device_count))
if ! history "$history_start" "$initial_position" "$evidence_directory/raw/history-before.json"; then
  fail_gate canonical_history "could not freeze the pre-load history cut"
fi
jq -c --argjson count "$device_count" \
  '[.events | .[-$count:][] | {cursor,position:.threadPosition}]' \
  "$evidence_directory/raw/history-before.json" >"$work_directory/device-cursors.json"
if [[ $(jq 'map(.cursor) | unique | length' "$work_directory/device-cursors.json") != "$device_count" ]]; then
  fail_gate independent_signed_cursors "the selected device cursors were not distinct"
fi

declare -a device_positions device_cursors
for index in $(seq 0 $((device_count - 1))); do
  device=$((index + 1))
  device_cursors[index]=$(jq -r ".[$index].cursor" "$work_directory/device-cursors.json")
  device_positions[index]=$(jq -r ".[$index].position" "$work_directory/device-cursors.json")
  start_stream "device-$device-before-disconnect" "${device_cursors[$index]}"
  stream_pids[index]=$stream_pid
done
for index in $(seq 0 $((device_count - 1))); do
  device=$((index + 1))
  if ! wait_for_text "$evidence_directory/raw/device-$device-before-disconnect.sse" \
    'event: caught_up'; then
    fail_gate concurrent_sse_connections "device $device did not reach the frozen live cut"
  fi
done
pass_gate concurrent_sse_connections "$device_count authenticated SSE streams reached one frozen live cut"
pass_gate independent_signed_cursors "$device_count distinct server-accepted cursors"
capture_phase before_load

if ! submit_command disconnect-probe \
  'Development SSE disconnect probe. Respond with a short, specific confirmation.'; then
  fail_gate sender_command "disconnect probe request failed"
fi
probe_status=$(cut -f1 "$evidence_directory/raw/disconnect-probe.http")
if [[ "$probe_status" != 200 ]] || ! jq -e --arg thread_id "$thread_id" \
  '.threadId == $thread_id and (.agentRunId | length > 0)' \
  "$evidence_directory/raw/disconnect-probe.receipt.json" >/dev/null; then
  fail_gate sender_command "disconnect probe was not durably accepted"
fi
probe_agent_run_id=$(jq -r '.agentRunId' "$evidence_directory/raw/disconnect-probe.receipt.json")
if ! wait_for_text "$evidence_directory/raw/device-1-before-disconnect.sse" "$probe_agent_run_id"; then
  fail_gate sender_disconnect "sender stream never observed the accepted response lifecycle"
fi
kill "${stream_pids[0]}" >/dev/null 2>&1 || true
wait "${stream_pids[0]}" 2>/dev/null || true
extract_thread_events "$evidence_directory/raw/device-1-before-disconnect.sse" \
  "$work_directory/device-1-before.ndjson"
if jq -s -e --arg run "$probe_agent_run_id" \
  'any(.[]; (.eventType == "AgentRunSucceeded" or .eventType == "AgentRunFailed" or .eventType == "AgentRunCanceled") and .payload.agentRunId == $run)' \
  "$work_directory/device-1-before.ndjson" >/dev/null; then
  fail_gate sender_disconnect "sender stream remained connected through the terminal event"
fi
pass_gate sender_disconnect "sender disconnected after admission and before its terminal event"
capture_phase after_disconnect
if ! assert_observer_streams_live; then
  fail_gate sustained_sse_connections "an observer stream closed before the measured load"
fi

load_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
load_started_epoch_ms=$(date +%s%3N)
for index in $(seq 1 "$command_count"); do
  submit_command "load-$index" "Development SSE qualification command $index of $command_count." &
  command_pids[index]=$!
  if ((index == command_count)); then
    offer_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    offer_ended_epoch_ms=$(date +%s%3N)
  else
    sleep "$(awk -v ms="$command_interval_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
  fi
done
if ! assert_observer_streams_live; then
  fail_gate sustained_sse_connections "an observer stream closed during the measured load"
fi
pass_gate sustained_sse_connections "$((device_count - 1)) observer streams remained live through the offer interval"
for index in $(seq 1 "$command_count"); do
  wait "${command_pids[$index]}" || true
done
offer_duration_ms=$((offer_ended_epoch_ms - load_started_epoch_ms))

printf 'name\thttp_status\tlatency_seconds\tagent_run_id\n' \
  >"$evidence_directory/command-outcomes.tsv"
successful_commands=0
failed_commands=0
for name in disconnect-probe $(seq -f 'load-%g' 1 "$command_count"); do
  status=$(cut -f1 "$evidence_directory/raw/$name.http" 2>/dev/null || printf 000)
  latency=$(cut -f2 "$evidence_directory/raw/$name.http" 2>/dev/null || printf 0)
  idempotency_key=$(<"$evidence_directory/raw/$name.idempotency-key")
  if [[ "$status" == 200 ]] && jq -e --arg key "$idempotency_key" --arg thread_id "$thread_id" \
    '.idempotencyKey == $key and .threadId == $thread_id and (.agentRunId | length > 0)' \
    "$evidence_directory/raw/$name.receipt.json" >/dev/null 2>&1; then
    agent_run_id=$(jq -r '.agentRunId' "$evidence_directory/raw/$name.receipt.json")
    successful_commands=$((successful_commands + 1))
    printf '%s\t%s\t%s\t%s\n' "$name" "$status" "$latency" "$agent_run_id" \
      >>"$evidence_directory/command-outcomes.tsv"
  else
    failed_commands=$((failed_commands + 1))
    printf '%s\t%s\t%s\t\n' "$name" "$status" "$latency" \
      >>"$evidence_directory/command-outcomes.tsv"
  fi
done
if ((failed_commands != 0)); then
  fail_gate modest_sustained_command_load "$failed_commands of $((command_count + 1)) commands failed"
fi
pass_gate modest_sustained_command_load "$successful_commands commands admitted at ${command_interval_ms}ms intervals with zero errors"

tail -n +2 "$evidence_directory/command-outcomes.tsv" | cut -f4 | sed '/^$/d' \
  >"$work_directory/agent-run-ids.txt"
drained=0
drain_deadline_epoch_ms=$((offer_ended_epoch_ms + drain_deadline_seconds * 1000))
while (($(date +%s%3N) < drain_deadline_epoch_ms)); do
  remaining_ms=$((drain_deadline_epoch_ms - $(date +%s%3N)))
  if ((remaining_ms <= 0)); then
    break
  fi
  remaining_seconds=$(((remaining_ms + 999) / 1000))
  poll_timeout_seconds=$request_timeout_seconds
  ((remaining_seconds < poll_timeout_seconds)) && poll_timeout_seconds=$remaining_seconds
  if ! snapshot "$evidence_directory/raw/snapshot-after.json" "$poll_timeout_seconds"; then
    sleep 0.5
    continue
  fi
  final_position=$(jq -r '.throughPosition' "$evidence_directory/raw/snapshot-after.json")
  remaining_ms=$((drain_deadline_epoch_ms - $(date +%s%3N)))
  if ((remaining_ms <= 0)); then
    break
  fi
  remaining_seconds=$(((remaining_ms + 999) / 1000))
  poll_timeout_seconds=$request_timeout_seconds
  ((remaining_seconds < poll_timeout_seconds)) && poll_timeout_seconds=$remaining_seconds
  if ! history "$history_start" "$final_position" \
    "$evidence_directory/raw/history-after.json" "$poll_timeout_seconds"; then
    sleep 0.5
    continue
  fi
  if jq -e --rawfile ids "$work_directory/agent-run-ids.txt" '
    . as $history
    | ($ids | split("\n") | map(select(length > 0))) as $runs
    | [$runs[] as $run
        | any($history.events[];
            (.eventType == "AgentRunSucceeded" or .eventType == "AgentRunFailed" or .eventType == "AgentRunCanceled")
            and .payload.agentRunId == $run)]
    | all
  ' "$evidence_directory/raw/history-after.json" >/dev/null; then
    drained=1
    break
  fi
  sleep 0.5
done
drained_epoch_ms=$(date +%s%3N)
drain_ms=$((drained_epoch_ms - offer_ended_epoch_ms))
if ((drained == 0 || drain_ms > drain_deadline_seconds * 1000)); then
  fail_gate command_backlog_drain "accepted commands did not reach terminal canonical events within ${drain_deadline_seconds}s"
fi
pass_gate command_backlog_drain "accepted commands reached terminal canonical events in ${drain_ms}ms"
capture_phase after_load

if ! jq -e --rawfile ids "$work_directory/agent-run-ids.txt" '
  . as $snapshot
  | ($ids | split("\n") | map(select(length > 0))) as $runs
  | [$runs[] as $run | all($snapshot.activeState[]?; .agentRunId != $run)]
  | all
' "$evidence_directory/raw/snapshot-after.json" >/dev/null; then
  fail_gate thread_state_quiescence "a measured AgentRun remained active after terminal drain"
fi
pass_gate thread_state_quiescence "all measured AgentRuns left the active Thread state"

for index in $(seq 1 $((device_count - 1))); do
  kill "${stream_pids[$index]}" >/dev/null 2>&1 || true
  wait "${stream_pids[$index]}" 2>/dev/null || true
done

max_replay_ms=0
for index in $(seq 0 $((device_count - 1))); do
  device=$((index + 1))
  before="$evidence_directory/raw/device-$device-before-disconnect.sse"
  extract_thread_events "$before" "$work_directory/device-$device-before.ndjson"
  last_cursor=$(jq -sr 'if length == 0 then "" else .[-1].cursor end' \
    "$work_directory/device-$device-before.ndjson")
  if [[ -z "$last_cursor" ]]; then
    fail_gate "device_${device}_convergence" "device emitted no canonical event"
  fi
  resume_started_ms=$(date +%s%3N)
  start_stream "device-$device-resume" "$last_cursor"
  resume_pid=$stream_pid
  if ! wait_for_text "$evidence_directory/raw/device-$device-resume.sse" \
    'event: caught_up'; then
    kill "$resume_pid" >/dev/null 2>&1 || true
    wait "$resume_pid" 2>/dev/null || true
    fail_gate "device_${device}_convergence" "resume did not reach caught_up"
  fi
  resume_finished_ms=$(date +%s%3N)
  kill "$resume_pid" >/dev/null 2>&1 || true
  wait "$resume_pid" 2>/dev/null || true
  replay_ms=$((resume_finished_ms - resume_started_ms))
  ((replay_ms > max_replay_ms)) && max_replay_ms=$replay_ms
  extract_thread_events "$evidence_directory/raw/device-$device-resume.sse" \
    "$work_directory/device-$device-resume.ndjson"
  cat "$work_directory/device-$device-before.ndjson" \
    "$work_directory/device-$device-resume.ndjson" \
    >"$evidence_directory/device-$device-canonical.ndjson"

  jq -c --argjson position "${device_positions[$index]}" \
    '[.events[] | select((.threadPosition | tonumber) > $position) |
      {eventId,threadPosition,cursor,eventType}]' \
    "$evidence_directory/raw/history-after.json" >"$work_directory/device-$device-expected.json"
  jq -sc '[.[] | {eventId,threadPosition,cursor,eventType}]' \
    "$evidence_directory/device-$device-canonical.ndjson" \
    >"$work_directory/device-$device-observed.json"
  if ! cmp --silent "$work_directory/device-$device-expected.json" \
    "$work_directory/device-$device-observed.json"; then
    fail_gate "device_${device}_convergence" "canonical replay had a gap, duplicate, or ordering violation"
  fi
  pass_gate "device_${device}_convergence" "exact canonical history matched after resume"
done
pass_gate ordering_duplicates_and_gaps "all device event-id and position sequences exactly matched canonical history"

terminal_failures=$(jq --rawfile ids "$work_directory/agent-run-ids.txt" '
  ($ids | split("\n") | map(select(length > 0))) as $runs
  | [.events[] as $event
      | select(
          ($event.eventType == "AgentRunFailed" or $event.eventType == "AgentRunCanceled")
          and (($runs | index($event.payload.agentRunId)) != null)
        )
      | $event] | length
' "$evidence_directory/raw/history-after.json")
if ((terminal_failures != 0)); then
  fail_gate command_outcomes "$terminal_failures accepted AgentRuns failed or were canceled"
fi
pass_gate command_outcomes "all accepted AgentRuns reached AgentRunSucceeded"

if [[ -n "$database_url" ]]; then
  reconciliation_failures=0
  while IFS= read -r agent_run_id; do
    if ! timeout --kill-after=5s "$request_timeout_seconds" \
      env OSFO_DATABASE_URL="$database_url" \
      infra/tests/development-runtime-reconciliation.sh \
      "$agent_run_id" "$evidence_directory/reconciliation/$agent_run_id.json" ||
      ! jq -e '.verdict == "PASS"' "$evidence_directory/reconciliation/$agent_run_id.json" \
        >/dev/null 2>&1; then
      reconciliation_failures=$((reconciliation_failures + 1))
    fi
  done <"$work_directory/agent-run-ids.txt"
  if ((reconciliation_failures != 0)); then
    fail_gate authoritative_reconciliation "$reconciliation_failures AgentRuns failed reconciliation"
  fi
  pass_gate authoritative_reconciliation "$successful_commands sanitized AgentRun graphs reconciled"
else
  missing_gate authoritative_reconciliation "OSFO_DATABASE_URL was not supplied through an approved private proxy"
fi

monitoring_status=1
if [[ -n "$project_id" ]] && command -v gcloud >/dev/null; then
  set +e
  timeout --kill-after=5s "$request_timeout_seconds" gcloud run services describe "$prefix-transport" --project="$project_id" --region="$region" \
    --format=json >"$evidence_directory/topology/transport.json"
  transport_status=$?
  timeout --kill-after=5s "$request_timeout_seconds" gcloud beta run worker-pools describe "$prefix-relay" --project="$project_id" --region="$region" \
    --format=json >"$evidence_directory/topology/relay.json"
  relay_status=$?
  timeout --kill-after=5s "$request_timeout_seconds" gcloud beta run worker-pools describe "$prefix-agentrun" --project="$project_id" --region="$region" \
    --format=json >"$evidence_directory/topology/agentrun.json"
  agentrun_status=$?
  timeout --kill-after=5s "$request_timeout_seconds" gcloud pubsub subscriptions describe "$prefix-agentruns" --project="$project_id" \
    --format=json >"$evidence_directory/topology/subscription.json"
  subscription_status=$?
  timeout --kill-after=5s "$request_timeout_seconds" gcloud sql instances describe "$prefix-postgres" --project="$project_id" \
    --format=json >"$evidence_directory/topology/database.json"
  database_status=$?
  access_token=$(timeout --kill-after=5s "$request_timeout_seconds" \
    gcloud auth print-access-token \
    2>"$work_directory/access-token.error")
  token_status=$?
  if ((token_status == 0)); then
    monitoring_status=0
    for metric in \
      run.googleapis.com/request_count \
      run.googleapis.com/container/cpu/utilizations \
      run.googleapis.com/container/memory/utilizations \
      pubsub.googleapis.com/subscription/num_undelivered_messages \
      pubsub.googleapis.com/subscription/oldest_unacked_message_age \
      cloudsql.googleapis.com/database/cpu/utilization \
      cloudsql.googleapis.com/database/memory/utilization \
      cloudsql.googleapis.com/database/postgresql/num_backends; do
      safe_name=${metric//\//__}
      case "$metric" in
        run.googleapis.com/*)
          filter="metric.type=\"$metric\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$prefix-transport\""
          ;;
        pubsub.googleapis.com/*)
          filter="metric.type=\"$metric\" AND resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"$prefix-agentruns\""
          ;;
        *)
          filter="metric.type=\"$metric\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=ends_with(\"$prefix-postgres\")"
          ;;
      esac
      printf 'header = "Authorization: Bearer %s"\n' "$access_token" | \
        curl --config - --fail --silent --show-error --connect-timeout 10 \
          --max-time "$request_timeout_seconds" --get \
          "https://monitoring.googleapis.com/v3/projects/$project_id/timeSeries" \
          --data-urlencode "filter=$filter" \
          --data-urlencode "interval.startTime=$load_started_at" \
          --data-urlencode "interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          --data-urlencode 'view=FULL' --data-urlencode 'pageSize=100000' \
          >"$evidence_directory/monitoring/$safe_name.json" || monitoring_status=1
    done
  fi
  unset access_token
  set -e
  if ((transport_status == 0 && relay_status == 0 && agentrun_status == 0 &&
    subscription_status == 0 && database_status == 0)); then
    pass_gate topology_snapshot "transport, worker pools, Pub/Sub, and PostgreSQL descriptions captured"
  else
    missing_gate topology_snapshot "one or more optional Cloud descriptions were unavailable"
  fi
  for measurement in "$evidence_directory"/monitoring/*.json; do
    if [[ ! -f "$measurement" ]] || ! jq -e '(.timeSeries // []) | length > 0' \
      "$measurement" >/dev/null 2>&1; then
      monitoring_status=1
    fi
  done
  if ((monitoring_status == 0)); then
    pass_gate resource_measurements "non-empty backlog, CPU, memory, and PostgreSQL windows captured"
  else
    missing_gate resource_measurements "one or more optional monitoring windows were unavailable or empty"
  fi
else
  missing_gate topology_snapshot "GCP_DEVELOPMENT_PROJECT_ID or gcloud was unavailable"
  missing_gate resource_measurements "GCP_DEVELOPMENT_PROJECT_ID or gcloud was unavailable"
fi

if [[ -z "$capture_hook" ]]; then
  missing_gate screenshots_or_recording "set OSFO_SSE_CAPTURE_HOOK to capture the four lifecycle phases"
else
  capture_phase after_drain
fi

jq -n \
  --arg started_at "$load_started_at" \
  --arg offer_ended_at "$offer_ended_at" \
  --arg final_position "$final_position" \
  --argjson concurrent_sse_connections "$device_count" \
  --argjson sustained_observer_connections "$((device_count - 1))" \
  --argjson command_count "$successful_commands" \
  --argjson command_errors "$failed_commands" \
  --argjson load_command_count "$command_count" \
  --argjson offer_duration_ms "$offer_duration_ms" \
  --argjson drain_ms "$drain_ms" \
  --argjson replay_latency_ms "$max_replay_ms" \
  '{
    schemaVersion:1,
    lane:"issue-100-development-sse-demo",
    startedAt:$started_at,
    offerEndedAt:$offer_ended_at,
    peakConcurrentSseConnections:$concurrent_sse_connections,
    sustainedObserverSseConnections:$sustained_observer_connections,
    distinctDeviceCursors:$concurrent_sse_connections,
    commandCount:$command_count,
    loadCommandCount:$load_command_count,
    commandErrors:$command_errors,
    errorRate:($command_errors / $command_count),
    offerDurationMs:$offer_duration_ms,
    offeredCommandsPerSecond:(($load_command_count * 1000) / $offer_duration_ms),
    streamGaps:0,
    streamDuplicates:0,
    orderingViolations:0,
    converged:true,
    finalThreadPosition:$final_position,
    replayLatencyMs:$replay_latency_ms,
    commandTerminalDrainMs:$drain_ms,
    brokerBacklogDrainMs:"MISSING",
    returnToSteadyState:"MISSING",
    healthyConcurrentStreamCeiling:"MISSING",
    breakingPoint:"MISSING",
    productionQualification:"MISSING"
  }' >"$evidence_directory/summary.json"

pass_gate development_sse_demo_lane "bounded multi-device load, resume, convergence, and drain checks completed"

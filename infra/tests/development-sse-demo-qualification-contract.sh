#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

script=infra/tests/development-sse-demo-qualification.sh

bash -n "$script"
rg --fixed-strings --quiet 'OSFO_RUNTIME_ORIGIN' "$script"
rg --fixed-strings --quiet 'OSFO_REFERENCE_AUTHENTICATION_TOKEN' "$script"
rg --fixed-strings --quiet 'OSFO_REFERENCE_THREAD_ID' "$script"
rg --fixed-strings --quiet 'header = "Authorization: Bearer $authentication_token"' "$script"
rg --fixed-strings --quiet 'sender disconnected after admission and before its terminal event' "$script"
rg --fixed-strings --quiet 'canonical replay had a gap, duplicate, or ordering violation' "$script"
[[ $(rg --fixed-strings --count '{eventId,threadPosition,eventType}' "$script") == 2 ]]
if rg --fixed-strings --quiet '{eventId,threadPosition,cursor,eventType}' "$script"; then
  printf 'qualification harness must not require reissued signed cursor bytes to be stable\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'accepted commands reached terminal canonical events in ${drain_ms}ms' "$script"
rg --fixed-strings --quiet 'healthy_concurrent_stream_ceiling' "$script"
rg --fixed-strings --quiet 'breaking_point' "$script"
rg --fixed-strings --quiet 'production_qualification' "$script"
rg --fixed-strings --quiet "find . -type f ! -name 'SHA256SUMS'" "$script"
rg --fixed-strings --quiet 'sha256sum --check SHA256SUMS' "$script"
rg --fixed-strings --quiet 'OSFO_SSE_CAPTURE_HOOK' "$script"
rg --fixed-strings --quiet 'timeout --kill-after=5s "$capture_timeout_seconds" env -i' "$script"
rg --fixed-strings --quiet 'sha256sum >"$checksum_temp" || exit 1' "$script"
rg --fixed-strings --quiet 'drain_deadline_epoch_ms=$((offer_ended_epoch_ms + drain_deadline_seconds * 1000))' "$script"
[[ $(rg --fixed-strings --count 'if ((remaining_ms <= 0)); then' "$script") == 2 ]]
rg --fixed-strings --quiet 'drain_ms > drain_deadline_seconds * 1000' "$script"
rg --fixed-strings --quiet 'commandTerminalDrainMs:$drain_ms' "$script"
rg --fixed-strings --quiet 'brokerBacklogDrainMs:"MISSING"' "$script"
rg --fixed-strings --quiet '(.timeSeries // []) | length > 0' "$script"
rg --fixed-strings --quiet 'offer_ended_epoch_ms=$(date +%s%3N)' "$script"
if rg --fixed-strings --quiet 'all($runs[] as $run;' "$script"; then
  printf 'qualification harness must use a jq-compatible run aggregation form\n' >&2
  exit 1
fi

if rg --quiet 'echo .*authentication_token|printf .*authentication_token|set -x' "$script"; then
  printf 'qualification harness must not print the bearer\n' >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
printf '%s\n' run-1 run-2 >"$scratch/run-ids"
jq -e --rawfile ids "$scratch/run-ids" '
  . as $history
  | ($ids | split("\n") | map(select(length > 0))) as $runs
  | [$runs[] as $run
      | any($history.events[];
          (.eventType == "AgentRunSucceeded" or .eventType == "AgentRunFailed" or .eventType == "AgentRunCanceled")
          and .payload.agentRunId == $run)]
  | all
' <<'JSON' >/dev/null
{"events":[
  {"eventType":"AgentRunSucceeded","payload":{"agentRunId":"run-1"}},
  {"eventType":"AgentRunFailed","payload":{"agentRunId":"run-2"}}
]}
JSON
jq -e --rawfile ids "$scratch/run-ids" '
  . as $snapshot
  | ($ids | split("\n") | map(select(length > 0))) as $runs
  | [$runs[] as $run | all($snapshot.activeState[]?; .agentRunId != $run)]
  | all
' <<'JSON' >/dev/null
{"activeState":[{"agentRunId":"another-run"}]}
JSON
contract_bearer=contract-bearer-must-not-be-sealed
set +e
env -u OSFO_RUNTIME_ORIGIN \
  OSFO_REFERENCE_AUTHENTICATION_TOKEN="$contract_bearer" \
  OSFO_REFERENCE_THREAD_ID=6ef239bd-3f04-4c77-8976-1171e75ea0ab \
  OSFO_SSE_EVIDENCE_DIRECTORY="$scratch/evidence" \
  "$script" >"$scratch/stdout" 2>"$scratch/stderr"
result=$?
set -e
if ((result != 2)); then
  printf 'missing-input qualification must exit 2, got %s\n' "$result" >&2
  exit 1
fi
run_directory=$(find "$scratch/evidence" -mindepth 1 -maxdepth 1 -type d -print -quit)
jq -e '
  .verdict == "MISSING"
  and any(.gates[]; .gate == "runtime_input" and .verdict == "MISSING")
  and any(.gates[]; .gate == "production_qualification" and .verdict == "MISSING")
' "$run_directory/verdicts.json" >/dev/null
if rg --fixed-strings --quiet "$contract_bearer" "$run_directory" "$scratch/stdout" "$scratch/stderr"; then
  printf 'qualification harness sealed or printed the bearer\n' >&2
  exit 1
fi
(cd "$run_directory" && sha256sum --check SHA256SUMS >/dev/null)

set +e
OSFO_RUNTIME_ORIGIN=https://qualification.invalid \
  OSFO_REFERENCE_AUTHENTICATION_TOKEN="$contract_bearer" \
  OSFO_REFERENCE_THREAD_ID=6ef239bd-3f04-4c77-8976-1171e75ea0ab \
  OSFO_SSE_COMMAND_COUNT=not-a-number \
  OSFO_SSE_EVIDENCE_DIRECTORY="$scratch/invalid-evidence" \
  "$script" >"$scratch/invalid-stdout" 2>"$scratch/invalid-stderr"
result=$?
set -e
if ((result != 1)); then
  printf 'invalid-workload qualification must exit 1, got %s\n' "$result" >&2
  exit 1
fi
invalid_run_directory=$(find "$scratch/invalid-evidence" -mindepth 1 -maxdepth 1 -type d -print -quit)
jq -e '.verdict == "FAIL" and .workload.commandCount == 0' \
  "$invalid_run_directory/manifest.json" >/dev/null
(cd "$invalid_run_directory" && sha256sum --check SHA256SUMS >/dev/null)
if rg --fixed-strings --quiet "$contract_bearer" "$invalid_run_directory" \
  "$scratch/invalid-stdout" "$scratch/invalid-stderr"; then
  printf 'invalid-workload evidence sealed or printed the bearer\n' >&2
  exit 1
fi

printf 'Development SSE demo qualification contract assertions passed\n'

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
inspector="$script_dir/inspect-account-http-log"

exact_counts="$($inspector "$script_dir/fixtures/account-http-exact.log")"
jq --exit-status '
  .presentationRequests == 1 and .presentationSuccesses == 1 and
  .deleteRequests == 1 and .deleteSuccesses == 1
' <<<"$exact_counts" >/dev/null

if "$inspector" "$script_dir/fixtures/account-http-retried.log" >/dev/null 2>&1; then
  printf 'A 503 followed by 200 must fail the exact-once verifier contract\n' >&2
  exit 1
fi

replay_counts="$($inspector "$script_dir/fixtures/account-http-replay.log" retained-replay)"
jq --exit-status '
  .presentationRequests == 1 and .presentationSuccesses == 1 and
  .deleteRequests == 2 and .deleteSuccesses == 2
' <<<"$replay_counts" >/dev/null

if "$inspector" "$script_dir/fixtures/account-http-exact.log" retained-replay >/dev/null 2>&1; then
  printf 'A retained replay proof requires two successful DELETE requests\n' >&2
  exit 1
fi

expiry_counts="$($inspector "$script_dir/fixtures/account-http-expiry-refresh.log" expiry-refresh)"
jq --exit-status '
  .presentationRequests == 2 and .presentationSuccesses == 2 and
  .deleteRequests == 1 and .deleteSuccesses == 1
' <<<$expiry_counts >/dev/null

if "$inspector" "$script_dir/fixtures/account-http-exact.log" expiry-refresh >/dev/null 2>&1; then
  printf 'An expiry-refresh proof requires two successful presentations\n' >&2
  exit 1
fi

# Exercise the same final state assertion used after the real deletion observer.
terminal_state="$(<"$script_dir/fixtures/account-deletion-terminal-state.json")"
assert_terminal_state() {
  jq --exit-status --argjson presentationRequests "$1" --argjson deleteRequests "$2" \
    --from-file "$script_dir/account-deletion-state.jq" >/dev/null
}
assert_terminal_state 2 1 <<<"$terminal_state"
replay_state="$(jq --argjson accountHttp "$replay_counts" '.accountHttp = $accountHttp' <<<"$terminal_state")"
assert_terminal_state 1 2 <<<"$replay_state"
if assert_terminal_state 1 2 <<<"$terminal_state" ||
  assert_terminal_state 2 1 <<<"$replay_state"; then
  printf 'The final observer must enforce each drive\047s exact request counts\n' >&2
  exit 1
fi
for changed_state in \
  '.accountHttp.presentationRequests = 3' \
  '.accountHttp.presentationSuccesses = 1' \
  '.accountHttp.deleteRequests = 2' \
  '.accountHttp.deleteSuccesses = 0' \
  '.userExists = true' \
  '.agentRuntime.registered = true' \
  '.targetR2Exists = true' \
  '.unrelatedR2Exists = false'; do
  if jq "$changed_state" <<<"$terminal_state" | assert_terminal_state 2 1; then
    printf 'The final observer accepted invalid terminal state: %s\n' "$changed_state" >&2
    exit 1
  fi
done

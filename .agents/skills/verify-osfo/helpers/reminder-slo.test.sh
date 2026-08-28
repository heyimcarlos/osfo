#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
slo="$script_dir/reminder-slo.mjs"

normalized="$(bun "$slo" normalize '2026-08-27T20:00:00-04:00')"
[[ "$normalized" == '2026-08-28T00:00:00.000Z' ]]

bun "$slo" assert '2026-08-28T00:00:00Z' '2026-08-28T00:00:00Z' \
  | jq --exit-status '.elapsedMilliseconds == 0' >/dev/null
bun "$slo" assert '2026-08-28T00:00:00Z' '2026-08-28T00:01:30Z' \
  | jq --exit-status '.elapsedMilliseconds == 90000' >/dev/null
bun "$slo" assert-handler '2026-08-28T00:00:00Z' '2026-08-28T00:01:00Z' \
  | jq --exit-status '.elapsedMilliseconds == 60000 and .maximumMilliseconds == 60000' >/dev/null

if bun "$slo" assert '2026-08-28T00:00:00Z' '2026-08-27T23:59:59Z' >/dev/null 2>&1; then
  printf 'acceptance before the nominal due must fail\n' >&2
  exit 1
fi
if bun "$slo" assert '2026-08-28T00:00:00Z' '2026-08-28T00:01:30.001Z' >/dev/null 2>&1; then
  printf 'acceptance after 90 seconds must fail\n' >&2
  exit 1
fi
if bun "$slo" assert-handler '2026-08-28T00:00:00Z' '2026-08-28T00:01:00.001Z' >/dev/null 2>&1; then
  printf 'handler commit after 60 seconds must fail\n' >&2
  exit 1
fi
if bun "$slo" normalize 'tomorrow morning' >/dev/null 2>&1; then
  printf 'ambiguous due input must fail\n' >&2
  exit 1
fi

printf 'Reminder SLO verifier checks passed\n'

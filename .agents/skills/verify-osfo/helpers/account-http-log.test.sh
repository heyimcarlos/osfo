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

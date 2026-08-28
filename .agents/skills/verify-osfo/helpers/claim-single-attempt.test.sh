#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -r "$test_dir"' EXIT

"$script_dir/claim-single-attempt" "$test_dir/telegram-attempt"
if output="$($script_dir/claim-single-attempt "$test_dir/telegram-attempt" 2>&1)"; then
  printf 'A second Telegram-link attempt must fail\n' >&2
  exit 1
fi
if [[ "$output" != 'The run already used its single Telegram-link attempt' ]]; then
  printf 'Unexpected second-attempt error: %s\n' "$output" >&2
  exit 1
fi

printf 'single Telegram-link attempt verifier checks passed\n'

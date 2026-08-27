#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../../.." && pwd)"
run_id="artifact-guard-$$"
artifact_dir="$repo_root/artifacts/verification/osfo/$run_id"
state_dir="${TMPDIR:-/tmp}/osfo-verification/$run_id"
stale_log="$artifact_dir/logs/worker.log"

if [[ -e "$artifact_dir" || -e "$state_dir" ]]; then
  printf 'Test run identity already exists: %s\n' "$run_id" >&2
  exit 1
fi

cleanup() {
  rm -r "$artifact_dir" "$state_dir" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$artifact_dir/logs"
printf '%s\n' \
  'GET /v1/account/deletion-action 200' \
  'DELETE /v1/account 200' >"$stale_log"
before="$(sha256sum "$stale_log")"

if output="$("$script_dir/control-osfo" start "$run_id" 2>&1)"; then
  printf 'A reused evidence directory must prevent verifier startup\n' >&2
  exit 1
fi

if [[ "$output" != *"Preserved evidence already exists for run $run_id. Choose a fresh run ID."* ]]; then
  printf 'Expected a clear fresh-run ID error, got: %s\n' "$output" >&2
  exit 1
fi
if [[ -e "$state_dir" ]]; then
  printf 'Rejected startup must not create run state\n' >&2
  exit 1
fi
if [[ "$(sha256sum "$stale_log")" != "$before" ]]; then
  printf 'Rejected startup must not alter preserved Worker logs\n' >&2
  exit 1
fi

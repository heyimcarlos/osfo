#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${MODEL_SECRET:?MODEL_SECRET is required}"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
payload_file=$scratch/payload
error_file=$scratch/error

set +e
gcloud secrets versions access latest \
  --secret="$MODEL_SECRET" --project="$PROJECT_ID" \
  >"$payload_file" 2>"$error_file"
access_status=$?
set -e

if ((access_status == 0)); then
  printf 'FAIL: denied secret-version access unexpectedly succeeded\n' >&2
  exit 1
fi
if [[ -s "$payload_file" ]]; then
  printf 'FAIL: denied secret-version access emitted a payload\n' >&2
  exit 1
fi

printf 'PASS unintended_secret_accessor_denied_without_payload\n'

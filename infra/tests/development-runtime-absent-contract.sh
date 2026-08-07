#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
scratch=$(mktemp -d)
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

cp "$repo_root/infra/tests/fixtures/development-runtime-absent/gcloud" "$scratch/gcloud"
chmod +x "$scratch/gcloud"

status=0
output=$(env \
  PATH="$scratch:$PATH" \
  GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
  GCP_REGION=us-east4 \
  OSFO_NAME_PREFIX=osfo-dev \
  "$repo_root/infra/tests/development-runtime-absent.sh" 2>&1) || status=$?

if ((status == 0)); then
  printf 'FAIL: a not-found authentication or project failure must not prove absence\n' >&2
  exit 1
fi
if grep -q 'PASS:' <<<"$output"; then
  printf 'FAIL: failed identity verification must not emit PASS evidence\n' >&2
  exit 1
fi
if grep -q 'mock-sensitive-not-found-diagnostic' <<<"$output"; then
  printf 'FAIL: raw provider diagnostics must not enter absence evidence\n' >&2
  exit 1
fi

printf 'PASS: development runtime absence proof fails closed without provider diagnostics\n'

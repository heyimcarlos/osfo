#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -r '.project_id' "$varset")
artifact_bucket=$(jq -r '.artifact_bucket_name' "$varset")
expected_account=${FOUNDATION_SERVICE_ACCOUNT:?FOUNDATION_SERVICE_ACCOUNT is required}
effective_account=${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}

if [[ "$effective_account" != "$expected_account" ]]; then
  printf 'FAIL: artifact cleanup requires foundation identity %s, got %s\n' \
    "$expected_account" "$effective_account" >&2
  exit 1
fi
if [[ ! "$artifact_bucket" =~ ^osfo-development-artifacts-[0-9]+$ ]]; then
  printf 'FAIL: refusing unreviewed artifact cleanup bucket %s\n' "$artifact_bucket" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
if ! gcloud storage buckets describe "gs://$artifact_bucket" --project="$project_id" \
  >"$scratch/bucket.json" 2>"$scratch/bucket.error"; then
  if grep -Eq '404|not found|does not exist' "$scratch/bucket.error"; then
    printf 'PASS: disposable artifact bucket is already absent\n'
    exit 0
  fi
  printf 'FAIL: artifact bucket lookup failed closed\n' >&2
  cat "$scratch/bucket.error" >&2
  exit 1
fi

if ! gcloud storage ls --all-versions --recursive "gs://$artifact_bucket/**" \
  >"$scratch/objects" 2>"$scratch/objects.error"; then
  if grep -Eqi 'matched no objects|no URLs matched|matched no URLs' \
    "$scratch/objects.error"; then
    printf 'PASS: disposable artifact bucket is empty\n'
    exit 0
  fi
  printf 'FAIL: artifact object listing failed closed\n' >&2
  cat "$scratch/objects.error" >&2
  exit 1
fi

while IFS= read -r object_uri; do
  [[ -n "$object_uri" ]] || continue
  if [[ "$object_uri" != "gs://$artifact_bucket/sha256/"* ]]; then
    printf 'FAIL: refusing unexpected artifact object %s\n' "$object_uri" >&2
    exit 1
  fi
  gcloud storage rm "$object_uri" >/dev/null
done <"$scratch/objects"

remaining_status=0
gcloud storage ls --all-versions --recursive "gs://$artifact_bucket/**" \
  >"$scratch/remaining" 2>"$scratch/remaining.error" || remaining_status=$?
if ((remaining_status != 0)); then
  if grep -Eqi 'matched no objects|no URLs matched|matched no URLs' \
    "$scratch/remaining.error"; then
    : >"$scratch/remaining"
    remaining_status=0
  fi
fi
if ((remaining_status != 0)); then
  printf 'FAIL: final artifact object listing failed closed\n' >&2
  cat "$scratch/remaining.error" >&2
  exit 1
fi
if grep -F 'gs://' "$scratch/remaining" >/dev/null; then
  printf 'FAIL: artifact cleanup left objects behind\n' >&2
  exit 1
fi

printf 'PASS: foundation recovery removed only reviewed content-addressed artifact objects\n'

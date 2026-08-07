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
normalize_listing() {
  local source_file=$1
  local destination_file=$2

  : >"$destination_file"
  if ! grep -q '[^[:space:]]' "$source_file"; then
    printf 'FAIL: artifact object listing omitted the required bucket root metadata\n' >&2
    return 1
  fi
  if ! jq -e \
    --arg bucket_root "gs://$artifact_bucket" \
    --arg bucket_prefix "gs://$artifact_bucket/" '
    type == "array"
    and ([.[] | select(.type == "unknown")] | length) == 1
    and all(.[];
      (.type == "cloud_object" and (.url | type == "string"))
      or (.type == "unknown" and (.url == $bucket_root or .url == ($bucket_root + "/")))
      or (.type == "prefix" and (.url | type == "string") and (.url | startswith($bucket_prefix)))
    )
  ' "$source_file" >/dev/null; then
    printf 'FAIL: artifact object listing was not valid structured object metadata\n' >&2
    return 1
  fi
  jq -r '.[] | select(.type == "cloud_object") | .url' \
    "$source_file" >"$destination_file"
}

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

if ! gcloud storage ls --all-versions --recursive --json "gs://$artifact_bucket" \
  >"$scratch/objects" 2>"$scratch/objects.error"; then
  printf 'FAIL: artifact object listing failed closed\n' >&2
  cat "$scratch/objects.error" >&2
  exit 1
fi
normalize_listing "$scratch/objects" "$scratch/object-uris"

while IFS= read -r object_uri; do
  if [[ ! "$object_uri" =~ ^gs://$artifact_bucket/sha256/[0-9a-f]{64}#[0-9]+$ ]]; then
    printf 'FAIL: refusing unexpected artifact object %s\n' "$object_uri" >&2
    exit 1
  fi
  gcloud storage rm "$object_uri" >/dev/null
done <"$scratch/object-uris"

remaining_status=0
gcloud storage ls --all-versions --recursive --json "gs://$artifact_bucket" \
  >"$scratch/remaining" 2>"$scratch/remaining.error" || remaining_status=$?
if ((remaining_status != 0)); then
  printf 'FAIL: final artifact object listing failed closed\n' >&2
  cat "$scratch/remaining.error" >&2
  exit 1
fi
normalize_listing "$scratch/remaining" "$scratch/remaining-uris"
if [[ -s "$scratch/remaining-uris" ]]; then
  remaining_uri=$(head -n 1 "$scratch/remaining-uris")
  printf 'FAIL: artifact cleanup left object %s behind\n' "$remaining_uri" >&2
  exit 1
fi

if [[ ! -s "$scratch/object-uris" ]]; then
  printf 'PASS: disposable artifact bucket is empty\n'
else
  printf 'PASS: foundation recovery removed only reviewed content-addressed artifact objects\n'
fi

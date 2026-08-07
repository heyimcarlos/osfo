#!/usr/bin/env bash

set -euo pipefail

source_file=${1:?source evidence file is required}
bucket=${2:?evidence bucket is required}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

evidence_sha=$(sha256sum "$source_file" | cut -d' ' -f1)
evidence_uri="gs://$bucket/roots/development/platform/sha256/$evidence_sha.json"

lookup_status=0
gcloud storage objects describe "$evidence_uri" \
  >"$scratch/object.json" 2>"$scratch/object.error" || lookup_status=$?
if ((lookup_status == 0)); then
  gcloud storage cp "$evidence_uri" "$scratch/existing.json" >/dev/null
  cmp "$source_file" "$scratch/existing.json"
elif grep -Eqi '404|not found|does not exist' "$scratch/object.error"; then
  gcloud storage cp --if-generation-match=0 "$source_file" "$evidence_uri" >/dev/null
else
  printf 'FAIL: development evidence lookup failed closed\n' >&2
  cat "$scratch/object.error" >&2
  exit 1
fi

printf '%s\n' "$evidence_sha"

#!/usr/bin/env bash

set -euo pipefail

source_file=${1:?source evidence file is required}
bucket=${2:?evidence bucket is required}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

evidence_sha=$(sha256sum "$source_file" | cut -d' ' -f1)
evidence_uri="gs://$bucket/roots/development/platform/sha256/$evidence_sha.json"

if gcloud storage objects describe "$evidence_uri" >/dev/null 2>&1; then
  gcloud storage cp "$evidence_uri" "$scratch/existing.json" >/dev/null
  cmp "$source_file" "$scratch/existing.json"
else
  gcloud storage cp --if-generation-match=0 "$source_file" "$evidence_uri" >/dev/null
fi

printf '%s\n' "$evidence_sha"

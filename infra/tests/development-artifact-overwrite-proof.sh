#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  printf 'usage: %s ARTIFACT_FILE ARTIFACT_URI\n' "$0" >&2
  exit 64
fi

artifact_file=$1
artifact_uri=$2
if [[ ! -f "$artifact_file" || ! -r "$artifact_file" ]]; then
  printf 'FAIL: artifact source must be a readable regular file\n' >&2
  exit 1
fi
scratch=$(mktemp -d)
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

describe_object() {
  local destination=$1

  if ! gcloud storage objects describe "$artifact_uri" \
    --format='json(generation,md5_hash,crc32c_hash,size)' >"$destination"; then
    fail 'unable to describe content-addressed artifact metadata'
  fi
  if ! jq -e '
    (.generation | tostring | test("^[0-9]+$"))
    and (.md5_hash | type == "string" and length > 0)
    and (.crc32c_hash | type == "string" and length > 0)
    and (.size | tostring | test("^[0-9]+$"))
  ' "$destination" >/dev/null; then
    fail 'content-addressed artifact metadata is incomplete'
  fi
}

normalize_object_metadata() {
  jq -cS \
    '{generation: (.generation | tostring), md5_hash, crc32c_hash, size: (.size | tostring)}' \
    "$1"
}

describe_object "$scratch/object-before.json"
original_metadata=$(normalize_object_metadata "$scratch/object-before.json")
original_generation=$(jq -r '.generation | tostring' "$scratch/object-before.json")

if gcloud storage cp "$artifact_file" "$artifact_uri" >/dev/null 2>&1; then
  fail 'IAM allowed an unconditional content-addressed artifact overwrite'
fi

describe_object "$scratch/object-after.json"
current_metadata=$(normalize_object_metadata "$scratch/object-after.json")
if [[ "$current_metadata" != "$original_metadata" ]]; then
  fail 'content-addressed artifact generation or digest metadata changed after denied overwrite'
fi

if ! gcloud storage ls --all-versions --json "$artifact_uri" \
  >"$scratch/generations.json"; then
  fail 'unable to list content-addressed artifact generations'
fi
if ! jq -e \
  --arg generation "$original_generation" \
  --arg versioned_uri "$artifact_uri#$original_generation" '
  type == "array"
  and length == 1
  and (.[0] | keys | sort) == ["metadata", "type", "url"]
  and .[0].type == "cloud_object"
  and .[0].url == $versioned_uri
  and (.[0].metadata | type) == "object"
  and (.[0].metadata.generation | tostring) == $generation
' "$scratch/generations.json" >/dev/null; then
  fail 'content-addressed artifact must retain exactly its original generation'
fi

printf '%s\n' \
  'PASS: artifact overwrite denied with unchanged digest metadata and exactly one generation'

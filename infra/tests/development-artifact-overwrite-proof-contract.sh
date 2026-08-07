#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d)
mock_bin=$scratch/bin
mkdir -p "$mock_bin"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

artifact_bucket=osfo-development-artifacts-318708913
artifact_uri="gs://$artifact_bucket/sha256/fixture"
artifact_file=$scratch/artifact
printf 'immutable fixture\n' >"$artifact_file"

jq -n '{
  generation: "1740000000000001",
  md5_hash: "CY9rzUYh03PK3k6DJie09g==",
  crc32c_hash: "ImIEBA==",
  size: 18
}' >"$scratch/object-before.json"
cp "$scratch/object-before.json" "$scratch/object-after.json"
jq '.generation = "1740000000000002"' "$scratch/object-before.json" \
  >"$scratch/object-changed-generation.json"
jq '.md5_hash = "XUFAKrxLKna5cZ2REBfFkg=="' "$scratch/object-before.json" \
  >"$scratch/object-changed-digest.json"
jq -n --arg uri "$artifact_uri" '[{
  url: ($uri + "#1740000000000001"),
  type: "cloud_object",
  metadata: {
    bucket: "osfo-development-artifacts-318708913",
    name: "sha256/fixture",
    generation: "1740000000000001",
    metageneration: "1",
    size: "18",
    md5Hash: "CY9rzUYh03PK3k6DJie09g==",
    crc32c: "ImIEBA=="
  }
}]' >"$scratch/generations.json"
jq --arg uri "$artifact_uri" '. + [{
  url: ($uri + "#1740000000000002"),
  type: "cloud_object",
  metadata: {
    bucket: "osfo-development-artifacts-318708913",
    name: "sha256/fixture",
    generation: "1740000000000002"
  }
}]' "$scratch/generations.json" \
  >"$scratch/generations-multiple.json"
jq -n '[{generation: "1740000000000001"}]' \
  >"$scratch/generations-invalid-schema.json"

# The single-quoted lines are the source of the generated mock, not expressions
# for this contract process.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  storage\ objects\ describe*"--format=json(generation,md5_hash,crc32c_hash,size)")' \
  '    if [[ -e "$MOCK_DESCRIBE_STATE" ]]; then' \
  '      cat "$MOCK_OBJECT_AFTER"' \
  '    else' \
  '      touch "$MOCK_DESCRIBE_STATE"' \
  '      cat "$MOCK_OBJECT_BEFORE"' \
  '    fi' \
  '    ;;' \
  '  storage\ cp*)' \
  '    if [[ "${MOCK_OVERWRITE_MODE:-deny}" == success ]]; then' \
  '      exit 0' \
  '    fi' \
  '    printf "opaque provider rejection\n" >&2' \
  '    exit 1' \
  '    ;;' \
  '  "storage ls --all-versions --json $MOCK_ARTIFACT_URI") cat "$MOCK_GENERATIONS" ;;' \
  '  storage\ ls*)' \
  '    printf "storage listing must use exact SDK 569 --all-versions --json invocation: %s\n" "$*" >&2' \
  '    exit 92' \
  '    ;;' \
  '  *) printf "unexpected artifact proof gcloud invocation: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

proof_output=$scratch/proof-output
PATH="$mock_bin:$PATH" \
  MOCK_DESCRIBE_STATE="$scratch/describe-state" \
  MOCK_OBJECT_BEFORE="$scratch/object-before.json" \
  MOCK_OBJECT_AFTER="$scratch/object-after.json" \
  MOCK_ARTIFACT_URI="$artifact_uri" \
  MOCK_GENERATIONS="$scratch/generations.json" \
  infra/tests/development-artifact-overwrite-proof.sh \
  "$artifact_file" "$artifact_uri" \
  >"$proof_output" 2>&1
grep -Fq \
  'PASS: artifact overwrite denied with unchanged digest metadata and exactly one generation' \
  "$proof_output"

expect_proof_fails() {
  local scenario=$1
  local overwrite_mode=$2
  local object_after=$3
  local generations=$4
  local expected_failure=$5
  local source_file=${6:-$artifact_file}
  local output=$scratch/$scenario-output
  local describe_state=$scratch/$scenario-describe-state

  if PATH="$mock_bin:$PATH" \
    MOCK_OVERWRITE_MODE="$overwrite_mode" \
    MOCK_DESCRIBE_STATE="$describe_state" \
    MOCK_OBJECT_BEFORE="$scratch/object-before.json" \
    MOCK_OBJECT_AFTER="$object_after" \
    MOCK_ARTIFACT_URI="$artifact_uri" \
    MOCK_GENERATIONS="$generations" \
    infra/tests/development-artifact-overwrite-proof.sh \
    "$source_file" "$artifact_uri" \
    >"$output" 2>&1; then
    printf '%s artifact invariant must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fq "$expected_failure" "$output"
  if grep -Fq 'PASS:' "$output"; then
    printf '%s artifact invariant must not report PASS\n' "$scenario" >&2
    exit 1
  fi
}

unreadable_artifact=$scratch/unreadable-artifact
printf 'unreadable fixture\n' >"$unreadable_artifact"
chmod 000 "$unreadable_artifact"
expect_proof_fails \
  missing-source deny \
  "$scratch/object-after.json" "$scratch/generations.json" \
  'FAIL: artifact source must be a readable regular file' \
  "$scratch/missing-artifact"
expect_proof_fails \
  unreadable-source deny \
  "$scratch/object-after.json" "$scratch/generations.json" \
  'FAIL: artifact source must be a readable regular file' \
  "$unreadable_artifact"

expect_proof_fails \
  overwrite-success success \
  "$scratch/object-after.json" "$scratch/generations.json" \
  'FAIL: IAM allowed an unconditional content-addressed artifact overwrite'
expect_proof_fails \
  changed-generation deny \
  "$scratch/object-changed-generation.json" "$scratch/generations.json" \
  'FAIL: content-addressed artifact generation or digest metadata changed after denied overwrite'
expect_proof_fails \
  changed-digest deny \
  "$scratch/object-changed-digest.json" "$scratch/generations.json" \
  'FAIL: content-addressed artifact generation or digest metadata changed after denied overwrite'
expect_proof_fails \
  multiple-generations deny \
  "$scratch/object-after.json" "$scratch/generations-multiple.json" \
  'FAIL: content-addressed artifact must retain exactly its original generation'
expect_proof_fails \
  invalid-generation-schema deny \
  "$scratch/object-after.json" "$scratch/generations-invalid-schema.json" \
  'FAIL: content-addressed artifact must retain exactly its original generation'

printf 'development artifact overwrite proof assertions passed\n'

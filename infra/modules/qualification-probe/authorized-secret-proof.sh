#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${QUALIFICATION_SECRET:?QUALIFICATION_SECRET is required}"
: "${QUALIFICATION_VERSION:?QUALIFICATION_VERSION is required}"
: "${QUALIFICATION_RUN_ID:?QUALIFICATION_RUN_ID is required}"
: "${EXPECTED_SERVICE_ACCOUNT:?EXPECTED_SERVICE_ACCOUNT is required}"

if [[ ! "$QUALIFICATION_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  fail 'qualification secret version is not an exact positive integer'
fi
if [[ ! "$QUALIFICATION_RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  fail 'qualification run identifier contains unsafe characters'
fi

metadata_url=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email
observed_identity=""
if ! observed_identity=$(curl --fail --silent \
  -H 'Metadata-Flavor: Google' "$metadata_url" 2>/dev/null); then
  fail 'managed qualification identity could not be verified'
fi
if [[ "$observed_identity" != "$EXPECTED_SERVICE_ACCOUNT" ]]; then
  fail 'managed qualification identity does not match the reviewed identity'
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
payload_file=$scratch/payload

if ! gcloud secrets versions access "$QUALIFICATION_VERSION" \
  --secret="$QUALIFICATION_SECRET" --project="$PROJECT_ID" \
  >"$payload_file" 2>/dev/null; then
  fail 'authorized secret-version access failed closed'
fi

payload_length=$(wc -c <"$payload_file" | tr -d '[:space:]')
if [[ ! "$payload_length" =~ ^[1-9][0-9]*$ ]]; then
  fail 'authorized secret-version payload length is invalid'
fi
observed_sha256=$(sha256sum "$payload_file" 2>/dev/null | cut -d' ' -f1) \
  || fail 'authorized secret-version digest tool failed closed'
expected_sentinel=$(printf 'osfo-authorized-secret-proof-v1:%s' "$QUALIFICATION_RUN_ID" \
  | sha256sum 2>/dev/null | cut -d' ' -f1) \
  || fail 'qualification sentinel generation failed closed'
expected_sha256=$(printf '%s' "$expected_sentinel" \
  | sha256sum 2>/dev/null | cut -d' ' -f1) \
  || fail 'qualification sentinel digest tool failed closed'
if [[ ! "$observed_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$expected_sentinel" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  fail 'authorized secret-version digest is invalid'
fi
if [[ "$observed_sha256" != "$expected_sha256" ]]; then
  fail 'authorized secret-version payload digest does not match'
fi

printf \
  '{"schema_version":1,"identity_verified":true,"payload_length":%s,"payload_sha256_match":true}\n' \
  "$payload_length"

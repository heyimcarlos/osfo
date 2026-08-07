#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -r '.project_id' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
expected_account=$(jq -r '.terraform_service_account_email' "$varset")
zone="$name_prefix-private"
record=database.temporal.internal.
initial_address=192.0.2.89
updated_address=192.0.2.90

if [[ -n "${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-}" ]]; then
  effective_account=$CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
elif ! effective_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)'); then
  printf 'FAIL: DNS permission preflight stage identity failed to read the active account\n' >&2
  exit 1
fi
if [[ "$effective_account" != "$expected_account" ]]; then
  printf 'FAIL: DNS permission preflight requires platform identity %s, got %s\n' \
    "$expected_account" "$effective_account" >&2
  exit 1
fi
if [[ ! "$project_id" =~ ^osfo-development-[0-9]+$ ]] \
  || [[ ! "$zone" =~ ^osfo-dev-private$ ]]; then
  printf 'FAIL: DNS permission preflight refuses unreviewed target %s/%s\n' \
    "$project_id" "$zone" >&2
  exit 1
fi

scratch=$(mktemp -d)
cleanup_required=0
cleanup() {
  status=$?
  trap - EXIT
  if ((status != 0 && cleanup_required == 1)); then
    if ! gcloud dns record-sets delete "$record" \
      --zone="$zone" --project="$project_id" --type=A --quiet \
      >"$scratch/cleanup.out" 2>"$scratch/cleanup.error"; then
      printf 'FAIL: DNS permission preflight could not remove its exact probe record\n' >&2
      cat "$scratch/cleanup.error" >&2
    fi
  fi
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT

if ! gcloud dns managed-zones describe "$zone" --project="$project_id" --format=json \
  >"$scratch/zone.json" 2>"$scratch/zone.error"; then
  printf 'FAIL: DNS permission preflight stage zone-lookup failed\n' >&2
  cat "$scratch/zone.error" >&2
  exit 1
fi
if ! jq -e --arg zone "$zone" '.name == $zone' "$scratch/zone.json" >/dev/null; then
  printf 'FAIL: DNS permission preflight stage zone-validation returned the wrong zone\n' >&2
  exit 1
fi

list_record_sets() {
  local output=$1
  local error=$2
  gcloud dns record-sets list --zone="$zone" --project="$project_id" \
    --filter="name=$record AND type=A" --format=json >"$output" 2>"$error"
}

if ! list_record_sets "$scratch/before.json" "$scratch/before.error"; then
  printf 'FAIL: DNS permission preflight stage initial-list failed\n' >&2
  cat "$scratch/before.error" >&2
  exit 1
fi
if ! jq -e --arg record "$record" '
  type == "array"
  and all(.[]; .name != $record or .type != "A")
' "$scratch/before.json" >/dev/null; then
  printf 'FAIL: DNS permission preflight refuses to replace an existing exact probe record\n' >&2
  exit 1
fi

if ! gcloud dns record-sets create "$record" \
  --zone="$zone" --project="$project_id" --type=A --ttl=30 \
  --rrdatas="$initial_address" --quiet \
  >"$scratch/create.out" 2>"$scratch/create.error"; then
  printf 'FAIL: DNS permission preflight stage create failed\n' >&2
  cat "$scratch/create.error" >&2
  exit 1
fi
cleanup_required=1

if ! gcloud dns record-sets describe "$record" \
  --zone="$zone" --project="$project_id" --type=A --format=json \
  >"$scratch/created.json" 2>"$scratch/created.error"; then
  printf 'FAIL: DNS permission preflight stage read-created failed\n' >&2
  cat "$scratch/created.error" >&2
  exit 1
fi
if ! jq -e --arg record "$record" --arg address "$initial_address" '
  .name == $record and .type == "A" and .ttl == 30 and .rrdatas == [$address]
' "$scratch/created.json" >/dev/null; then
  printf 'FAIL: DNS permission preflight stage validate-created returned unexpected data\n' >&2
  exit 1
fi

if ! gcloud dns record-sets update "$record" \
  --zone="$zone" --project="$project_id" --type=A --ttl=30 \
  --rrdatas="$updated_address" --quiet \
  >"$scratch/update.out" 2>"$scratch/update.error"; then
  printf 'FAIL: DNS permission preflight stage update failed\n' >&2
  cat "$scratch/update.error" >&2
  exit 1
fi
if ! gcloud dns record-sets describe "$record" \
  --zone="$zone" --project="$project_id" --type=A --format=json \
  >"$scratch/updated.json" 2>"$scratch/updated.error"; then
  printf 'FAIL: DNS permission preflight stage read-updated failed\n' >&2
  cat "$scratch/updated.error" >&2
  exit 1
fi
if ! jq -e --arg record "$record" --arg address "$updated_address" '
  .name == $record and .type == "A" and .ttl == 30 and .rrdatas == [$address]
' "$scratch/updated.json" >/dev/null; then
  printf 'FAIL: DNS permission preflight stage validate-updated returned unexpected data\n' >&2
  exit 1
fi

if ! gcloud dns record-sets delete "$record" \
  --zone="$zone" --project="$project_id" --type=A --quiet \
  >"$scratch/delete.out" 2>"$scratch/delete.error"; then
  printf 'FAIL: DNS permission preflight stage delete failed\n' >&2
  cat "$scratch/delete.error" >&2
  exit 1
fi
cleanup_required=0

if ! list_record_sets "$scratch/after.json" "$scratch/after.error"; then
  printf 'FAIL: DNS permission preflight stage final-list failed\n' >&2
  cat "$scratch/after.error" >&2
  exit 1
fi
if ! jq -e --arg record "$record" '
  type == "array"
  and all(.[]; .name != $record or .type != "A")
' "$scratch/after.json" >/dev/null; then
  printf 'FAIL: DNS permission preflight stage final-absence found its probe record\n' >&2
  exit 1
fi

printf 'PASS: platform identity created, read, updated, and deleted only the exact DNS probe record\n'

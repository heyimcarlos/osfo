#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -r '.project_id' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
expected_account=$(jq -r '.terraform_service_account_email' "$varset")
zone="$name_prefix-private"
record=database.temporal.internal.

if [[ -n "${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-}" ]]; then
  effective_account=$CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
elif ! effective_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)'); then
  printf 'FAIL: DNS probe recovery could not read the active account\n' >&2
  exit 1
fi
if [[ "$effective_account" != "$expected_account" ]]; then
  printf 'FAIL: DNS probe recovery requires platform identity %s, got %s\n' \
    "$expected_account" "$effective_account" >&2
  exit 1
fi
if [[ ! "$project_id" =~ ^osfo-development-[0-9]+$ ]] \
  || [[ "$zone" != osfo-dev-private ]]; then
  printf 'FAIL: DNS probe recovery refuses unreviewed target %s/%s\n' \
    "$project_id" "$zone" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
list_record_sets() {
  local output=$1
  local error=$2
  gcloud dns record-sets list --zone="$zone" --project="$project_id" \
    --filter="name=$record AND type=A" --format=json >"$output" 2>"$error"
}

if ! list_record_sets "$scratch/before.json" "$scratch/before.error"; then
  printf 'FAIL: DNS probe recovery could not inspect the exact record\n' >&2
  cat "$scratch/before.error" >&2
  exit 1
fi
if jq -e 'type == "array" and length == 0' "$scratch/before.json" >/dev/null; then
  printf 'PASS: no out-of-state DNS permission probe residue exists\n'
  exit 0
fi
if ! jq -e --arg record "$record" '
  type == "array"
  and length == 1
  and .[0].name == $record
  and .[0].type == "A"
  and (.[0].ttl | type) == "number"
  and (.[0].rrdatas | type) == "array"
' "$scratch/before.json" >/dev/null; then
  printf 'FAIL: DNS probe recovery found unexpected exact-record data\n' >&2
  exit 1
fi
if ! jq -e '
  .[0].ttl == 30
  and (.[0].rrdatas == ["192.0.2.89"] or .[0].rrdatas == ["192.0.2.90"])
' "$scratch/before.json" >/dev/null; then
  printf 'PASS: exact DNS record is not permission-probe residue; Terraform retains ownership\n'
  exit 0
fi

if ! gcloud dns record-sets delete "$record" \
  --zone="$zone" --project="$project_id" --type=A --quiet \
  >"$scratch/delete.out" 2>"$scratch/delete.error"; then
  printf 'FAIL: DNS probe recovery could not delete the exact probe residue\n' >&2
  cat "$scratch/delete.error" >&2
  exit 1
fi
if ! list_record_sets "$scratch/after.json" "$scratch/after.error"; then
  printf 'FAIL: DNS probe recovery could not verify final record absence\n' >&2
  cat "$scratch/after.error" >&2
  exit 1
fi
if ! jq -e 'type == "array" and length == 0' "$scratch/after.json" >/dev/null; then
  printf 'FAIL: DNS permission probe residue remains after exact deletion\n' >&2
  exit 1
fi

printf 'PASS: durable recovery removed only the exact DNS permission probe residue\n'

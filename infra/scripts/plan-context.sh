#!/usr/bin/env bash

set -euo pipefail

# Values assigned here are consumed by the scripts that source this helper.
# shellcheck disable=SC2034

load_provider_lock_digest() {
  local root_directory=$1

  if [[ -f "$root_directory/.terraform.lock.hcl" ]]; then
    provider_lock_sha256=$(sha256sum "$root_directory/.terraform.lock.hcl" | cut -d ' ' -f 1)
  else
    provider_lock_sha256="builtin-providers-only"
  fi
}

load_state_identity() {
  local terraform_bin=$1
  local root_directory=$2
  local state_json=$3
  local state_error=$4

  if ! "$terraform_bin" -chdir="$root_directory" state pull >"$state_json" 2>"$state_error"; then
    printf 'unable to read Terraform state for plan binding\n' >&2
    cat "$state_error" >&2
    return 1
  fi

  if [[ ! -s "$state_json" ]]; then
    state_lineage="uninitialized"
    state_serial=-1
    return 0
  fi

  if ! jq -e '.lineage | type == "string"' "$state_json" >/dev/null \
    || ! jq -e '.serial | type == "number"' "$state_json" >/dev/null; then
    printf 'Terraform returned malformed state for plan binding\n' >&2
    return 1
  fi

  # shellcheck disable=SC2034
  state_lineage=$(jq -r '.lineage' "$state_json")
  # shellcheck disable=SC2034
  state_serial=$(jq -r '.serial' "$state_json")
}

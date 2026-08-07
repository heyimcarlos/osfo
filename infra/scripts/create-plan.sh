#!/usr/bin/env bash

set -euo pipefail

if (($# < 3)); then
  printf 'usage: %s <environment> <root-directory> <plan-file> [terraform-plan-args...]\n' "$0" >&2
  exit 64
fi

environment=$1
root_directory=$(realpath "$2")
plan_file=$(realpath -m "$3")
shift 3

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/plan-context.sh
source "$script_directory/plan-context.sh"
repo_root=$(cd "$script_directory/../.." && pwd)
terraform_bin=${TERRAFORM_BIN:-terraform}
variable_set_file=${TF_VARSET_FILE:-}
image_digests_file=${TF_IMAGE_DIGESTS_FILE:-}
contract_file="$root_directory/root.contract.json"
manifest_file="$plan_file.manifest.json"

if [[ ! -f "$contract_file" ]]; then
  printf 'Terraform root contract is missing: %s\n' "$contract_file" >&2
  exit 1
fi

contract_environment=$(jq -r '.environment' "$contract_file")
root_name=$(jq -r '.root_name' "$contract_file")
if [[ "$environment" != "$contract_environment" ]]; then
  printf 'environment %s does not match root contract %s\n' "$environment" "$contract_environment" >&2
  exit 1
fi

for required_file in "$variable_set_file" "$image_digests_file"; do
  if [[ -z "$required_file" || ! -f "$required_file" ]]; then
    printf 'TF_VARSET_FILE and TF_IMAGE_DIGESTS_FILE must name reviewed, non-secret input files\n' >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$plan_file")"

"$script_directory/check-command.sh" "$environment" plan "$@" "-out=$plan_file"

set +e
"$terraform_bin" -chdir="$root_directory" plan \
  -input=false \
  -lock-timeout=5m \
  -var-file="$variable_set_file" \
  "$@" \
  -out="$plan_file"
plan_status=$?
set -e

if ((plan_status != 0 && plan_status != 2)); then
  exit "$plan_status"
fi

plan_json=$(mktemp)
state_json=$(mktemp)
state_error=$(mktemp)
manifest_without_binding=$(mktemp)
trap 'rm -f "$plan_json" "$state_json" "$state_error" "$manifest_without_binding"' EXIT

"$terraform_bin" -chdir="$root_directory" show -json "$plan_file" >"$plan_json"
"$script_directory/check-plan.sh" "$environment" "$plan_json"

load_state_identity "$terraform_bin" "$root_directory" "$state_json" "$state_error"

terraform_version=$("$terraform_bin" version -json | jq -r '.terraform_version')
required_version=$(sed -nE 's/.*required_version[[:space:]]*=[[:space:]]*"=[[:space:]]*([0-9.]+)".*/\1/p' "$root_directory/versions.tf")
if [[ "$terraform_version" != "$required_version" ]]; then
  printf 'Terraform CLI %s does not match root required_version %s\n' "$terraform_version" "$required_version" >&2
  exit 1
fi

load_provider_lock_digest "$root_directory"

commit_sha=$(git -C "$repo_root" rev-parse HEAD)
plan_sha256=$(sha256sum "$plan_file" | cut -d ' ' -f 1)
variable_set_sha256=$(sha256sum "$variable_set_file" | cut -d ' ' -f 1)
image_digests_sha256=$(sha256sum "$image_digests_file" | cut -d ' ' -f 1)
created_at_epoch=$(date +%s)
expires_at_epoch=$((created_at_epoch + 86400))

jq -n \
  --arg environment "$environment" \
  --arg root_name "$root_name" \
  --arg commit_sha "$commit_sha" \
  --arg terraform_version "$terraform_version" \
  --arg provider_lock_sha256 "$provider_lock_sha256" \
  --arg variable_set_sha256 "$variable_set_sha256" \
  --arg image_digests_sha256 "$image_digests_sha256" \
  --arg state_lineage "$state_lineage" \
  --arg plan_sha256 "$plan_sha256" \
  --argjson state_serial "$state_serial" \
  --argjson created_at_epoch "$created_at_epoch" \
  --argjson expires_at_epoch "$expires_at_epoch" \
  '{
    schema_version: 1,
    environment: $environment,
    root_name: $root_name,
    commit_sha: $commit_sha,
    terraform_version: $terraform_version,
    provider_lock_sha256: $provider_lock_sha256,
    variable_set_sha256: $variable_set_sha256,
    image_digests_sha256: $image_digests_sha256,
    state_lineage: $state_lineage,
    state_serial: $state_serial,
    plan_sha256: $plan_sha256,
    created_at_epoch: $created_at_epoch,
    expires_at_epoch: $expires_at_epoch
  }' >"$manifest_without_binding"

binding_sha256=$(jq -S -c . "$manifest_without_binding" | sha256sum | cut -d ' ' -f 1)
jq --arg binding_sha256 "$binding_sha256" \
  '. + {binding_sha256: $binding_sha256}' \
  "$manifest_without_binding" >"$manifest_file"

printf 'created bound plan %s\n' "$plan_file"

for argument in "$@"; do
  if [[ "$argument" == -detailed-exitcode && "$plan_status" == 2 ]]; then
    exit 2
  fi
done

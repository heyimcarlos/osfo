#!/usr/bin/env bash

set -euo pipefail

if (($# != 3)); then
  printf 'usage: %s <environment> <root-directory> <plan-file>\n' "$0" >&2
  exit 64
fi

environment=$1
root_directory=$(realpath "$2")
plan_file=$(realpath "$3")
manifest_file="$plan_file.manifest.json"
contract_file="$root_directory/root.contract.json"
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
terraform_bin=${TERRAFORM_BIN:-terraform}

contract_environment=$(jq -r '.environment' "$contract_file")
manifest_environment=$(jq -r '.environment' "$manifest_file")
if [[ "$environment" != "$contract_environment" ]]; then
  printf 'apply environment does not match the root contract\n' >&2
  exit 1
fi
if [[ "$environment" != "$manifest_environment" ]]; then
  printf 'apply environment does not match the plan manifest\n' >&2
  exit 1
fi

"$script_directory/check-command.sh" "$environment" apply "$plan_file"
"$script_directory/verify-plan.sh" "$root_directory" "$plan_file" "$manifest_file"
"$terraform_bin" -chdir="$root_directory" apply -input=false -lock-timeout=5m "$plan_file"

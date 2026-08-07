#!/usr/bin/env bash

set -euo pipefail

if (($# != 3)); then
  printf 'usage: %s <root-directory> <plan-file> <manifest-file>\n' "$0" >&2
  exit 64
fi

root_directory=$(realpath "$1")
plan_file=$(realpath "$2")
manifest_file=$(realpath "$3")
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/plan-context.sh
source "$script_directory/plan-context.sh"
repo_root=$(cd "$script_directory/../.." && pwd)
terraform_bin=${TERRAFORM_BIN:-terraform}
variable_set_file=${TF_VARSET_FILE:-}
image_digests_file=${TF_IMAGE_DIGESTS_FILE:-}
contract_file="$root_directory/root.contract.json"

for required_file in "$plan_file" "$manifest_file" "$contract_file" "$variable_set_file" "$image_digests_file"; do
  if [[ -z "$required_file" || ! -f "$required_file" ]]; then
    printf 'required plan verification input is missing: %s\n' "$required_file" >&2
    exit 1
  fi
done

if ! jq -e '
  .schema_version == 1
  and (.binding_sha256 | type == "string")
  and (.expires_at_epoch | type == "number")
' "$manifest_file" >/dev/null; then
  printf 'plan manifest schema is invalid\n' >&2
  exit 1
fi

expected_binding=$(jq -S -c 'del(.binding_sha256)' "$manifest_file" | sha256sum | cut -d ' ' -f 1)
actual_binding=$(jq -r '.binding_sha256' "$manifest_file")
if [[ "$actual_binding" != "$expected_binding" ]]; then
  printf 'plan manifest binding does not match its contents\n' >&2
  exit 1
fi

assert_manifest_value() {
  local field=$1
  local actual=$2
  local expected
  expected=$(jq -r --arg field "$field" '.[$field]' "$manifest_file")
  if [[ "$actual" != "$expected" ]]; then
    printf 'plan binding mismatch for %s\n' "$field" >&2
    exit 1
  fi
}

assert_manifest_value plan_sha256 "$(sha256sum "$plan_file" | cut -d ' ' -f 1)"
assert_manifest_value variable_set_sha256 "$(sha256sum "$variable_set_file" | cut -d ' ' -f 1)"
assert_manifest_value image_digests_sha256 "$(sha256sum "$image_digests_file" | cut -d ' ' -f 1)"
assert_manifest_value commit_sha "$(git -C "$repo_root" rev-parse HEAD)"
assert_manifest_value terraform_version "$("$terraform_bin" version -json | jq -r '.terraform_version')"
assert_manifest_value environment "$(jq -r '.environment' "$contract_file")"
assert_manifest_value root_name "$(jq -r '.root_name' "$contract_file")"

load_provider_lock_digest "$root_directory"
assert_manifest_value provider_lock_sha256 "$provider_lock_sha256"

state_json=$(mktemp)
state_error=$(mktemp)
trap 'rm -f "$state_json" "$state_error"' EXIT
load_state_identity "$terraform_bin" "$root_directory" "$state_json" "$state_error"
assert_manifest_value state_lineage "$state_lineage"
assert_manifest_value state_serial "$state_serial"

expires_at_epoch=$(jq -r '.expires_at_epoch' "$manifest_file")
if ((expires_at_epoch < $(date +%s))); then
  printf 'saved plan expired after its 24-hour validity window\n' >&2
  exit 1
fi

printf 'verified plan binding %s\n' "$actual_binding"

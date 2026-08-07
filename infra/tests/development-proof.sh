#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
terraform_bin=${TERRAFORM_BIN:-terraform}
root_directory="$repo_root/infra/roots/development/platform"
mkdir -p "$repo_root/tmp"
scratch=$(mktemp -d "$repo_root/tmp/terraform-proof.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

cp -R "$root_directory/." "$scratch/root"
cp -R "$repo_root/infra/modules" "$scratch/modules"
# A prior live init leaves backend metadata that must not enter the offline copy.
rm -rf "$scratch/root/.terraform"
# The committed root uses its isolated GCS backend. The offline lifecycle proof
# removes only the backend declaration from its disposable copy so the same
# configuration can prove plan binding without cloud credentials.
sed -i '/backend "gcs" {}/d' "$scratch/root/versions.tf"
sed -i 's#../../../modules/#../modules/#g' "$scratch/root/main.tf"
cd "$scratch/root"

export TERRAFORM_BIN="$terraform_bin"
export TF_IN_AUTOMATION=1
export TF_INPUT=0
export TF_VARSET_FILE="$scratch/root/development.tfvars.json"
export TF_IMAGE_DIGESTS_FILE="$scratch/root/image-digests.json"

jq '.enable_managed_platform = false' "$scratch/root/development.tfvars.json" \
  >"$scratch/root/development.offline.tfvars.json"
export TF_VARSET_FILE="$scratch/root/development.offline.tfvars.json"

"$terraform_bin" init -backend=false -input=false >/dev/null
"$terraform_bin" validate >/dev/null

"$repo_root/infra/scripts/create-plan.sh" \
  development "$scratch/root" "$scratch/create.tfplan"

test -f "$scratch/create.tfplan.manifest.json"
jq -e '
  .schema_version == 1
  and .environment == "development"
  and .root_name == "development/platform"
  and (.plan_sha256 | length == 64)
  and (.binding_sha256 | length == 64)
  and .expires_at_epoch > .created_at_epoch
' "$scratch/create.tfplan.manifest.json" >/dev/null

cp "$scratch/create.tfplan.manifest.json" "$scratch/tampered.manifest.json"
jq '.commit_sha = "0000000000000000000000000000000000000000"' \
  "$scratch/tampered.manifest.json" >"$scratch/tampered.manifest.next.json"
mv "$scratch/tampered.manifest.next.json" "$scratch/tampered.manifest.json"

if "$repo_root/infra/scripts/verify-plan.sh" \
  "$scratch/root" "$scratch/create.tfplan" "$scratch/tampered.manifest.json"; then
  printf 'FAIL: tampered plan manifest unexpectedly verified\n' >&2
  exit 1
fi

if "$repo_root/infra/scripts/apply-plan.sh" \
  production "$scratch/root" "$scratch/create.tfplan"; then
  printf 'FAIL: mismatched apply environment unexpectedly passed\n' >&2
  exit 1
fi

"$repo_root/infra/scripts/apply-plan.sh" \
  development "$scratch/root" "$scratch/create.tfplan"

"$repo_root/infra/scripts/create-plan.sh" \
  development "$scratch/root" "$scratch/drift.tfplan" -refresh-only -detailed-exitcode

"$repo_root/infra/scripts/apply-plan.sh" \
  development "$scratch/root" "$scratch/drift.tfplan"

"$repo_root/infra/scripts/create-plan.sh" \
  development "$scratch/root" "$scratch/destroy.tfplan" -destroy
"$repo_root/infra/scripts/apply-plan.sh" \
  development "$scratch/root" "$scratch/destroy.tfplan"

test -f "$scratch/root/terraform.tfstate"
jq -e '.lineage != null and .serial >= 2 and (.resources | length) == 0' \
  "$scratch/root/terraform.tfstate" >/dev/null

printf 'PASS: bound plan, exact apply, drift check, destroy, and recoverable state\n'

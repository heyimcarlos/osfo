#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

terraform_version=$(jq -r '.terraform_version' infra/toolchain.json)
google_provider_version=$(jq -r '.google_provider_version' infra/toolchain.json)
ci_image=$(jq -r '.ci_image' infra/toolchain.json)
[[ "$ci_image" =~ @sha256:[0-9a-f]{64}$ ]]
[[ "$(<.terraform-version)" == "$terraform_version" ]]

while IFS= read -r versions_file; do
  rg --quiet "required_version\\s*=\\s*\"= $terraform_version\"" "$versions_file"
done < <(find infra/roots -name versions.tf -type f | sort)

rg --quiet "version\\s*=\\s*\"$google_provider_version\"" \
  infra/roots/foundation/versions.tf
rg --quiet "version[[:space:]]*=[[:space:]]*\"$google_provider_version\"" \
  infra/roots/foundation/.terraform.lock.hcl
[[ "$(infra/scripts/terraform-ci.sh version -json | jq -r '.terraform_version')" == "$terraform_version" ]]
rg --fixed-strings --quiet "TERRAFORM_BIN: \${{ github.workspace }}/infra/scripts/terraform-ci.sh" \
  .github/workflows/terraform.yml
rg --fixed-strings --quiet 'group: terraform-${{ inputs.root }}' \
  .github/workflows/terraform.yml
rg --fixed-strings --quiet "terraform_image=\$(jq -r '.ci_image'" \
  infra/scripts/terraform-ci.sh
if rg --fixed-strings --quiet 'apk add' .github/workflows/terraform.yml; then
  printf 'Terraform workflow must not install tools from mutable package repositories\n' >&2
  exit 1
fi
for root in foundation development-platform development-runtime production-platform production-runtime; do
  rg --fixed-strings --quiet -- "- $root" .github/workflows/terraform.yml
done

if rg --quiet 'uses:[[:space:]]+[^[:space:]]+@v[0-9]' .github/workflows; then
  printf 'GitHub Actions must use immutable commit SHAs\n' >&2
  exit 1
fi

while IFS= read -r action_reference; do
  if [[ ! "$action_reference" =~ @[0-9a-f]{40}$ ]]; then
    printf 'mutable GitHub Action reference: %s\n' "$action_reference" >&2
    exit 1
  fi
done < <(sed -nE 's/^[[:space:]]*-[[:space:]]*uses:[[:space:]]*([^[:space:]]+).*/\1/p' .github/workflows/terraform.yml)

expected_roots='development/platform
development/runtime
foundation
production/platform
production/runtime'
actual_roots=$(
  find infra/roots -name root.contract.json -type f -print0 \
    | xargs -0 -n1 jq -r '.root_name' \
    | sort
)
[[ "$actual_roots" == "$expected_roots" ]]

if rg --quiet --glob '*.tf' 'terraform_remote_state|terraform\.workspace|google_service_account_key|google_secret_manager_secret_version' infra; then
  printf 'forbidden Terraform source boundary found\n' >&2
  exit 1
fi

if rg --quiet 'terraform[[:space:]]+workspace|-lock=false|-refresh=false|-target(=|[[:space:]])' \
  .github/workflows/terraform.yml; then
  printf 'workflow contains a prohibited routine Terraform operation\n' >&2
  exit 1
fi

if rg --quiet "from[[:space:]]+['\"]vitest['\"]" infra/test; then
  printf 'infrastructure tests must use Effect Vitest\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'from "@effect/vitest"' infra/test/terraform-foundation.test.ts
rg --fixed-strings --quiet 'google_project_iam_custom_role.state_object_lister.name' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'saved_plan_bucket_name' infra/roots/foundation/main.tf
if rg --fixed-strings --quiet 'storage.buckets.delete' infra/roots/foundation/main.tf; then
  printf 'routine foundation identity must not receive bucket deletion authority\n' >&2
  exit 1
fi
if rg --fixed-strings --quiet 'resource "google_storage_bucket_iam_member" "saved_plan_list"' \
  infra/roots/foundation/main.tf; then
  printf 'saved-plan identities do not need bucket-wide object listing\n' >&2
  exit 1
fi

printf 'PASS: pinned toolchain, roots, actions, source boundaries, and Effect-aware tests\n'

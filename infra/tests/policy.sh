#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
command_policy="$repo_root/infra/scripts/check-command.sh"
plan_policy="$repo_root/infra/scripts/check-plan.sh"
source_policy="$repo_root/infra/scripts/check-source.sh"
plan_context="$repo_root/infra/scripts/plan-context.sh"
store_plan="$repo_root/infra/scripts/store-plan.sh"
fetch_plan="$repo_root/infra/scripts/fetch-plan.sh"
terraform_ci="$repo_root/infra/scripts/terraform-ci.sh"
# shellcheck source=infra/scripts/plan-context.sh
source "$plan_context"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

pass_count=0

expect_pass() {
  local name=$1
  shift

  if ! "$@" >"$scratch/stdout" 2>"$scratch/stderr"; then
    printf 'FAIL: %s\n' "$name" >&2
    cat "$scratch/stdout" "$scratch/stderr" >&2
    exit 1
  fi

  pass_count=$((pass_count + 1))
}

expect_fail() {
  local name=$1
  shift

  if "$@" >"$scratch/stdout" 2>"$scratch/stderr"; then
    printf 'FAIL: %s unexpectedly passed\n' "$name" >&2
    exit 1
  fi

  pass_count=$((pass_count + 1))
}

mkdir -p "$scratch/plans"

cat >"$scratch/plans/create.json" <<'JSON'
{
  "resource_changes": [
    {
      "address": "terraform_data.proof",
      "change": { "actions": ["create"] }
    }
  ]
}
JSON

cat >"$scratch/plans/delete.json" <<'JSON'
{
  "resource_changes": [
    {
      "address": "terraform_data.proof",
      "change": { "actions": ["delete"] }
    }
  ]
}
JSON

cat >"$scratch/plans/replace.json" <<'JSON'
{
  "resource_changes": [
    {
      "address": "google_storage_bucket.protected",
      "change": { "actions": ["delete", "create"] }
    }
  ]
}
JSON

cat >"$scratch/plans/no-change.json" <<'JSON'
{}
JSON

cat >"$scratch/plans/malformed-actions.json" <<'JSON'
{
  "resource_changes": [
    {
      "address": "google_storage_bucket.protected",
      "change": { "actions": null }
    }
  ]
}
JSON

cat >"$scratch/plans/blank-delete-address.json" <<'JSON'
{
  "resource_changes": [
    {
      "address": "",
      "change": { "actions": ["delete"] }
    }
  ]
}
JSON

expect_pass "saved-plan apply is allowed" \
  "$command_policy" development apply .plans/development.tfplan
expect_pass "locked refresh-only plan is allowed" \
  "$command_policy" development plan -refresh-only -lock-timeout=5m -out=.plans/drift.tfplan
expect_fail "targeting is rejected" \
  "$command_policy" development plan -target=terraform_data.proof -out=.plans/development.tfplan
expect_fail "double-dash targeting is rejected" \
  "$command_policy" development plan --target=terraform_data.proof -out=.plans/development.tfplan
expect_fail "disabled refresh is rejected" \
  "$command_policy" development plan -refresh=false -out=.plans/development.tfplan
expect_fail "disabled refresh boolean aliases are rejected" \
  "$command_policy" development plan --refresh=FALSE -out=.plans/development.tfplan
expect_fail "disabled locking is rejected" \
  "$command_policy" development apply -lock=false .plans/development.tfplan
expect_fail "double-dash disabled locking is rejected" \
  "$command_policy" development apply --lock=false .plans/development.tfplan
expect_fail "disabled locking boolean aliases are rejected" \
  "$command_policy" development apply -lock=0 .plans/development.tfplan
expect_fail "unsaved apply is rejected" \
  "$command_policy" development apply -auto-approve
expect_fail "force unlock is breakglass only" \
  "$command_policy" development force-unlock deadbeef
expect_fail "state push is breakglass only" \
  "$command_policy" development state push terraform.tfstate
expect_fail "console mutation surface is rejected" \
  "$command_policy" development console
expect_fail "production destroy is rejected" \
  "$command_policy" production destroy
expect_fail "foundation destroy is rejected" \
  "$command_policy" foundation destroy
expect_fail "direct development destroy is rejected" \
  "$command_policy" development destroy
expect_fail "workspace environment injection is rejected" \
  env TF_WORKSPACE=bypass "$terraform_ci" version
expect_fail "CLI argument environment injection is rejected" \
  env TF_CLI_ARGS_plan=-target=terraform_data.bypass "$terraform_ci" version

cat >"$scratch/state-pull-fails" <<'SH'
#!/usr/bin/env bash
printf 'permission denied\n' >&2
exit 1
SH
cat >"$scratch/state-pull-empty" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$scratch/state-pull-malformed" <<'SH'
#!/usr/bin/env bash
printf '{}\n'
SH
chmod +x "$scratch/state-pull-fails" "$scratch/state-pull-empty" "$scratch/state-pull-malformed"

expect_fail "state read errors fail closed" \
  load_state_identity "$scratch/state-pull-fails" "$scratch" "$scratch/state.json" "$scratch/state.err"
expect_fail "malformed state reads fail closed" \
  load_state_identity "$scratch/state-pull-malformed" "$scratch" "$scratch/state.json" "$scratch/state.err"
expect_pass "explicit empty state is uninitialized" \
  load_state_identity "$scratch/state-pull-empty" "$scratch" "$scratch/state.json" "$scratch/state.err"
[[ "$state_lineage" == uninitialized && "$state_serial" == -1 ]]

expect_pass "development delete plan is allowed" \
  "$plan_policy" development "$scratch/plans/delete.json"
expect_pass "production create plan is allowed" \
  "$plan_policy" production "$scratch/plans/create.json"
expect_pass "production no-change plan is allowed" \
  "$plan_policy" production "$scratch/plans/no-change.json"
expect_fail "production delete plan is rejected" \
  "$plan_policy" production "$scratch/plans/delete.json"
expect_fail "production replacement plan is rejected" \
  "$plan_policy" production "$scratch/plans/replace.json"
expect_fail "malformed production actions fail closed" \
  "$plan_policy" production "$scratch/plans/malformed-actions.json"
expect_fail "blank production delete addresses fail closed" \
  "$plan_policy" production "$scratch/plans/blank-delete-address.json"

mkdir -p "$scratch/source/roots/development/platform"
cat >"$scratch/source/roots/development/platform/versions.tf" <<'HCL'
terraform {
  required_version = "= 1.15.8"
}
HCL
expect_pass "exact Terraform versions pass" \
  "$source_policy" "$scratch/source"

cat >"$scratch/source/roots/development/platform/remote-state.tf" <<'HCL'
data "terraform_remote_state" "foundation" {}
HCL
expect_fail "terraform_remote_state is rejected" \
  "$source_policy" "$scratch/source"
rm "$scratch/source/roots/development/platform/remote-state.tf"

cat >"$scratch/source/roots/development/platform/versions.tf" <<'HCL'
terraform {
  required_version = "~> 1.15"
}
HCL
expect_fail "version ranges are rejected" \
  "$source_policy" "$scratch/source"

cat >"$scratch/source/roots/development/platform/versions.tf" <<'HCL'
terraform {
  required_version = "= 1.15.8"
}

resource "google_service_account_key" "forbidden" {
  service_account_id = "example"
}
HCL
expect_fail "service-account keys are rejected" \
  "$source_policy" "$scratch/source"

cat >"$scratch/source/roots/development/platform/versions.tf" <<'HCL'
terraform {
  required_version = "= 1.15.8"
}

module "external" {
  source = "git::https://github.com/example/module.git?ref=v1.2.3"
}
HCL
expect_fail "mutable Git module references are rejected" \
  "$source_policy" "$scratch/source"

printf 'saved plan bytes\n' >"$scratch/development.tfplan"
cat >"$scratch/development.tfplan.manifest.json" <<'JSON'
{
  "root_name": "development/platform",
  "binding_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
JSON
cat >"$scratch/gcloud" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GCLOUD_CALLS"
SH
chmod +x "$scratch/gcloud"
export GCLOUD_CALLS="$scratch/gcloud.calls"
expect_pass "saved plans use their conditioned foundation prefix" \
  env GCLOUD_BIN="$scratch/gcloud" GCLOUD_CALLS="$GCLOUD_CALLS" \
  "$store_plan" osfo-plans "$scratch/development.tfplan"
[[ "$(wc -l <"$GCLOUD_CALLS")" == 2 ]]
rg --fixed-strings --quiet \
  'gs://osfo-plans/roots/development/platform/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tfplan' \
  "$GCLOUD_CALLS"
rg --fixed-strings --quiet -- '--if-generation-match=0' "$GCLOUD_CALLS"

cat >"$scratch/gcloud-fetch" <<'SH'
#!/usr/bin/env bash
arguments=("$@")
source_object=${arguments[${#arguments[@]}-2]}
destination=${arguments[${#arguments[@]}-1]}
case "$source_object" in
  *.manifest.json) cp "$FETCH_MANIFEST" "$destination" ;;
  *.tfplan) cp "$FETCH_PLAN" "$destination" ;;
esac
SH
chmod +x "$scratch/gcloud-fetch"

fetch_fixture() {
  (
    cd "$scratch"
    GCLOUD_BIN="$scratch/gcloud-fetch" \
      FETCH_MANIFEST="$scratch/development.tfplan.manifest.json" \
      FETCH_PLAN="$scratch/development.tfplan" \
      "$fetch_plan" osfo-plans development/platform "$1"
  )
}

expect_fail "saved-plan lookup rejects a different manifest binding" \
  fetch_fixture bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
expect_pass "saved-plan lookup accepts the exact manifest binding" \
  fetch_fixture aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

printf 'PASS: %d Terraform policy assertions\n' "$pass_count"

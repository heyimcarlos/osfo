#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
root=$repo_root/infra/roots/development/platform
plan_dir=$repo_root/.plans/development/platform
terraform_bin=${TERRAFORM_BIN:-terraform}
varset=${TF_VARSET_FILE:-$root/development.tfvars.json}
image_digests=${TF_IMAGE_DIGESTS_FILE:-$root/image-digests.json}
evidence_bucket=$(jq -r '.evidence_archive_bucket_name' "$varset")
project_id=$(jq -r '.project_id' "$varset")
region=$(jq -r '.region' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
mkdir -p "$plan_dir"

export TF_VARSET_FILE=$varset
export TF_IMAGE_DIGESTS_FILE=$image_digests

: "${SAVED_PLAN_BUCKET:?SAVED_PLAN_BUCKET is required}"

destroy_platform() {
  local destroyed=false
  local attempt
  for attempt in {1..12}; do
    local destroy_plan="$plan_dir/destroy-$attempt.tfplan"
    if "$repo_root/infra/scripts/create-plan.sh" development "$root" "$destroy_plan" -destroy \
      && "$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$destroy_plan" \
      && "$repo_root/infra/scripts/apply-plan.sh" development "$root" "$destroy_plan"; then
      destroyed=true
      break
    fi
    if (( attempt < 12 )); then
      sleep 30
    fi
  done

  if [[ "$destroyed" != true ]]; then
    printf 'FAIL: development platform did not destroy after twelve bound attempts\n' >&2
    return 1
  fi

  if [[ -n "$("$terraform_bin" -chdir="$root" state list)" ]]; then
    printf 'FAIL: development platform state still contains disposable resources\n' >&2
    return 1
  fi

  gcloud compute networks describe "$name_prefix-vpc" --project="$project_id" >/dev/null
  gcloud compute networks subnets describe "$name_prefix-us-east4" \
    --region="$region" --project="$project_id" >/dev/null
  gcloud compute routers nats describe "$name_prefix-nat" --router="$name_prefix-router" \
    --region="$region" --project="$project_id" >/dev/null
  gcloud dns managed-zones describe "$name_prefix-private" --project="$project_id" >/dev/null
}

cleanup_required=false
cleanup_on_exit() {
  local command_status=$?
  trap - EXIT
  if [[ "$cleanup_required" == true ]]; then
    printf 'cleanup: destroying the development platform after an earlier failure\n' >&2
    if ! destroy_platform; then
      command_status=1
    fi
  fi
  exit "$command_status"
}
trap cleanup_on_exit EXIT

"$repo_root/infra/tests/development-platform-preflight.sh"

create_plan="$plan_dir/create.tfplan"
"$repo_root/infra/scripts/create-plan.sh" development "$root" "$create_plan"
"$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$create_plan"
cleanup_required=true
"$repo_root/infra/scripts/apply-plan.sh" development "$root" "$create_plan"

second_plan="$plan_dir/second.tfplan"
"$repo_root/infra/scripts/create-plan.sh" development "$root" "$second_plan" -detailed-exitcode
"$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$second_plan"

smoke_output=$("$repo_root/infra/tests/development-platform-smoke.sh")
printf '%s\n' "$smoke_output"
managed_report_sha=$(sed -n 's/.*evidence=//p' <<<"$smoke_output" | tail -1)
test -n "$managed_report_sha"

destroy_platform
cleanup_required=false

lifecycle_report=$(mktemp)
trap 'rm -f "$lifecycle_report"' EXIT
jq -n \
  --arg managed_report_sha256 "$managed_report_sha" \
  '{schema_version: 1, qualification: "MISSING", checks: {
    empty_second_plan: "PASS",
    exact_disposable_destroy: "PASS",
    empty_disposable_state: "PASS",
    retained_environment_baseline: "PASS",
    backend_state_retained: "PASS",
    audit_history_retained: "MISSING",
    managed_service_qualification: "MISSING"
  }, managed_service_report_sha256: $managed_report_sha256}' >"$lifecycle_report"
lifecycle_report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$lifecycle_report" "$evidence_bucket")

printf 'PASS: empty second plan and exact destroy, qualification=MISSING, lifecycle evidence=%s\n' \
  "$lifecycle_report_sha"

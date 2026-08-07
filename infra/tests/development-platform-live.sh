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

if ! git -C "$repo_root" diff-index --quiet HEAD -- \
  || [[ -n "$(git -C "$repo_root" ls-files --others --exclude-standard)" ]]; then
  printf 'FAIL: live evidence requires a clean reviewed source commit\n' >&2
  exit 1
fi

source_commit=$(git -C "$repo_root" rev-parse HEAD)
varset_sha=$(sha256sum "$varset" | cut -d' ' -f1)
image_digests_sha=$(sha256sum "$image_digests" | cut -d' ' -f1)
lifecycle_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
destroy_bindings_json='[]'

export TF_VARSET_FILE=$varset
export TF_IMAGE_DIGESTS_FILE=$image_digests

: "${SAVED_PLAN_BUCKET:?SAVED_PLAN_BUCKET is required}"

destroy_platform() {
  local destroyed=false
  local attempt
  for attempt in {1..12}; do
    local destroy_plan="$plan_dir/destroy-$attempt.tfplan"
    if ! "$repo_root/infra/scripts/create-plan.sh" development "$root" "$destroy_plan" -destroy; then
      if ((attempt < 12)); then
        sleep 30
      fi
      continue
    fi

    local destroy_binding
    destroy_binding=$(jq -r '.binding_sha256' "$destroy_plan.manifest.json")
    if ! "$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$destroy_plan"; then
      destroy_bindings_json=$(jq -c \
        --argjson attempt "$attempt" --arg binding "$destroy_binding" \
        '. + [{attempt: $attempt, binding_sha256: $binding, status: "store_failed"}]' \
        <<<"$destroy_bindings_json")
      if ((attempt < 12)); then
        sleep 30
      fi
      continue
    fi

    local apply_status
    set +e
    "$repo_root/infra/scripts/apply-plan.sh" development "$root" "$destroy_plan"
    apply_status=$?
    set -e
    destroy_bindings_json=$(jq -c \
      --argjson attempt "$attempt" --arg binding "$destroy_binding" \
      --arg status "$([[ $apply_status == 0 ]] && printf applied || printf apply_failed)" \
      '. + [{attempt: $attempt, binding_sha256: $binding, status: $status}]' \
      <<<"$destroy_bindings_json")
    if ((apply_status == 0)); then
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

  local state_output
  local state_status
  local state_error
  state_error=$(mktemp)
  set +e
  state_output=$("$terraform_bin" -chdir="$root" state list 2>"$state_error")
  state_status=$?
  set -e
  if ((state_status != 0)); then
    printf 'FAIL: unable to verify empty development platform state\n' >&2
    cat "$state_error" >&2
    rm -f "$state_error"
    return 1
  fi
  rm -f "$state_error"
  if [[ -n "$state_output" ]]; then
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
# Invoked through the EXIT trap below.
# shellcheck disable=SC2329
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
create_binding=$(jq -r '.binding_sha256' "$create_plan.manifest.json")
cleanup_required=true
"$repo_root/infra/scripts/apply-plan.sh" development "$root" "$create_plan"

second_plan="$plan_dir/second.tfplan"
"$repo_root/infra/scripts/create-plan.sh" development "$root" "$second_plan" -detailed-exitcode
"$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$second_plan"
second_binding=$(jq -r '.binding_sha256' "$second_plan.manifest.json")

smoke_output=$("$repo_root/infra/tests/development-platform-smoke.sh")
printf '%s\n' "$smoke_output"
managed_report_sha=$(sed -n 's/.*evidence=//p' <<<"$smoke_output" | tail -1)
test -n "$managed_report_sha"

destroy_platform
cleanup_required=false

absence_report=$(mktemp)
audit_report=$(mktemp)
lifecycle_report=$(mktemp)
trap 'rm -f "$absence_report" "$audit_report" "$lifecycle_report"' EXIT
"$repo_root/infra/tests/development-platform-absent.sh" "$absence_report"
absence_report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$absence_report" "$evidence_bucket")
"$repo_root/infra/tests/development-platform-audit.sh" \
  "$lifecycle_started_at" "$audit_report"
audit_report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$audit_report" "$evidence_bucket")

jq -n \
  --arg source_commit "$source_commit" \
  --arg variable_set_sha256 "$varset_sha" \
  --arg image_digests_sha256 "$image_digests_sha" \
  --arg create_plan_binding_sha256 "$create_binding" \
  --arg second_plan_binding_sha256 "$second_binding" \
  --argjson destroy_plan_bindings "$destroy_bindings_json" \
  --arg managed_report_sha256 "$managed_report_sha" \
  --arg absence_report_sha256 "$absence_report_sha" \
  --arg audit_report_sha256 "$audit_report_sha" \
  '{schema_version: 1, qualification: "MISSING", source: {
    commit_sha: $source_commit,
    clean_tree: true,
    variable_set_sha256: $variable_set_sha256,
    image_digests_sha256: $image_digests_sha256,
    create_plan_binding_sha256: $create_plan_binding_sha256,
    second_plan_binding_sha256: $second_plan_binding_sha256,
    destroy_plan_bindings: $destroy_plan_bindings
  }, checks: {
    empty_second_plan: "PASS",
    exact_disposable_destroy: "PASS",
    empty_disposable_state: "PASS",
    negative_provider_lookups: "PASS",
    retained_environment_baseline: "PASS",
    backend_state_retained: "PASS",
    audit_history_retained: "PASS",
    implementable_managed_service_checks: "PASS",
    managed_service_qualification: "MISSING",
    temporal_private_service_connect: "MISSING"
  }, managed_service_report_sha256: $managed_report_sha256,
  absence_report_sha256: $absence_report_sha256,
  audit_report_sha256: $audit_report_sha256}' >"$lifecycle_report"
lifecycle_report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$lifecycle_report" "$evidence_bucket")

printf 'MISSING: Temporal PSC, implementable lifecycle gates PASS, lifecycle evidence=%s\n' \
  "$lifecycle_report_sha"
exit 3

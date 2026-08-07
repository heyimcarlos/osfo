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
destroy_bindings_json='[]'
lifecycle_run_id=${DEVELOPMENT_LIFECYCLE_RUN_ID:?DEVELOPMENT_LIFECYCLE_RUN_ID is required and must be unique per lifecycle attempt}
if [[ ! "$lifecycle_run_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'FAIL: lifecycle run identifier contains unsafe characters\n' >&2
  exit 1
fi
lifecycle_envelope_uri="gs://$evidence_bucket/roots/development/platform/lifecycles/$lifecycle_run_id.json"

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
  gcloud compute addresses describe "$name_prefix-egress" \
    --region="$region" --project="$project_id" >/dev/null
  gcloud compute routers describe "$name_prefix-router" \
    --region="$region" --project="$project_id" >/dev/null
  gcloud compute routers nats describe "$name_prefix-nat" --router="$name_prefix-router" \
    --region="$region" --project="$project_id" >/dev/null
  gcloud compute firewall-rules describe "$name_prefix-deny-ingress" \
    --project="$project_id" >/dev/null
  gcloud compute firewall-rules describe "$name_prefix-allow-egress" \
    --project="$project_id" >/dev/null
  gcloud compute addresses describe "$name_prefix-private-services" \
    --global --project="$project_id" >/dev/null
  local service_connection_output
  service_connection_output=$(gcloud services vpc-peerings list \
    --network="$name_prefix-vpc" --service=servicenetworking.googleapis.com \
    --project="$project_id" --format=json)
  if ! jq -e --arg network "/networks/$name_prefix-vpc" \
    --arg allocation "$name_prefix-private-services" \
    'any(.[];
      (.network | endswith($network))
      and .service == "services/servicenetworking.googleapis.com"
      and (.reservedPeeringRanges | index($allocation) != null))' \
    <<<"$service_connection_output" >/dev/null; then
    printf 'FAIL: exact retained Service Networking connection is absent\n' >&2
    return 1
  fi
  gcloud dns managed-zones describe "$name_prefix-private" --project="$project_id" >/dev/null
}

if [[ "${DEVELOPMENT_PLATFORM_CLEANUP_ONLY:-0}" == 1 ]]; then
  cleanup_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  state_before_cleanup=$("$terraform_bin" -chdir="$root" state list)
  cleanup_absence_report="$plan_dir/cleanup-absence.json"
  cleanup_audit_report="$plan_dir/cleanup-audit.json"
  cleanup_report="$plan_dir/cleanup.json"
  lifecycle_envelope="$plan_dir/lifecycle-envelope.json"
  destroy_platform
  "$repo_root/infra/tests/development-platform-absent.sh" "$cleanup_absence_report"
  cleanup_absence_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
    "$cleanup_absence_report" "$evidence_bucket")
  cleanup_audit_status=NOT_REQUIRED
  cleanup_audit_sha=""
  if [[ -n "$state_before_cleanup" ]]; then
    "$repo_root/infra/tests/development-platform-audit.sh" \
      "$cleanup_started_at" "$cleanup_audit_report"
    cleanup_audit_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
      "$cleanup_audit_report" "$evidence_bucket")
    cleanup_audit_status=PASS
  fi
  lifecycle_envelope_status=MISSING
  lifecycle_envelope_sha=""
  lifecycle_lookup_error="$plan_dir/lifecycle-envelope.error"
  set +e
  gcloud storage objects describe "$lifecycle_envelope_uri" \
    >"$plan_dir/lifecycle-envelope-metadata.json" 2>"$lifecycle_lookup_error"
  lifecycle_lookup_status=$?
  set -e
  if ((lifecycle_lookup_status == 0)); then
    gcloud storage cp "$lifecycle_envelope_uri" "$lifecycle_envelope" >/dev/null
    if ! jq -e \
      --arg source_commit "$source_commit" \
      --arg lifecycle_run_id "$lifecycle_run_id" \
      '.source.commit_sha == $source_commit and .lifecycle_run_id == $lifecycle_run_id' \
      "$lifecycle_envelope" >/dev/null; then
      printf 'FAIL: lifecycle envelope does not match cleanup source and run\n' >&2
      exit 1
    fi
    lifecycle_envelope_sha=$(sha256sum "$lifecycle_envelope" | cut -d' ' -f1)
    lifecycle_content_uri="gs://$evidence_bucket/roots/development/platform/sha256/$lifecycle_envelope_sha.json"
    gcloud storage cp "$lifecycle_content_uri" "$plan_dir/lifecycle-envelope-content.json" >/dev/null
    cmp "$lifecycle_envelope" "$plan_dir/lifecycle-envelope-content.json"
    lifecycle_envelope_status=PASS
  elif grep -Eqi '404|not found|does not exist' "$lifecycle_lookup_error"; then
    printf 'MISSING: lifecycle ended before its evidence envelope was stored\n' >&2
  else
    printf 'FAIL: lifecycle envelope lookup failed closed\n' >&2
    cat "$lifecycle_lookup_error" >&2
    exit 1
  fi
  jq -n \
    --arg source_commit "$source_commit" \
    --arg variable_set_sha256 "$varset_sha" \
    --arg image_digests_sha256 "$image_digests_sha" \
    --argjson destroy_plan_bindings "$destroy_bindings_json" \
    --arg absence_report_sha256 "$cleanup_absence_sha" \
    --arg audit_status "$cleanup_audit_status" \
    --arg audit_report_sha256 "$cleanup_audit_sha" \
    --arg lifecycle_run_id "$lifecycle_run_id" \
    --arg lifecycle_envelope_status "$lifecycle_envelope_status" \
    --arg lifecycle_envelope_sha256 "$lifecycle_envelope_sha" \
    '{schema_version: 1, qualification: "PARTIAL", source: {
      commit_sha: $source_commit,
      clean_tree: true,
      variable_set_sha256: $variable_set_sha256,
      image_digests_sha256: $image_digests_sha256,
      destroy_plan_bindings: $destroy_plan_bindings
    }, checks: {
      exact_disposable_destroy: "PASS",
      empty_disposable_state: "PASS",
      negative_provider_lookups: "PASS",
      retained_environment_baseline: "PASS",
      audit_history_retained: $audit_status,
      lifecycle_evidence_linkage: $lifecycle_envelope_status
    }, absence_report_sha256: $absence_report_sha256,
    audit_report_sha256: $audit_report_sha256,
    lifecycle: {
      run_id: $lifecycle_run_id,
      envelope_status: $lifecycle_envelope_status,
      envelope_sha256: $lifecycle_envelope_sha256
    }}' >"$cleanup_report"
  cleanup_report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
    "$cleanup_report" "$evidence_bucket")
  printf 'PASS: independent cleanup completed source=%s absence_evidence=%s audit=%s lifecycle_link=%s cleanup_evidence=%s\n' \
    "$source_commit" "$cleanup_absence_sha" "$cleanup_audit_status" \
    "$lifecycle_envelope_status" "$cleanup_report_sha"
  exit 0
fi

"$repo_root/infra/tests/development-platform-preflight.sh"

create_plan="$plan_dir/create.tfplan"
"$repo_root/infra/scripts/create-plan.sh" development "$root" "$create_plan"
"$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$create_plan"
create_binding=$(jq -r '.binding_sha256' "$create_plan.manifest.json")
"$repo_root/infra/scripts/apply-plan.sh" development "$root" "$create_plan"

second_plan="$plan_dir/second.tfplan"
"$repo_root/infra/scripts/create-plan.sh" development "$root" "$second_plan" -detailed-exitcode
"$repo_root/infra/scripts/store-plan.sh" "$SAVED_PLAN_BUCKET" "$second_plan"
second_binding=$(jq -r '.binding_sha256' "$second_plan.manifest.json")

smoke_output=$("$repo_root/infra/tests/development-platform-smoke.sh")
printf '%s\n' "$smoke_output"
managed_report_sha=$(sed -n 's/.*evidence=//p' <<<"$smoke_output" | tail -1)
managed_qualification=$(sed -n 's/^qualification=\([^ ]*\).*/\1/p' <<<"$smoke_output" | tail -1)
temporal_qualification=$(sed -n 's/.*temporal=\([^ ]*\).*/\1/p' <<<"$smoke_output" | tail -1)
test -n "$managed_report_sha"
[[ "$managed_qualification" =~ ^(PASS|MISSING)$ ]]
[[ "$temporal_qualification" =~ ^(PASS|MISSING)$ ]]

lifecycle_envelope="$plan_dir/lifecycle-envelope.json"
jq -n \
  --arg lifecycle_run_id "$lifecycle_run_id" \
  --arg source_commit "$source_commit" \
  --arg variable_set_sha256 "$varset_sha" \
  --arg image_digests_sha256 "$image_digests_sha" \
  --arg create_plan_binding_sha256 "$create_binding" \
  --arg second_plan_binding_sha256 "$second_binding" \
  --arg managed_report_sha256 "$managed_report_sha" \
  --arg managed_qualification "$managed_qualification" \
  --arg temporal_qualification "$temporal_qualification" \
  '{schema_version: 1, qualification: "PARTIAL", lifecycle_run_id: $lifecycle_run_id,
    source: {
      commit_sha: $source_commit,
      clean_tree: true,
      variable_set_sha256: $variable_set_sha256,
      image_digests_sha256: $image_digests_sha256
    }, create_plan_binding_sha256: $create_plan_binding_sha256,
    second_plan_binding_sha256: $second_plan_binding_sha256,
    managed_report_sha256: $managed_report_sha256,
    checks: {
      managed_qualification: $managed_qualification,
      temporal_qualification: $temporal_qualification
    }}' >"$lifecycle_envelope"
lifecycle_envelope_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$lifecycle_envelope" "$evidence_bucket")
lifecycle_locator_error="$plan_dir/lifecycle-locator.error"
set +e
gcloud storage objects describe "$lifecycle_envelope_uri" \
  >"$plan_dir/lifecycle-locator-metadata.json" 2>"$lifecycle_locator_error"
lifecycle_locator_status=$?
set -e
if ((lifecycle_locator_status == 0)); then
  gcloud storage cp "$lifecycle_envelope_uri" "$plan_dir/existing-lifecycle-envelope.json" >/dev/null
  cmp "$lifecycle_envelope" "$plan_dir/existing-lifecycle-envelope.json"
elif grep -Eqi '404|not found|does not exist' "$lifecycle_locator_error"; then
  gcloud storage cp --if-generation-match=0 \
    "$lifecycle_envelope" "$lifecycle_envelope_uri" >/dev/null
else
  printf 'FAIL: lifecycle envelope locator lookup failed closed\n' >&2
  cat "$lifecycle_locator_error" >&2
  exit 1
fi

printf 'qualification=%s temporal=%s lifecycle=MISSING create_binding=%s second_binding=%s evidence=%s lifecycle_envelope=%s source=%s inputs=%s images=%s\n' \
  "$managed_qualification" "$temporal_qualification" "$create_binding" "$second_binding" \
  "$managed_report_sha" "$lifecycle_envelope_sha" "$source_commit" "$varset_sha" "$image_digests_sha"
exit 3

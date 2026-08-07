#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -r '.project_id' "$varset")
artifact_bucket=$(jq -r '.artifact_bucket_name' "$varset")
evidence_bucket=$(jq -r '.evidence_archive_bucket_name' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
platform_account=$(jq -r '.terraform_service_account_email' "$varset")
expected_account=${FOUNDATION_SERVICE_ACCOUNT:?FOUNDATION_SERVICE_ACCOUNT is required}
effective_account=${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}
role_id=osfoDevelopmentArtifactCleaner
role="projects/$project_id/roles/$role_id"
member="serviceAccount:$expected_account"
condition="resource.name == 'projects/_/buckets/$artifact_bucket' || resource.name.startsWith('projects/_/buckets/$artifact_bucket/objects/')"
foundation_project_id="osfo-foundation-${project_id##*-}"
evidence_member="serviceAccount:$platform_account"
evidence_object_role="projects/$foundation_project_id/roles/osfoSavedPlanObjectAccess"
evidence_list_role="projects/$foundation_project_id/roles/osfoStateObjectLister"
evidence_condition="resource.name.startsWith('projects/_/buckets/$evidence_bucket/objects/roots/development/platform/')"
dns_record_role_id=osfoPlatformDnsRecordManager
dns_record_role="projects/$project_id/roles/$dns_record_role_id"
dns_change_role_id=osfoPlatformDnsChangeManager
dns_change_role="projects/$project_id/roles/$dns_change_role_id"
dns_member="serviceAccount:$platform_account"

if [[ "$effective_account" != "$expected_account" ]]; then
  printf 'FAIL: recovery preflight requires foundation identity %s, got %s\n' \
    "$expected_account" "$effective_account" >&2
  exit 1
fi
if [[ ! "$artifact_bucket" =~ ^osfo-development-artifacts-[0-9]+$ ]]; then
  printf 'FAIL: refusing unreviewed recovery bucket %s\n' "$artifact_bucket" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
if ! gcloud iam roles describe "$role_id" --project="$project_id" --format=json \
  >"$scratch/role.json" 2>"$scratch/role.error"; then
  printf 'FAIL: reviewed artifact recovery role is not applied\n' >&2
  cat "$scratch/role.error" >&2
  exit 1
fi
jq -e '
  (.includedPermissions | sort) == [
    "storage.buckets.get",
    "storage.objects.delete",
    "storage.objects.get",
    "storage.objects.list"
  ]
  and .deleted != true
' "$scratch/role.json" >/dev/null || {
  printf 'FAIL: applied artifact recovery role does not have the exact reviewed permissions\n' >&2
  exit 1
}

if ! gcloud projects get-iam-policy "$project_id" --format=json \
  >"$scratch/policy.json" 2>"$scratch/policy.error"; then
  printf 'FAIL: unable to verify applied artifact recovery binding\n' >&2
  cat "$scratch/policy.error" >&2
  exit 1
fi
jq -e --arg role "$role" --arg member "$member" --arg condition "$condition" '
  any(.bindings[];
    .role == $role
    and (.members | index($member) != null)
    and .condition.expression == $condition)
' "$scratch/policy.json" >/dev/null || {
  printf 'FAIL: exact foundation artifact recovery binding is not applied\n' >&2
  exit 1
}

if ! gcloud dns managed-zones describe "$name_prefix-private" \
  --project="$project_id" --format=json \
  >"$scratch/zone.json" 2>"$scratch/zone.error"; then
  printf 'FAIL: unable to verify retained private zone identity\n' >&2
  cat "$scratch/zone.error" >&2
  exit 1
fi
zone_id=$(jq -r '.id | select(type == "string" and test("^[0-9]+$"))' \
  "$scratch/zone.json")
if [[ -z "$zone_id" ]]; then
  printf 'FAIL: retained private zone did not expose its numeric managed-zone ID\n' >&2
  exit 1
fi
dns_condition="resource.type == 'dns.googleapis.com/ResourceRecordSet' && resource.name == 'projects/$project_id/managedZones/$zone_id/rrsets/database.temporal.internal./A'"

for dns_role_id in "$dns_record_role_id" "$dns_change_role_id"; do
  if ! gcloud iam roles describe "$dns_role_id" --project="$project_id" --format=json \
    >"$scratch/$dns_role_id.json" 2>"$scratch/$dns_role_id.error"; then
    printf 'FAIL: reviewed managed-zone DNS role %s is not applied\n' \
      "$dns_role_id" >&2
    cat "$scratch/$dns_role_id.error" >&2
    exit 1
  fi
done
jq -e '
  (.includedPermissions | sort) == [
    "dns.resourceRecordSets.create",
    "dns.resourceRecordSets.delete",
    "dns.resourceRecordSets.get",
    "dns.resourceRecordSets.update"
  ]
  and .deleted != true
' "$scratch/$dns_record_role_id.json" >/dev/null || {
  printf 'FAIL: applied managed-zone DNS record role does not have the exact reviewed permissions\n' >&2
  exit 1
}
jq -e '
  (.includedPermissions | sort) == [
    "dns.changes.create",
    "dns.changes.get",
    "dns.managedZones.get",
    "dns.resourceRecordSets.list"
  ]
  and .deleted != true
' "$scratch/$dns_change_role_id.json" >/dev/null || {
  printf 'FAIL: applied managed-zone DNS prerequisite role does not have the exact reviewed permissions\n' >&2
  exit 1
}

if ! gcloud dns managed-zones get-iam-policy "$name_prefix-private" \
  --project="$project_id" --format=json \
  >"$scratch/zone-policy.json" 2>"$scratch/zone-policy.error"; then
  printf 'FAIL: unable to verify retained private zone IAM policy\n' >&2
  cat "$scratch/zone-policy.error" >&2
  exit 1
fi
jq -e --arg role "$dns_record_role" --arg member "$dns_member" --arg condition "$dns_condition" '
  any(.bindings[];
    .role == $role
    and (.members | index($member) != null)
    and .condition.expression == $condition)
' "$scratch/zone-policy.json" >/dev/null || {
  printf 'FAIL: exact managed-zone DNS record binding is not applied\n' >&2
  exit 1
}
jq -e --arg role "$dns_change_role" --arg member "$dns_member" '
  any(.bindings[];
    .role == $role
    and (.members | index($member) != null)
    and (.condition == null))
' "$scratch/zone-policy.json" >/dev/null || {
  printf 'FAIL: unconditional managed-zone DNS prerequisite binding is not applied\n' >&2
  exit 1
}

if ! gcloud storage buckets get-iam-policy "gs://$evidence_bucket" --format=json \
  >"$scratch/evidence-policy.json" 2>"$scratch/evidence-policy.error"; then
  printf 'FAIL: unable to verify development evidence bucket policy\n' >&2
  cat "$scratch/evidence-policy.error" >&2
  exit 1
fi
jq -e \
  --arg object_role "$evidence_object_role" \
  --arg list_role "$evidence_list_role" \
  --arg member "$evidence_member" \
  --arg condition "$evidence_condition" '
  any(.bindings[];
    .role == $object_role
    and (.members | index($member) != null)
    and .condition.expression == $condition)
  and any(.bindings[];
    .role == $list_role
    and (.members | index($member) != null)
    and (.condition == null))
' "$scratch/evidence-policy.json" >/dev/null || {
  printf 'FAIL: exact development evidence writer, reader, and lister bindings are not applied\n' >&2
  exit 1
}

printf 'PASS: exact artifact recovery, managed-zone DNS, and evidence bindings are applied\n'

#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -r '.project_id' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
platform_account=$(jq -r '.terraform_service_account_email' "$varset")
expected_account=${FOUNDATION_SERVICE_ACCOUNT:?FOUNDATION_SERVICE_ACCOUNT is required}
if [[ -n "${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-}" ]]; then
  effective_account=$CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
elif ! effective_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)'); then
  printf 'FAIL: DNS policy preflight could not read the active account\n' >&2
  exit 1
fi

if [[ "$effective_account" != "$expected_account" ]]; then
  printf 'FAIL: DNS policy preflight requires foundation identity %s, got %s\n' \
    "$expected_account" "$effective_account" >&2
  exit 1
fi
if [[ ! "$project_id" =~ ^osfo-development-[0-9]+$ ]] \
  || [[ "$name_prefix-private" != osfo-dev-private ]]; then
  printf 'FAIL: DNS policy preflight refuses unreviewed target %s/%s-private\n' \
    "$project_id" "$name_prefix" >&2
  exit 1
fi

record_role_id=osfoPlatformDnsRecordManager
record_role="projects/$project_id/roles/$record_role_id"
change_role_id=osfoPlatformDnsChangeManager
change_role="projects/$project_id/roles/$change_role_id"
foundation_role_id=osfoFoundationDnsZoneIamManager
foundation_role="projects/$project_id/roles/$foundation_role_id"
platform_member="serviceAccount:$platform_account"
foundation_member="serviceAccount:$expected_account"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for role_id in "$record_role_id" "$change_role_id" "$foundation_role_id"; do
  if ! gcloud iam roles describe "$role_id" --project="$project_id" --format=json \
    >"$scratch/$role_id.json" 2>"$scratch/$role_id.error"; then
    printf 'FAIL: reviewed DNS role %s is not applied\n' "$role_id" >&2
    cat "$scratch/$role_id.error" >&2
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
' "$scratch/$record_role_id.json" >/dev/null || {
  printf 'FAIL: applied DNS record role does not have the exact reviewed permissions\n' >&2
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
' "$scratch/$change_role_id.json" >/dev/null || {
  printf 'FAIL: applied DNS prerequisite role does not have the exact reviewed permissions\n' >&2
  exit 1
}
jq -e '
  (.includedPermissions | sort) == [
    "dns.managedZones.getIamPolicy",
    "dns.managedZones.setIamPolicy"
  ]
  and .deleted != true
' "$scratch/$foundation_role_id.json" >/dev/null || {
  printf 'FAIL: applied foundation DNS policy role does not have the exact reviewed permissions\n' >&2
  exit 1
}

if ! gcloud projects get-iam-policy "$project_id" --format=json \
  >"$scratch/project-policy.json" 2>"$scratch/project-policy.error"; then
  printf 'FAIL: unable to verify project DNS bootstrap policy\n' >&2
  cat "$scratch/project-policy.error" >&2
  exit 1
fi
jq -e \
  --arg foundation_role "$foundation_role" \
  --arg foundation_member "$foundation_member" \
  --arg record_role "$record_role" \
  --arg change_role "$change_role" \
  --arg platform_member "$platform_member" '
  any(.bindings[];
    .role == $foundation_role
    and .members == [$foundation_member]
    and (.condition == null))
  and (any(.bindings[];
    (.role == $record_role or .role == $change_role or .role == "roles/dns.admin")
    and (.members | index($platform_member) != null)) | not)
' "$scratch/project-policy.json" >/dev/null || {
  printf 'FAIL: project DNS bootstrap is missing or grants platform DNS authority\n' >&2
  exit 1
}

if ! gcloud dns managed-zones describe "$name_prefix-private" \
  --project="$project_id" --format=json \
  >"$scratch/zone.json" 2>"$scratch/zone.error"; then
  printf 'FAIL: unable to verify retained private zone identity\n' >&2
  cat "$scratch/zone.error" >&2
  exit 1
fi
if ! gcloud projects describe "$project_id" --format=json \
  >"$scratch/project.json" 2>"$scratch/project.error"; then
  printf 'FAIL: unable to verify development project number\n' >&2
  cat "$scratch/project.error" >&2
  exit 1
fi
project_number=$(jq -r \
  '.projectNumber | select(type == "string" and test("^[0-9]+$"))' \
  "$scratch/project.json")
if [[ -z "$project_number" ]]; then
  printf 'FAIL: development project did not expose a numeric projectNumber\n' >&2
  exit 1
fi
zone_id=$(jq -r '.id | select(type == "string" and test("^[0-9]+$"))' \
  "$scratch/zone.json")
if [[ -z "$zone_id" ]]; then
  printf 'FAIL: retained private zone did not expose its numeric managed-zone ID\n' >&2
  exit 1
fi
record_condition="resource.type == 'dns.googleapis.com/ResourceRecordSet' && resource.name == 'projects/$project_number/managedZones/$zone_id/rrsets/database.temporal.internal./A'"

if ! gcloud dns managed-zones get-iam-policy "$name_prefix-private" \
  --project="$project_id" --format=json \
  >"$scratch/zone-policy.json" 2>"$scratch/zone-policy.error"; then
  printf 'FAIL: unable to verify retained private zone IAM policy\n' >&2
  cat "$scratch/zone-policy.error" >&2
  exit 1
fi
jq -e \
  --arg record_role "$record_role" \
  --arg change_role "$change_role" \
  --arg member "$platform_member" \
  --arg condition "$record_condition" '
  (.bindings | length) == 2
  and any(.bindings[];
    .role == $record_role
    and .members == [$member]
    and .condition.expression == $condition)
  and any(.bindings[];
    .role == $change_role
    and .members == [$member]
    and (.condition == null))
' "$scratch/zone-policy.json" >/dev/null || {
  printf 'FAIL: managed-zone policy is not exactly the two reviewed platform bindings\n' >&2
  exit 1
}

printf 'PASS: exact foundation bootstrap and managed-zone DNS policy are applied\n'

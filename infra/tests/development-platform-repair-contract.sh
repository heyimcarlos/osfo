#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mock_bin=$scratch/bin
mkdir -p "$mock_bin"

printf '%s\n' '#!/usr/bin/env bash' 'exit 23' >"$mock_bin/terraform-fail"
chmod +x "$mock_bin/terraform-fail"

smoke_output=$scratch/smoke-output
if SMOKE_TEST_CREDENTIAL=must-not-appear \
  TERRAFORM_BIN="$mock_bin/terraform-fail" \
  infra/tests/development-platform-smoke.sh >"$smoke_output" 2>&1; then
  printf 'forced smoke failure must return nonzero\n' >&2
  exit 1
fi
grep -Fq 'FAIL: development smoke stage terraform-output failed with status 23' \
  "$smoke_output"
if grep -Fq 'must-not-appear' "$smoke_output"; then
  printf 'smoke diagnostics must not print credentials or environment values\n' >&2
  exit 1
fi

# This is a jq program, not a shell expression.
# shellcheck disable=SC2016
subscription_contract='
  .topic == $topic
  and .enableMessageOrdering == true
  and .messageRetentionDuration == $retention
  and (.retainAckedMessages // false) == false
'
if ! jq -e \
  --arg topic projects/example/topics/osfo-dev-agentruns \
  --arg retention 604800s \
  "$subscription_contract" \
  <<<'{"topic":"projects/example/topics/osfo-dev-agentruns","enableMessageOrdering":true,"messageRetentionDuration":"604800s"}' \
  >/dev/null; then
  printf 'omitted retainAckedMessages must normalize to false\n' >&2
  exit 1
fi
if jq -e \
  --arg topic projects/example/topics/osfo-dev-agentruns \
  --arg retention 604800s \
  "$subscription_contract" \
  <<<'{"topic":"projects/example/topics/osfo-dev-agentruns","enableMessageOrdering":true,"messageRetentionDuration":"604800s","retainAckedMessages":true}' \
  >/dev/null; then
  printf 'retainAckedMessages=true must fail the managed subscription contract\n' >&2
  exit 1
fi

# The single-quoted lines are the source of the generated mock, not expressions
# for this contract process.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "auth list"*) printf "%s\n" "$FOUNDATION_SERVICE_ACCOUNT" ;;' \
  '  "storage buckets describe"*)' \
  '    if [[ "${MOCK_STORAGE_MODE:-empty}" == permission ]]; then' \
  '      printf "PERMISSION_DENIED: storage.buckets.get\n" >&2' \
  '      exit 1' \
  '    fi' \
  '    printf "%s\n" "{\"name\":\"osfo-development-artifacts-318708913\"}"' \
  '    ;;' \
  '  "storage ls --all-versions --recursive --json gs://osfo-development-artifacts-318708913")' \
    '    if [[ "${MOCK_STORAGE_MODE:-empty}" == list-permission ]]; then' \
    '      printf "PERMISSION_DENIED: storage.objects.list\n" >&2' \
    '      exit 1' \
    '    fi' \
    '    if [[ "${MOCK_STORAGE_MODE:-empty}" == empty ]]; then' \
    '      printf "%s\n" "[{\"url\":\"gs://osfo-development-artifacts-318708913\",\"type\":\"unknown\"}]"' \
    '    elif [[ "${MOCK_STORAGE_MODE:-empty}" == populated ]]; then' \
    '      list_count=0' \
    '      [[ ! -f "$MOCK_STORAGE_CALLS" ]] || list_count=$(<"$MOCK_STORAGE_CALLS")' \
    '      printf "%s\n" "$((list_count + 1))" >"$MOCK_STORAGE_CALLS"' \
    '      if ((list_count == 0)); then' \
    '        printf "%s\n" "[{\"url\":\"gs://osfo-development-artifacts-318708913\",\"type\":\"unknown\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/\",\"type\":\"prefix\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#100\",\"type\":\"cloud_object\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#101\",\"type\":\"cloud_object\"}]"' \
    '      else' \
    '        printf "%s\n" "[{\"url\":\"gs://osfo-development-artifacts-318708913\",\"type\":\"unknown\"}]"' \
    '      fi' \
    '    elif [[ "${MOCK_STORAGE_MODE:-empty}" == header-like-object ]]; then' \
    '      printf "%s\n" "[{\"url\":\"gs://osfo-development-artifacts-318708913\",\"type\":\"unknown\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/\",\"type\":\"prefix\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:\",\"type\":\"cloud_object\"}]"' \
    '    elif [[ "${MOCK_STORAGE_MODE:-empty}" == unexpected-type ]]; then' \
    '      printf "%s\n" "[{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/\",\"type\":\"directory\"}]"' \
    '    elif [[ "${MOCK_STORAGE_MODE:-empty}" == blank ]]; then' \
    '      :' \
    '    elif [[ "${MOCK_STORAGE_MODE:-empty}" == empty-array ]]; then' \
    '      printf "%s\n" "[]"' \
    '    elif [[ "${MOCK_STORAGE_MODE:-empty}" == unversioned-object ]]; then' \
    '      printf "%s\n" "[{\"url\":\"gs://osfo-development-artifacts-318708913\",\"type\":\"unknown\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/\",\"type\":\"prefix\"},{\"url\":\"gs://osfo-development-artifacts-318708913/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"type\":\"cloud_object\"}]"' \
    '    fi' \
    '    ;;' \
  '  "storage ls"*)' \
  '    printf "artifact listing must use the bucket-root recursive form: %s\n" "$*" >&2' \
  '    exit 92' \
  '    ;;' \
    '  "storage rm"*) printf "%s\n" "${*:3}" >>"$MOCK_STORAGE_REMOVALS" ;;' \
  '  "storage objects describe"*)' \
  '    if [[ "${MOCK_STORAGE_MODE:-empty}" == evidence-permission ]]; then' \
  '      printf "PERMISSION_DENIED: storage.objects.get\n" >&2' \
  '      exit 1' \
  '    fi' \
  '    printf "404: object not found\n" >&2' \
  '    exit 1' \
  '    ;;' \
  '  "storage cp"*) exit 0 ;;' \
  '  *) printf "unexpected mock gcloud invocation: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

foundation_account=osfo-foundation-tf@osfo-foundation-318708913.iam.gserviceaccount.com
empty_output=$scratch/empty-output
PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$empty_output" 2>&1
grep -Fq 'PASS: disposable artifact bucket is empty' "$empty_output"

populated_output=$scratch/populated-output
storage_calls=$scratch/storage-calls
storage_removals=$scratch/storage-removals
PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_STORAGE_MODE=populated \
  MOCK_STORAGE_CALLS=$storage_calls \
  MOCK_STORAGE_REMOVALS=$storage_removals \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$populated_output" 2>&1
grep -Fq 'PASS: foundation recovery removed only reviewed content-addressed artifact objects' \
  "$populated_output"
cat >"$scratch/expected-storage-removals" <<'EOF'
gs://osfo-development-artifacts-318708913/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#100
gs://osfo-development-artifacts-318708913/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#101
EOF
cmp "$scratch/expected-storage-removals" "$storage_removals"

header_like_output=$scratch/header-like-output
if PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_STORAGE_MODE=header-like-object \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$header_like_output" 2>&1; then
  printf 'header-like object name must fail exact artifact validation\n' >&2
  exit 1
fi
grep -Fq 'FAIL: refusing unexpected artifact object' "$header_like_output"
if grep -Fq 'PASS:' "$header_like_output"; then
  printf 'header-like object rejection must not report PASS\n' >&2
  exit 1
fi

unexpected_type_output=$scratch/unexpected-type-output
if PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_STORAGE_MODE=unexpected-type \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$unexpected_type_output" 2>&1; then
  printf 'unexpected structured listing type must fail closed\n' >&2
  exit 1
fi
grep -Fq 'FAIL: artifact object listing was not valid structured object metadata' \
  "$unexpected_type_output"
if grep -Fq 'PASS:' "$unexpected_type_output"; then
  printf 'unexpected structured listing type must not report PASS\n' >&2
  exit 1
fi

for invalid_empty_mode in blank empty-array; do
  invalid_empty_output="$scratch/$invalid_empty_mode-output"
  if PATH="$mock_bin:$PATH" \
    FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
    MOCK_STORAGE_MODE=$invalid_empty_mode \
    TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
    infra/tests/development-platform-prepare-cleanup.sh \
    >"$invalid_empty_output" 2>&1; then
    printf '%s structured listing must fail closed\n' "$invalid_empty_mode" >&2
    exit 1
  fi
  grep -Eq \
    'FAIL: artifact object listing (omitted the required bucket root metadata|was not valid structured object metadata)' \
    "$invalid_empty_output"
  if grep -Fq 'PASS:' "$invalid_empty_output"; then
    printf '%s structured listing must not report PASS\n' "$invalid_empty_mode" >&2
    exit 1
  fi
done

unversioned_output=$scratch/unversioned-output
if PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_STORAGE_MODE=unversioned-object \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$unversioned_output" 2>&1; then
  printf 'unversioned cloud object must fail exact-generation validation\n' >&2
  exit 1
fi
grep -Fq 'FAIL: refusing unexpected artifact object' "$unversioned_output"
if grep -Fq 'PASS:' "$unversioned_output"; then
  printf 'unversioned cloud object rejection must not report PASS\n' >&2
  exit 1
fi

permission_output=$scratch/permission-output
if PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_STORAGE_MODE=permission \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$permission_output" 2>&1; then
  printf 'bucket metadata permission failure must return nonzero\n' >&2
  exit 1
fi
grep -Fq 'FAIL: artifact bucket lookup failed closed' "$permission_output"
grep -Fq 'PERMISSION_DENIED: storage.buckets.get' "$permission_output"
if grep -Fq 'PASS:' "$permission_output"; then
  printf 'bucket metadata permission failure must not report PASS\n' >&2
  exit 1
fi

list_permission_output=$scratch/list-permission-output
if PATH="$mock_bin:$PATH" \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_STORAGE_MODE=list-permission \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-prepare-cleanup.sh >"$list_permission_output" 2>&1; then
  printf 'artifact object listing failure must return nonzero\n' >&2
  exit 1
fi
grep -Fq 'FAIL: artifact object listing failed closed' "$list_permission_output"
if grep -Fq 'PASS:' "$list_permission_output"; then
  printf 'artifact cleanup failure must not report PASS\n' >&2
  exit 1
fi

printf 'evidence\n' >"$scratch/evidence.json"
evidence_permission_output=$scratch/evidence-permission-output
if PATH="$mock_bin:$PATH" \
  MOCK_STORAGE_MODE=evidence-permission \
  infra/tests/store-development-evidence.sh \
    "$scratch/evidence.json" osfo-foundation-evidence-318708913 \
    >"$evidence_permission_output" 2>&1; then
  printf 'evidence lookup permission failure must return nonzero\n' >&2
  exit 1
fi
grep -Fq 'FAIL: development evidence lookup failed closed' \
  "$evidence_permission_output"
grep -Fq 'PERMISSION_DENIED: storage.objects.get' \
  "$evidence_permission_output"

project_id=osfo-development-318708913
# Synthetic fixture, never a live Google Cloud project number.
project_number=123456789012
platform_account=osfo-dev-platform-tf@osfo-development-318708913.iam.gserviceaccount.com
artifact_bucket=osfo-development-artifacts-318708913
evidence_bucket=osfo-foundation-evidence-318708913
zone_id=123456789
artifact_role="projects/$project_id/roles/osfoDevelopmentArtifactCleaner"
artifact_condition="resource.name == 'projects/_/buckets/$artifact_bucket' || resource.name.startsWith('projects/_/buckets/$artifact_bucket/objects/')"
dns_record_role="projects/$project_id/roles/osfoPlatformDnsRecordManager"
dns_change_role="projects/$project_id/roles/osfoPlatformDnsChangeManager"
dns_foundation_role="projects/$project_id/roles/osfoFoundationDnsZoneIamManager"
dns_condition="resource.type == 'dns.googleapis.com/ResourceRecordSet' && resource.name == 'projects/$project_number/managedZones/$zone_id/rrsets/database.temporal.internal./A'"
evidence_object_role=projects/osfo-foundation-318708913/roles/osfoSavedPlanObjectAccess
evidence_list_role=projects/osfo-foundation-318708913/roles/osfoStateObjectLister
evidence_condition="resource.name.startsWith('projects/_/buckets/$evidence_bucket/objects/roots/development/platform/')"

jq -n '{
  includedPermissions: [
    "storage.buckets.get",
    "storage.objects.delete",
    "storage.objects.get",
    "storage.objects.list"
  ],
  deleted: false
}' >"$scratch/preflight-role.json"
jq -n \
  --arg artifact_role "$artifact_role" \
  --arg foundation_member "serviceAccount:$foundation_account" \
  --arg artifact_condition "$artifact_condition" \
  --arg dns_foundation_role "$dns_foundation_role" \
  '{bindings: [
    {
      role: $artifact_role,
      members: [$foundation_member],
      condition: {expression: $artifact_condition}
    },
    {
      role: $dns_foundation_role,
      members: [$foundation_member]
    }
  ]}' >"$scratch/preflight-project-policy.json"
jq -n --arg project_number "$project_number" \
  '{projectNumber: $project_number}' >"$scratch/preflight-project.json"
jq -n '{projectNumber: "osfo-development-318708913"}' \
  >"$scratch/preflight-project-invalid.json"
jq -n '{
  includedPermissions: [
    "dns.resourceRecordSets.create",
    "dns.resourceRecordSets.delete",
    "dns.resourceRecordSets.get",
    "dns.resourceRecordSets.update"
  ],
  deleted: false
}' >"$scratch/preflight-dns-record-role.json"
jq -n '{
  includedPermissions: [
    "dns.changes.create",
    "dns.changes.get",
    "dns.managedZones.get",
    "dns.resourceRecordSets.list"
  ],
  deleted: false
}' >"$scratch/preflight-dns-change-role.json"
jq -n '{
  includedPermissions: [
    "dns.managedZones.getIamPolicy",
    "dns.managedZones.setIamPolicy"
  ],
  deleted: false
}' >"$scratch/preflight-dns-foundation-role.json"
jq -n \
  --arg dns_record_role "$dns_record_role" \
  --arg dns_change_role "$dns_change_role" \
  --arg platform_member "serviceAccount:$platform_account" \
  --arg dns_condition "$dns_condition" \
  '{bindings: [
    {
      role: $dns_record_role,
      members: [$platform_member],
      condition: {expression: $dns_condition}
    },
    {
      role: $dns_change_role,
      members: [$platform_member]
    }
  ]}' >"$scratch/preflight-zone-policy.json"
jq \
  --arg stale_condition "resource.type == 'dns.googleapis.com/ResourceRecordSet' && resource.name == 'projects/$project_id/managedZones/$zone_id/rrsets/database.temporal.internal./A'" \
  '(.bindings[] | select(.role | endswith("/osfoPlatformDnsRecordManager")) | .condition.expression) = $stale_condition' \
  "$scratch/preflight-zone-policy.json" \
  >"$scratch/preflight-zone-policy-project-id.json"
jq -n '{bindings: []}' >"$scratch/preflight-zone-policy-empty.json"
jq '.bindings += [{role: "roles/dns.admin", members: ["serviceAccount:unexpected@example.com"]}]' \
  "$scratch/preflight-zone-policy.json" \
  >"$scratch/preflight-zone-policy-extra.json"
jq --arg role "$dns_record_role" --arg member "serviceAccount:$platform_account" \
  '.bindings += [{role: $role, members: [$member]}]' \
  "$scratch/preflight-project-policy.json" \
  >"$scratch/preflight-project-policy-stale-dns.json"
jq -n --arg id "$zone_id" '{id: $id}' >"$scratch/preflight-zone.json"
jq -n \
  --arg object_role "$evidence_object_role" \
  --arg list_role "$evidence_list_role" \
  --arg platform_member "serviceAccount:$platform_account" \
  --arg evidence_condition "$evidence_condition" \
  '{bindings: [
    {
      role: $object_role,
      members: [$platform_member],
      condition: {expression: $evidence_condition}
    },
    {
      role: $list_role,
      members: [$platform_member]
    }
  ]}' >"$scratch/preflight-evidence-policy.json"
jq '.bindings |= map(select(.role | endswith("/osfoStateObjectLister") | not))' \
  "$scratch/preflight-evidence-policy.json" \
  >"$scratch/preflight-evidence-policy-missing-list.json"

# The single-quoted lines are the source of the generated mock, not expressions
# for this contract process.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "iam roles describe osfoDevelopmentArtifactCleaner --project=osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_ROLE" ;;' \
  '  "iam roles describe osfoPlatformDnsRecordManager --project=osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_DNS_RECORD_ROLE" ;;' \
  '  "iam roles describe osfoPlatformDnsChangeManager --project=osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_DNS_CHANGE_ROLE" ;;' \
  '  "iam roles describe osfoFoundationDnsZoneIamManager --project=osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_DNS_FOUNDATION_ROLE" ;;' \
  '  "iam roles describe"*)' \
  '    printf "role lookup requires exact ID, project, and JSON format: %s\n" "$*" >&2' \
  '    exit 93' \
  '    ;;' \
  '  "projects get-iam-policy osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_PROJECT_POLICY" ;;' \
  '  "projects describe osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_PROJECT" ;;' \
  '  "projects describe"*)' \
  '    printf "project lookup requires the exact project and JSON format: %s\n" "$*" >&2' \
  '    exit 96' \
  '    ;;' \
  '  "projects get-iam-policy"*)' \
  '    printf "project policy lookup requires the exact project and JSON format: %s\n" "$*" >&2' \
  '    exit 95' \
  '    ;;' \
  '  "dns managed-zones describe osfo-dev-private --project=osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_ZONE" ;;' \
  '  "dns managed-zones get-iam-policy osfo-dev-private --project=osfo-development-318708913 --format=json") cat "$MOCK_PREFLIGHT_ZONE_POLICY" ;;' \
  '  "dns managed-zones"*)' \
  '    printf "zone lookup requires the exact zone, project, and JSON format: %s\n" "$*" >&2' \
  '    exit 94' \
  '    ;;' \
  '  storage\ buckets\ get-iam-policy*--format=json) cat "$MOCK_PREFLIGHT_EVIDENCE_POLICY" ;;' \
  '  storage\ buckets\ get-iam-policy*)' \
  '    printf "evidence policy lookup requires --format=json\n" >&2' \
  '    exit 91' \
  '    ;;' \
  '  *) printf "unexpected preflight gcloud invocation: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

preflight_output=$scratch/preflight-output
PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_PREFLIGHT_ROLE="$scratch/preflight-role.json" \
  MOCK_PREFLIGHT_PROJECT_POLICY="$scratch/preflight-project-policy.json" \
  MOCK_PREFLIGHT_EVIDENCE_POLICY="$scratch/preflight-evidence-policy.json" \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-recovery-preflight.sh \
  >"$preflight_output" 2>&1
grep -Fq 'PASS: exact artifact recovery and evidence bindings are applied' \
  "$preflight_output"

preflight_missing_list_output=$scratch/preflight-missing-list-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_PREFLIGHT_ROLE="$scratch/preflight-role.json" \
  MOCK_PREFLIGHT_PROJECT_POLICY="$scratch/preflight-project-policy.json" \
  MOCK_PREFLIGHT_EVIDENCE_POLICY="$scratch/preflight-evidence-policy-missing-list.json" \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-recovery-preflight.sh \
  >"$preflight_missing_list_output" 2>&1; then
  printf 'missing evidence list authority must fail recovery preflight\n' >&2
  exit 1
fi
grep -Fq 'FAIL: exact development evidence writer, reader, and lister bindings are not applied' \
  "$preflight_missing_list_output"
if grep -Fq 'PASS:' "$preflight_missing_list_output"; then
  printf 'missing evidence list authority must not report PASS\n' >&2
  exit 1
fi

dns_policy_output=$scratch/dns-policy-output
PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_PREFLIGHT_DNS_RECORD_ROLE="$scratch/preflight-dns-record-role.json" \
  MOCK_PREFLIGHT_DNS_CHANGE_ROLE="$scratch/preflight-dns-change-role.json" \
  MOCK_PREFLIGHT_DNS_FOUNDATION_ROLE="$scratch/preflight-dns-foundation-role.json" \
  MOCK_PREFLIGHT_PROJECT="$scratch/preflight-project.json" \
  MOCK_PREFLIGHT_PROJECT_POLICY="$scratch/preflight-project-policy.json" \
  MOCK_PREFLIGHT_ZONE="$scratch/preflight-zone.json" \
  MOCK_PREFLIGHT_ZONE_POLICY="$scratch/preflight-zone-policy.json" \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-policy-preflight.sh \
  >"$dns_policy_output" 2>&1
grep -Fq 'PASS: exact foundation bootstrap and managed-zone DNS policy are applied' \
  "$dns_policy_output"

dns_policy_invalid_project_output=$scratch/dns-policy-invalid-project-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_PREFLIGHT_DNS_RECORD_ROLE="$scratch/preflight-dns-record-role.json" \
  MOCK_PREFLIGHT_DNS_CHANGE_ROLE="$scratch/preflight-dns-change-role.json" \
  MOCK_PREFLIGHT_DNS_FOUNDATION_ROLE="$scratch/preflight-dns-foundation-role.json" \
  MOCK_PREFLIGHT_PROJECT="$scratch/preflight-project-invalid.json" \
  MOCK_PREFLIGHT_PROJECT_POLICY="$scratch/preflight-project-policy.json" \
  MOCK_PREFLIGHT_ZONE="$scratch/preflight-zone.json" \
  MOCK_PREFLIGHT_ZONE_POLICY="$scratch/preflight-zone-policy.json" \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-policy-preflight.sh \
  >"$dns_policy_invalid_project_output" 2>&1; then
  printf 'nonnumeric projectNumber must fail DNS policy preflight\n' >&2
  exit 1
fi
grep -Fq 'FAIL: development project did not expose a numeric projectNumber' \
  "$dns_policy_invalid_project_output"
if grep -Fq 'PASS:' "$dns_policy_invalid_project_output"; then
  printf 'nonnumeric projectNumber must not report PASS\n' >&2
  exit 1
fi

dns_policy_missing_zone_output=$scratch/dns-policy-missing-zone-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_PREFLIGHT_DNS_RECORD_ROLE="$scratch/preflight-dns-record-role.json" \
  MOCK_PREFLIGHT_DNS_CHANGE_ROLE="$scratch/preflight-dns-change-role.json" \
  MOCK_PREFLIGHT_DNS_FOUNDATION_ROLE="$scratch/preflight-dns-foundation-role.json" \
  MOCK_PREFLIGHT_PROJECT="$scratch/preflight-project.json" \
  MOCK_PREFLIGHT_PROJECT_POLICY="$scratch/preflight-project-policy.json" \
  MOCK_PREFLIGHT_ZONE="$scratch/preflight-zone.json" \
  MOCK_PREFLIGHT_ZONE_POLICY="$scratch/preflight-zone-policy-empty.json" \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-policy-preflight.sh \
  >"$dns_policy_missing_zone_output" 2>&1; then
  printf 'empty managed-zone policy must fail DNS policy preflight\n' >&2
  exit 1
fi
grep -Fq 'FAIL: managed-zone policy is not exactly the two reviewed platform bindings' \
  "$dns_policy_missing_zone_output"
if grep -Fq 'PASS:' "$dns_policy_missing_zone_output"; then
  printf 'empty managed-zone policy must not report PASS\n' >&2
  exit 1
fi

for invalid_dns_policy in extra-zone stale-project project-id-condition; do
  invalid_dns_policy_output="$scratch/dns-policy-$invalid_dns_policy-output"
  zone_policy=$scratch/preflight-zone-policy.json
  project_policy=$scratch/preflight-project-policy.json
  if [[ "$invalid_dns_policy" == extra-zone ]]; then
    zone_policy=$scratch/preflight-zone-policy-extra.json
  elif [[ "$invalid_dns_policy" == project-id-condition ]]; then
    zone_policy=$scratch/preflight-zone-policy-project-id.json
  else
    project_policy=$scratch/preflight-project-policy-stale-dns.json
  fi
  if PATH="$mock_bin:$PATH" \
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
    FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
    MOCK_PREFLIGHT_DNS_RECORD_ROLE="$scratch/preflight-dns-record-role.json" \
    MOCK_PREFLIGHT_DNS_CHANGE_ROLE="$scratch/preflight-dns-change-role.json" \
    MOCK_PREFLIGHT_DNS_FOUNDATION_ROLE="$scratch/preflight-dns-foundation-role.json" \
    MOCK_PREFLIGHT_PROJECT="$scratch/preflight-project.json" \
    MOCK_PREFLIGHT_PROJECT_POLICY="$project_policy" \
    MOCK_PREFLIGHT_ZONE="$scratch/preflight-zone.json" \
    MOCK_PREFLIGHT_ZONE_POLICY="$zone_policy" \
    TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
    infra/tests/development-platform-dns-policy-preflight.sh \
    >"$invalid_dns_policy_output" 2>&1; then
    printf '%s DNS authority must fail exact policy preflight\n' \
      "$invalid_dns_policy" >&2
    exit 1
  fi
  if grep -Fq 'PASS:' "$invalid_dns_policy_output"; then
    printf '%s DNS authority must not report PASS\n' "$invalid_dns_policy" >&2
    exit 1
  fi
done

# The single-quoted lines are the source of the generated mock, not expressions
# for this contract process.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "dns managed-zones describe osfo-dev-private --project=osfo-development-318708913 --format=json") printf "%s\n" "{\"name\":\"osfo-dev-private\"}" ;;' \
  '  "dns record-sets list --zone=osfo-dev-private --project=osfo-development-318708913 --filter=name=database.temporal.internal. AND type=A --format=json")' \
  '    if [[ "${MOCK_DNS_MODE:-success}" == existing ]] || [[ -f "$MOCK_DNS_STATE" ]]; then' \
  '      address=192.0.2.89' \
  '      [[ ! -f "$MOCK_DNS_STATE" ]] || address=$(<"$MOCK_DNS_STATE")' \
  '      printf "[{\"name\":\"database.temporal.internal.\",\"type\":\"A\",\"ttl\":30,\"rrdatas\":[\"%s\"]}]\n" "$address"' \
  '    else' \
  '      printf "%s\n" "[]"' \
  '    fi' \
  '    ;;' \
  '  "dns record-sets create database.temporal.internal. --zone=osfo-dev-private --project=osfo-development-318708913 --type=A --ttl=30 --rrdatas=192.0.2.89 --quiet")' \
  '    if [[ "${MOCK_DNS_MODE:-success}" == deny-create ]]; then' \
  '      printf "PERMISSION_DENIED: dns.resourceRecordSets.create\n" >&2' \
  '      exit 1' \
  '    fi' \
  '    printf "%s\n" 192.0.2.89 >"$MOCK_DNS_STATE"' \
  '    ;;' \
  '  "dns record-sets describe database.temporal.internal. --zone=osfo-dev-private --project=osfo-development-318708913 --type=A --format=json")' \
  '    address=$(<"$MOCK_DNS_STATE")' \
  '    printf "{\"name\":\"database.temporal.internal.\",\"type\":\"A\",\"ttl\":30,\"rrdatas\":[\"%s\"]}\n" "$address"' \
  '    ;;' \
  '  "dns record-sets update database.temporal.internal. --zone=osfo-dev-private --project=osfo-development-318708913 --type=A --ttl=30 --rrdatas=192.0.2.90 --quiet") printf "%s\n" 192.0.2.90 >"$MOCK_DNS_STATE" ;;' \
  '  "dns record-sets delete database.temporal.internal. --zone=osfo-dev-private --project=osfo-development-318708913 --type=A --quiet")' \
  '    if [[ "${MOCK_DNS_MODE:-success}" == deny-delete ]]; then' \
  '      printf "PERMISSION_DENIED: dns.resourceRecordSets.delete\n" >&2' \
  '      exit 1' \
  '    fi' \
  '    rm -f "$MOCK_DNS_STATE"' \
  '    ;;' \
  '  *) printf "unexpected DNS permission preflight invocation: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

dns_state=$scratch/dns-state
dns_preflight_output=$scratch/dns-preflight-output
PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$platform_account \
  MOCK_DNS_STATE=$dns_state \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-permission-preflight.sh \
  >"$dns_preflight_output" 2>&1
grep -Fq 'PASS: platform identity created, read, updated, and deleted only the exact DNS probe record' \
  "$dns_preflight_output"
if [[ -e "$dns_state" ]]; then
  printf 'successful DNS permission preflight must remove its exact probe record\n' >&2
  exit 1
fi

dns_denied_output=$scratch/dns-denied-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$platform_account \
  MOCK_DNS_MODE=deny-create \
  MOCK_DNS_STATE=$dns_state \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-permission-preflight.sh \
  >"$dns_denied_output" 2>&1; then
  printf 'denied exact DNS record creation must fail the live permission preflight\n' >&2
  exit 1
fi
grep -Fq 'FAIL: DNS permission preflight stage create failed' "$dns_denied_output"
grep -Fq 'PERMISSION_DENIED: dns.resourceRecordSets.create' "$dns_denied_output"
if grep -Fq 'PASS:' "$dns_denied_output"; then
  printf 'denied DNS permission preflight must not report PASS\n' >&2
  exit 1
fi

dns_existing_output=$scratch/dns-existing-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$platform_account \
  MOCK_DNS_MODE=existing \
  MOCK_DNS_STATE=$dns_state \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-permission-preflight.sh \
  >"$dns_existing_output" 2>&1; then
  printf 'existing exact DNS record must fail without mutation\n' >&2
  exit 1
fi
grep -Fq 'FAIL: DNS permission preflight refuses to replace an existing exact probe record' \
  "$dns_existing_output"
if [[ -e "$dns_state" ]] || grep -Fq 'PASS:' "$dns_existing_output"; then
  printf 'existing-record rejection must not mutate or report PASS\n' >&2
  exit 1
fi

dns_denied_delete_output=$scratch/dns-denied-delete-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$platform_account \
  MOCK_DNS_MODE=deny-delete \
  MOCK_DNS_STATE=$dns_state \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-permission-preflight.sh \
  >"$dns_denied_delete_output" 2>&1; then
  printf 'denied exact DNS record deletion must fail the live permission preflight\n' >&2
  exit 1
fi
grep -Fq 'FAIL: DNS permission preflight stage delete failed' \
  "$dns_denied_delete_output"
grep -Fq 'FAIL: DNS permission preflight could not remove its exact probe record' \
  "$dns_denied_delete_output"
if [[ ! -e "$dns_state" ]] || grep -Fq 'PASS:' "$dns_denied_delete_output"; then
  printf 'denied delete fixture must retain explicit residue without reporting PASS\n' >&2
  exit 1
fi

dns_residue_output=$scratch/dns-residue-output
PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$platform_account \
  MOCK_DNS_STATE=$dns_state \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-probe-cleanup.sh \
  >"$dns_residue_output" 2>&1
grep -Fq 'PASS: durable recovery removed only the exact DNS permission probe residue' \
  "$dns_residue_output"
if [[ -e "$dns_state" ]]; then
  printf 'durable recovery must remove canceled-probe residue\n' >&2
  exit 1
fi

printf '%s\n' 10.0.0.9 >"$dns_state"
dns_terraform_record_output=$scratch/dns-terraform-record-output
PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$platform_account \
  MOCK_DNS_STATE=$dns_state \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-dns-probe-cleanup.sh \
  >"$dns_terraform_record_output" 2>&1
grep -Fq 'PASS: exact DNS record is not permission-probe residue; Terraform retains ownership' \
  "$dns_terraform_record_output"
if [[ ! -e "$dns_state" ]]; then
  printf 'durable probe recovery must not delete a Terraform-owned exact record\n' >&2
  exit 1
fi
rm -f "$dns_state"

for workflow in \
  .github/workflows/terraform.yml \
  .github/workflows/development-platform-recovery.yml; do
  cleanup_condition=$(yq -r \
    '.jobs."development-cleanup".if // .jobs."platform-cleanup".if' "$workflow")
  grep -Fq 'always()' <<<"$cleanup_condition"
  if grep -Fq "artifact-cleanup.result == 'success'" <<<"$cleanup_condition" \
    || grep -Fq "development-artifact-cleanup.result == 'success'" \
      <<<"$cleanup_condition"; then
    printf 'Terraform destroy must not be skipped after artifact cleanup failure in %s\n' \
      "$workflow" >&2
    exit 1
  fi
done

lifecycle_needs=$(yq -r '.jobs."development-lifecycle".needs[]' \
  .github/workflows/terraform.yml)
grep -Fxq 'development-dns-permission-preflight' <<<"$lifecycle_needs"
grep -Fxq 'development-dns-policy-preflight' <<<"$lifecycle_needs"
if rg --fixed-strings --quiet "jq -e 'index(\"development-dns" "$0"; then
  printf 'workflow needs checks must consume yq scalar elements, not parse implementation-specific containers\n' >&2
  exit 1
fi
for cleanup_job in development-artifact-cleanup development-cleanup; do
  cleanup_needs=$(yq -r ".jobs.\"$cleanup_job\".needs[]" \
    .github/workflows/terraform.yml)
  grep -Fxq 'development-dns-permission-preflight' <<<"$cleanup_needs"
  grep -Fxq 'development-dns-policy-preflight' <<<"$cleanup_needs"
  cleanup_condition=$(yq -r ".jobs.\"$cleanup_job\".if" \
    .github/workflows/terraform.yml)
  if grep -Eq "development-dns-(policy|permission)-preflight.result == 'success'" \
    <<<"$cleanup_condition"; then
    printf 'cleanup must remain independent after DNS permission preflight failure\n' >&2
    exit 1
  fi
done

rg --quiet 'force_destroy\s*=\s*false' infra/modules/data-authority/main.tf
test -f infra/tests/development-platform-recovery-preflight.sh
test -x infra/tests/development-platform-dns-permission-preflight.sh
test -x infra/tests/development-platform-dns-policy-preflight.sh
test -x infra/tests/development-platform-dns-probe-cleanup.sh
rg --fixed-strings --quiet 'development-recovery-preflight' .github/workflows/terraform.yml
rg --fixed-strings --quiet \
  'resource "google_dns_managed_zone_iam_member" "development_platform_database_record"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet \
  'resource "google_dns_managed_zone_iam_member" "development_platform_database_changes"' \
  infra/roots/foundation/main.tf
if rg --fixed-strings --quiet \
  'resource "google_project_iam_member" "development_platform_database_record"' \
  infra/roots/foundation/main.tf; then
  printf 'ineffective project-level DNS record authority must not remain\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'development-dns-permission-preflight' \
  .github/workflows/terraform.yml
rg --fixed-strings --quiet 'development-dns-policy-preflight' \
  .github/workflows/terraform.yml
rg --fixed-strings --quiet 'development-platform-dns-permission-preflight.sh' \
  .github/workflows/terraform.yml
for workflow in \
  .github/workflows/terraform.yml \
  .github/workflows/development-platform-recovery.yml; do
  rg --fixed-strings --quiet 'development-platform-dns-probe-cleanup.sh' "$workflow"
  rg --fixed-strings --quiet 'steps.dns_probe_cleanup.outcome' "$workflow"
  rg --fixed-strings --quiet 'steps.platform_destroy.outcome' "$workflow"
done
rg --fixed-strings --quiet 'development-dns-permission-preflight' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  'resource "google_storage_bucket_iam_member" "development_evidence_list"' \
  infra/roots/foundation/main.tf
if rg --fixed-strings --quiet 'roles/iam.securityAdmin' infra/roots/foundation/main.tf; then
  printf 'DNS bootstrap must not grant broad IAM security administration\n' >&2
  exit 1
fi

printf 'PASS: development failure diagnostics and independent teardown contracts\n'

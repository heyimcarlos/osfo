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
platform_account=osfo-dev-platform-tf@osfo-development-318708913.iam.gserviceaccount.com
artifact_bucket=osfo-development-artifacts-318708913
evidence_bucket=osfo-foundation-evidence-318708913
zone_id=123456789
artifact_role="projects/$project_id/roles/osfoDevelopmentArtifactCleaner"
artifact_condition="resource.name == 'projects/_/buckets/$artifact_bucket' || resource.name.startsWith('projects/_/buckets/$artifact_bucket/objects/')"
dns_role="projects/$project_id/roles/osfoPlatformDnsRecordManager"
dns_condition="(resource.type == 'dns.googleapis.com/ResourceRecordSet' && resource.name == 'projects/$project_id/managedZones/$zone_id/rrsets/database.temporal.internal./A') || resource.type != 'dns.googleapis.com/ResourceRecordSet'"
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
  --arg dns_role "$dns_role" \
  --arg platform_member "serviceAccount:$platform_account" \
  --arg dns_condition "$dns_condition" \
  '{bindings: [
    {
      role: $artifact_role,
      members: [$foundation_member],
      condition: {expression: $artifact_condition}
    },
    {
      role: $dns_role,
      members: [$platform_member],
      condition: {expression: $dns_condition}
    }
  ]}' >"$scratch/preflight-project-policy.json"
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
  '  "iam roles describe"*)' \
  '    printf "artifact role lookup requires exact ID, project, and JSON format: %s\n" "$*" >&2' \
  '    exit 93' \
  '    ;;' \
  '  "projects get-iam-policy"*) cat "$MOCK_PREFLIGHT_PROJECT_POLICY" ;;' \
  '  "dns managed-zones describe"*) cat "$MOCK_PREFLIGHT_ZONE" ;;' \
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
  MOCK_PREFLIGHT_ZONE="$scratch/preflight-zone.json" \
  MOCK_PREFLIGHT_EVIDENCE_POLICY="$scratch/preflight-evidence-policy.json" \
  TF_VARSET_FILE=infra/roots/development/platform/development.tfvars.json \
  infra/tests/development-platform-recovery-preflight.sh \
  >"$preflight_output" 2>&1
grep -Fq 'PASS: exact artifact recovery, DNS record, and evidence bindings are applied' \
  "$preflight_output"

preflight_missing_list_output=$scratch/preflight-missing-list-output
if PATH="$mock_bin:$PATH" \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=$foundation_account \
  FOUNDATION_SERVICE_ACCOUNT=$foundation_account \
  MOCK_PREFLIGHT_ROLE="$scratch/preflight-role.json" \
  MOCK_PREFLIGHT_PROJECT_POLICY="$scratch/preflight-project-policy.json" \
  MOCK_PREFLIGHT_ZONE="$scratch/preflight-zone.json" \
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

rg --quiet 'force_destroy\s*=\s*false' infra/modules/data-authority/main.tf
test -f infra/tests/development-platform-recovery-preflight.sh
rg --fixed-strings --quiet 'development-recovery-preflight' .github/workflows/terraform.yml
rg --fixed-strings --quiet \
  'resource "google_project_iam_member" "development_platform_database_record"' \
  infra/roots/foundation/main.tf
if rg --fixed-strings --quiet 'google_dns_managed_zone_iam_' infra/roots/foundation/main.tf \
  || rg --fixed-strings --quiet 'dns.managedZones.setIamPolicy' infra/roots/foundation/main.tf; then
  printf 'one-off zone IAM reconciliation must not become durable foundation authority\n' >&2
  exit 1
fi
rg --fixed-strings --quiet \
  'resource "google_storage_bucket_iam_member" "development_evidence_list"' \
  infra/roots/foundation/main.tf
if rg --fixed-strings --quiet 'roles/iam.securityAdmin' infra/roots/foundation/main.tf; then
  printf 'DNS bootstrap must not grant broad IAM security administration\n' >&2
  exit 1
fi

printf 'PASS: development failure diagnostics and independent teardown contracts\n'

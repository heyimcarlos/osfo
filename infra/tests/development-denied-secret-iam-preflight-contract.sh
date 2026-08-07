#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
preflight=$repo_root/infra/tests/development-denied-secret-iam-preflight.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mock_bin=$scratch/bin
mkdir -p "$mock_bin"

project_id=osfo-development-123456789
name_prefix=osfo-dev
denied_account=osfo-dev-qual-denied@osfo-development-123456789.iam.gserviceaccount.com
foundation_account=osfo-foundation-tf@osfo-foundation-123456789.iam.gserviceaccount.com
target_member=serviceAccount:$denied_account

jq -n \
  --arg project_id "$project_id" \
  --arg name_prefix "$name_prefix" \
  --arg denied_account "$denied_account" \
  '{
    project_id: $project_id,
    name_prefix: $name_prefix,
    qualification_service_accounts: {denied_secret: $denied_account}
  }' >"$scratch/varset.json"
jq 'del(.qualification_service_accounts.denied_secret)' \
  "$scratch/varset.json" >"$scratch/varset-missing-identity.json"
jq -n \
  --arg email "$denied_account" \
  --arg name "projects/$project_id/serviceAccounts/$denied_account" \
  --arg project_id "$project_id" \
  '{
    email: $email,
    name: $name,
    projectId: $project_id,
    uniqueId: "123456789012345678901",
    disabled: false
  }' \
  >"$scratch/identity.json"
jq -n '{email: 7, name: [], disabled: "false"}' \
  >"$scratch/identity-malformed.json"
jq -n \
  --arg email "wrong-identity@$project_id.iam.gserviceaccount.com" \
  --arg name "projects/$project_id/serviceAccounts/wrong-identity@$project_id.iam.gserviceaccount.com" \
  --arg project_id "$project_id" \
  '{
    email: $email,
    name: $name,
    projectId: $project_id,
    uniqueId: "123456789012345678901",
    disabled: false
  }' \
  >"$scratch/identity-wrong.json"
jq '.disabled = true' "$scratch/identity.json" >"$scratch/identity-disabled.json"

jq -n '{bindings: [
  {role: "roles/viewer", members: ["serviceAccount:unrelated@example.invalid"]}
]}' >"$scratch/project-policy.json"
jq -n '{bindings: {}}' >"$scratch/policy-malformed.json"

jq -n \
  --arg member "$target_member" \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: [$member]}]}' \
  >"$scratch/project-policy-accessor.json"
jq -n \
  --arg member "$target_member" \
  --arg role "projects/$project_id/roles/osfoWidenedSecretRole" \
  '{bindings: [{role: $role, members: [$member]}]}' \
  >"$scratch/project-policy-widened.json"

jq -n '{
  name: "roles/secretmanager.secretAccessor",
  includedPermissions: ["secretmanager.versions.access"],
  deleted: false
}' >"$scratch/accessor-role.json"
jq -n \
  --arg name "projects/$project_id/roles/osfoWidenedSecretRole" \
  '{
    name: $name,
    includedPermissions: ["secretmanager.secrets.get", "secretmanager.versions.access"],
    deleted: false
  }' >"$scratch/widened-role.json"

# The single-quoted lines are the source of the generated mock, not expressions
# for this contract process.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "iam service-accounts describe osfo-dev-qual-denied@osfo-development-123456789.iam.gserviceaccount.com --project=osfo-development-123456789 --format=json")' \
  '    [[ "${MOCK_IDENTITY_MODE:-present}" != absent ]] || exit 1' \
  '    cat "$MOCK_IDENTITY"' \
  '    ;;' \
  '  "projects get-iam-policy osfo-development-123456789 --format=json") cat "$MOCK_PROJECT_POLICY" ;;' \
  '  "iam roles describe roles/secretmanager.secretAccessor --format=json") cat "$MOCK_ACCESSOR_ROLE" ;;' \
  '  "iam roles describe osfoWidenedSecretRole --project=osfo-development-123456789 --format=json") cat "$MOCK_WIDENED_ROLE" ;;' \
  '  *) printf "unexpected denied-secret IAM preflight invocation: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

run_preflight() {
  local varset=$1
  local project_policy=$2
  local output=$3
  local identity=${4:-$scratch/identity.json}
  local identity_mode=${5:-present}

  PATH="$mock_bin:$PATH" \
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT="$foundation_account" \
    FOUNDATION_SERVICE_ACCOUNT="$foundation_account" \
    TF_VARSET_FILE="$varset" \
    MOCK_IDENTITY="$identity" \
    MOCK_IDENTITY_MODE="$identity_mode" \
    MOCK_PROJECT_POLICY="$project_policy" \
    MOCK_ACCESSOR_ROLE="$scratch/accessor-role.json" \
    MOCK_WIDENED_ROLE="$scratch/widened-role.json" \
    "$preflight" >"$output" 2>&1
}

pass_output=$scratch/pass-output
run_preflight \
  "$scratch/varset.json" "$scratch/project-policy.json" "$pass_output"
grep -Fxq \
  'PASS: denied qualification identity has no project or target-secret payload access role' \
  "$pass_output"

expect_preflight_fails() {
  local scenario=$1
  local varset=$2
  local project_policy=$3
  local expected_failure=$4
  local identity=${5:-$scratch/identity.json}
  local identity_mode=${6:-present}
  local output=$scratch/$scenario-output

  if run_preflight \
    "$varset" "$project_policy" "$output" "$identity" "$identity_mode"; then
    printf '%s denied-secret IAM preflight must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fxq "$expected_failure" "$output"
  if grep -Fq 'PASS:' "$output"; then
    printf '%s denied-secret IAM preflight must not report PASS\n' "$scenario" >&2
    exit 1
  fi
}

expect_preflight_fails \
  project-accessor "$scratch/varset.json" \
  "$scratch/project-policy-accessor.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  widened-role "$scratch/varset.json" \
  "$scratch/project-policy-widened.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  malformed-project-policy "$scratch/varset.json" \
  "$scratch/policy-malformed.json" \
  'FAIL: project IAM policy is malformed'
expect_preflight_fails \
  missing-identity "$scratch/varset-missing-identity.json" \
  "$scratch/project-policy.json" \
  'FAIL: denied qualification identity is missing or malformed'
expect_preflight_fails \
  absent-live-identity "$scratch/varset.json" \
  "$scratch/project-policy.json" \
  'FAIL: denied qualification identity does not exist or is unreadable' \
  "$scratch/identity.json" absent
for identity_scenario in malformed wrong disabled; do
  expect_preflight_fails \
    "$identity_scenario-live-identity" "$scratch/varset.json" \
    "$scratch/project-policy.json" \
    'FAIL: denied qualification identity live record is malformed or does not match configuration' \
    "$scratch/identity-$identity_scenario.json"
done

printf 'development denied-secret IAM preflight assertions passed\n'

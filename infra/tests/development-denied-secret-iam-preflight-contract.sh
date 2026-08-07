#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
preflight=$repo_root/infra/tests/development-denied-secret-iam-preflight.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mock_bin=$scratch/bin
mkdir -p "$mock_bin"
real_jq=$(command -v jq)
real_grep=$(command -v grep)

project_id=osfo-development-123456789
name_prefix=osfo-dev
denied_account=osfo-dev-qual-denied@osfo-development-123456789.iam.gserviceaccount.com
foundation_account=osfo-foundation-tf@osfo-foundation-123456789.iam.gserviceaccount.com
platform_account=osfo-dev-platform-tf@osfo-development-123456789.iam.gserviceaccount.com
target_member=serviceAccount:$denied_account
target_secret=$name_prefix-model-adapter

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
jq -n --arg project_id "$project_id" \
  '[{id: $project_id, type: "project"}]' >"$scratch/ancestors.json"
jq -n --arg project_id "$project_id" \
  '[{id: $project_id, type: "project"}, {id: "123456789012", type: "organization"}]' \
  >"$scratch/ancestors-with-parent.json"
jq -n \
  --arg name "projects/$project_id/secrets/$target_secret" \
  '{name: $name}' >"$scratch/secret.json"

jq -n \
  --arg member "$target_member" \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: [$member]}]}' \
  >"$scratch/project-policy-accessor.json"
jq -n \
  --arg member "$target_member" \
  --arg role "projects/$project_id/roles/osfoWidenedSecretRole" \
  '{bindings: [{role: $role, members: [$member]}]}' \
  >"$scratch/project-policy-widened.json"
jq -n \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: ["allAuthenticatedUsers"]}]}' \
  >"$scratch/project-policy-authenticated-accessor.json"
jq -n \
  --arg role "projects/$project_id/roles/osfoWidenedSecretRole" \
  '{bindings: [{role: $role, members: ["allUsers"]}]}' \
  >"$scratch/project-policy-public-widened.json"
jq -n \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: ["group:operators@example.invalid"]}]}' \
  >"$scratch/project-policy-group-accessor.json"
jq -n \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: ["principalSet://cloudresourcemanager.googleapis.com/projects/123456789012/type/ServiceAccount"]}]}' \
  >"$scratch/project-policy-principal-set-accessor.json"

jq -n '{etag: "synthetic-empty-policy"}' >"$scratch/secret-policy.json"
jq -n \
  --arg member "$target_member" \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: [$member]}]}' \
  >"$scratch/secret-policy-accessor.json"
jq -n \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: ["allUsers"]}]}' \
  >"$scratch/secret-policy-public-accessor.json"
jq -n \
  --arg role "projects/$project_id/roles/osfoWidenedSecretRole" \
  '{bindings: [{role: $role, members: ["allAuthenticatedUsers"]}]}' \
  >"$scratch/secret-policy-public-widened.json"
jq -n \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: ["domain:example.invalid"]}]}' \
  >"$scratch/secret-policy-domain-accessor.json"

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
  '  "projects get-ancestors osfo-development-123456789 --format=json") cat "$MOCK_ANCESTORS" ;;' \
  '  "projects get-iam-policy osfo-development-123456789 --format=json") cat "$MOCK_PROJECT_POLICY" ;;' \
  '  "secrets describe osfo-dev-model-adapter --project=osfo-development-123456789 --format=json") cat "$MOCK_SECRET" ;;' \
  '  "secrets get-iam-policy osfo-dev-model-adapter --project=osfo-development-123456789 --format=json") cat "$MOCK_SECRET_POLICY" ;;' \
  '  "iam roles describe roles/secretmanager.secretAccessor --format=json") cat "$MOCK_ACCESSOR_ROLE" ;;' \
  '  "iam roles describe osfoWidenedSecretRole --project=osfo-development-123456789 --format=json") cat "$MOCK_WIDENED_ROLE" ;;' \
  '  *) printf "unexpected denied-secret IAM preflight invocation: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

# The selector mock targets only the policy role-selection jq program. All
# other structured parsing remains real jq behavior.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${MOCK_SELECTOR_FAILURE:-0}" == 1 && "$*" == *"def directly_effective"* ]]; then' \
  '  exit 47' \
  'fi' \
  'if [[ "${MOCK_ROLE_PERMISSION_FAILURE:-0}" == 1 && "$*" == *"index(\"secretmanager.versions.access\") != null"* ]]; then' \
  '  exit 48' \
  'fi' \
  'exec "$REAL_JQ" "$@"' >"$mock_bin/jq"
chmod +x "$mock_bin/jq"

# The grep mock reproduces a filesystem or scanner failure at the Terraform
# source boundary without changing the repository under test.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${MOCK_TERRAFORM_SCAN_FAILURE:-0}" == 1 && "$*" == *"--include=*.tf"* ]]; then' \
  '  exit 2' \
  'fi' \
  'exec "$REAL_GREP" "$@"' >"$mock_bin/grep"
chmod +x "$mock_bin/grep"

run_preflight() {
  local scope=$1
  local varset=$2
  local project_policy=$3
  local secret_policy=$4
  local output=$5
  local identity=${6:-$scratch/identity.json}
  local identity_mode=${7:-present}
  local ancestors=${8:-$scratch/ancestors.json}
  local expected_account=$foundation_account
  if [[ "$scope" == target-secret ]]; then
    expected_account=$platform_account
  fi

  PATH="$mock_bin:$PATH" \
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT="$expected_account" \
    FOUNDATION_SERVICE_ACCOUNT="$foundation_account" \
    PLATFORM_SERVICE_ACCOUNT="$platform_account" \
    DENIED_SECRET_IAM_SCOPE="$scope" \
    TF_VARSET_FILE="$varset" \
    MOCK_IDENTITY="$identity" \
    MOCK_IDENTITY_MODE="$identity_mode" \
    MOCK_ANCESTORS="$ancestors" \
    MOCK_PROJECT_POLICY="$project_policy" \
    MOCK_SECRET="$scratch/secret.json" \
    MOCK_SECRET_POLICY="$secret_policy" \
    MOCK_ACCESSOR_ROLE="$scratch/accessor-role.json" \
    MOCK_WIDENED_ROLE="$scratch/widened-role.json" \
    MOCK_SELECTOR_FAILURE="${MOCK_SELECTOR_FAILURE:-0}" \
    MOCK_ROLE_PERMISSION_FAILURE="${MOCK_ROLE_PERMISSION_FAILURE:-0}" \
    MOCK_TERRAFORM_SCAN_FAILURE="${MOCK_TERRAFORM_SCAN_FAILURE:-0}" \
    REAL_JQ="$real_jq" \
    REAL_GREP="$real_grep" \
    "$preflight" >"$output" 2>&1
}

pass_output=$scratch/pass-output
run_preflight \
  project "$scratch/varset.json" "$scratch/project-policy.json" \
  "$scratch/secret-policy.json" "$pass_output"
grep -Fxq \
  'PASS: denied qualification identity has no project payload access role' \
  "$pass_output"

target_pass_output=$scratch/target-pass-output
run_preflight \
  target-secret "$scratch/varset.json" "$scratch/project-policy.json" \
  "$scratch/secret-policy.json" "$target_pass_output"
grep -Fxq \
  'PASS: denied qualification identity has no target-secret payload access role' \
  "$target_pass_output"

expect_preflight_fails() {
  local scenario=$1
  local scope=$2
  local varset=$3
  local project_policy=$4
  local secret_policy=$5
  local expected_failure=$6
  local identity=${7:-$scratch/identity.json}
  local identity_mode=${8:-present}
  local ancestors=${9:-$scratch/ancestors.json}
  local output=$scratch/$scenario-output

  if run_preflight \
    "$scope" "$varset" "$project_policy" "$secret_policy" "$output" \
    "$identity" "$identity_mode" "$ancestors"; then
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
  project-accessor project "$scratch/varset.json" \
  "$scratch/project-policy-accessor.json" "$scratch/secret-policy.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  widened-role project "$scratch/varset.json" \
  "$scratch/project-policy-widened.json" "$scratch/secret-policy.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  authenticated-project-accessor project "$scratch/varset.json" \
  "$scratch/project-policy-authenticated-accessor.json" "$scratch/secret-policy.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  public-project-widened project "$scratch/varset.json" \
  "$scratch/project-policy-public-widened.json" "$scratch/secret-policy.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  project-group-accessor project "$scratch/varset.json" \
  "$scratch/project-policy-group-accessor.json" "$scratch/secret-policy.json" \
  'FAIL: aggregate principal inheritance cannot be excluded for a role granting secretmanager.versions.access'
expect_preflight_fails \
  project-principal-set-accessor project "$scratch/varset.json" \
  "$scratch/project-policy-principal-set-accessor.json" "$scratch/secret-policy.json" \
  'FAIL: aggregate principal inheritance cannot be excluded for a role granting secretmanager.versions.access'
expect_preflight_fails \
  malformed-project-policy project "$scratch/varset.json" \
  "$scratch/policy-malformed.json" "$scratch/secret-policy.json" \
  'FAIL: project IAM policy is malformed'
expect_preflight_fails \
  unseen-project-parent project "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy.json" \
  'FAIL: denied-secret IAM preflight cannot exclude inherited access from a non-project ancestor' \
  "$scratch/identity.json" present "$scratch/ancestors-with-parent.json"
expect_preflight_fails \
  target-secret-accessor target-secret "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy-accessor.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  public-target-secret-accessor target-secret "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy-public-accessor.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  public-target-secret-widened target-secret "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy-public-widened.json" \
  'FAIL: denied qualification identity has a role granting secretmanager.versions.access'
expect_preflight_fails \
  target-secret-domain-accessor target-secret "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy-domain-accessor.json" \
  'FAIL: aggregate principal inheritance cannot be excluded for a role granting secretmanager.versions.access'
expect_preflight_fails \
  malformed-target-secret-policy target-secret "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/policy-malformed.json" \
  'FAIL: target-secret IAM policy is malformed'
MOCK_SELECTOR_FAILURE=1 expect_preflight_fails \
  selector-failure target-secret "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy.json" \
  'FAIL: unable to select potentially effective denied-secret role bindings'
MOCK_ROLE_PERMISSION_FAILURE=1 expect_preflight_fails \
  role-permission-evaluator-failure project "$scratch/varset.json" \
  "$scratch/project-policy-accessor.json" "$scratch/secret-policy.json" \
  'FAIL: unable to evaluate a potentially effective role for secretmanager.versions.access'
MOCK_TERRAFORM_SCAN_FAILURE=1 expect_preflight_fails \
  terraform-scan-failure project "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy.json" \
  'FAIL: unable to scan disposable platform Terraform for secret-level IAM authority'
expect_preflight_fails \
  missing-identity project "$scratch/varset-missing-identity.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy.json" \
  'FAIL: denied qualification identity is missing or malformed'
expect_preflight_fails \
  absent-live-identity project "$scratch/varset.json" \
  "$scratch/project-policy.json" "$scratch/secret-policy.json" \
  'FAIL: denied qualification identity does not exist or is unreadable' \
  "$scratch/identity.json" absent
for identity_scenario in malformed wrong disabled; do
  expect_preflight_fails \
    "$identity_scenario-live-identity" project "$scratch/varset.json" \
    "$scratch/project-policy.json" "$scratch/secret-policy.json" \
    'FAIL: denied qualification identity live record is malformed or does not match configuration' \
    "$scratch/identity-$identity_scenario.json"
done

printf 'development denied-secret IAM preflight assertions passed\n'

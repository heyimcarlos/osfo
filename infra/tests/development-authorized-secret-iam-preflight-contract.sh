#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
preflight=$repo_root/infra/tests/development-denied-secret-iam-preflight.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mock_bin=$scratch/bin
mkdir -p "$mock_bin"

project_id=osfo-development-123456789
project_number=123456789012
name_prefix=osfo-dev
authorized_account=$name_prefix-qual-authorized@$project_id.iam.gserviceaccount.com
foundation_account=osfo-foundation-tf@osfo-foundation-123456789.iam.gserviceaccount.com
platform_account=osfo-dev-platform-tf@$project_id.iam.gserviceaccount.com
authorized_member=serviceAccount:$authorized_account

jq -n \
  --arg project_id "$project_id" \
  --arg name_prefix "$name_prefix" \
  --arg account "$authorized_account" \
  '{project_id: $project_id, name_prefix: $name_prefix,
    qualification_service_accounts: {authorized_secret: $account}}' \
  >"$scratch/varset.json"
jq -n \
  --arg email "$authorized_account" \
  --arg name "projects/$project_id/serviceAccounts/$authorized_account" \
  --arg project_id "$project_id" \
  '{email: $email, name: $name, projectId: $project_id,
    uniqueId: "123456789012345678901", disabled: false}' \
  >"$scratch/identity.json"
jq -n --arg project_id "$project_id" \
  '[{id: $project_id, type: "project"}]' >"$scratch/ancestors.json"
jq -n --arg project_id "$project_id" --arg number "$project_number" \
  '{projectId: $project_id, projectNumber: $number}' >"$scratch/project.json"
jq -n '{bindings: []}' >"$scratch/empty-policy.json"
jq -n --arg member "$authorized_member" \
  '{bindings: [{role: "roles/secretmanager.secretAccessor", members: [$member]}]}' \
  >"$scratch/direct-access-policy.json"
jq -n \
  '{bindings: [{role: "roles/secretmanager.secretAccessor",
    members: ["group:operators@example.invalid"]}]}' \
  >"$scratch/aggregate-access-policy.json"
jq -n '{name: "roles/secretmanager.secretAccessor",
  includedPermissions: ["secretmanager.versions.access"], deleted: false}' \
  >"$scratch/accessor-role.json"

# These quoted lines define a mock executable and are not evaluated here.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "iam service-accounts describe osfo-dev-qual-authorized@osfo-development-123456789.iam.gserviceaccount.com --project=osfo-development-123456789 --format=json") cat "$MOCK_IDENTITY" ;;' \
  '  "projects get-ancestors osfo-development-123456789 --format=json") cat "$MOCK_ANCESTORS" ;;' \
  '  "projects get-iam-policy osfo-development-123456789 --format=json") cat "$MOCK_POLICY" ;;' \
  '  "projects describe osfo-development-123456789 --format=json") cat "$MOCK_PROJECT" ;;' \
  '  "secrets describe "*" --project=osfo-development-123456789 --format=json") cat "$MOCK_SECRET" ;;' \
  '  "secrets get-iam-policy "*" --project=osfo-development-123456789 --format=json") cat "$MOCK_POLICY" ;;' \
  '  "iam roles describe roles/secretmanager.secretAccessor --format=json") cat "$MOCK_ACCESSOR_ROLE" ;;' \
  '  *) printf "unexpected authorized-secret IAM invocation\n" >&2; exit 90 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

run_preflight() {
  local scope=$1
  local target=$2
  local policy=$3
  local output=$4
  local expected_account=$foundation_account
  if [[ "$scope" == target-secret ]]; then
    expected_account=$platform_account
  fi
  jq -n --arg name "projects/$project_number/secrets/$name_prefix-$target" \
    '{name: $name}' >"$scratch/secret.json"

  PATH="$mock_bin:$PATH" \
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT="$expected_account" \
    FOUNDATION_SERVICE_ACCOUNT="$foundation_account" \
    PLATFORM_SERVICE_ACCOUNT="$platform_account" \
    DENIED_SECRET_IAM_SCOPE="$scope" \
    SECRET_ACCESS_IDENTITY_KEY=authorized_secret \
    SECRET_ACCESS_IDENTITY_LABEL=authorized \
    SECRET_ACCESS_PROOF_LABEL=authorized-secret \
    SECRET_ACCESS_TARGET_SUFFIX="$target" \
    TF_VARSET_FILE="$scratch/varset.json" \
    MOCK_IDENTITY="$scratch/identity.json" \
    MOCK_ANCESTORS="$scratch/ancestors.json" \
    MOCK_PROJECT="$scratch/project.json" \
    MOCK_SECRET="$scratch/secret.json" \
    MOCK_POLICY="$policy" \
    MOCK_ACCESSOR_ROLE="$scratch/accessor-role.json" \
    "$preflight" >"$output" 2>&1
}

run_preflight project model-adapter "$scratch/empty-policy.json" "$scratch/project-pass.out"
grep -Fxq 'PASS: authorized qualification identity has no project payload access role' \
  "$scratch/project-pass.out"

for target in model-adapter temporal-cloud; do
  run_preflight target-secret "$target" "$scratch/empty-policy.json" \
    "$scratch/$target-pass.out"
  grep -Fxq \
    "PASS: authorized qualification identity has no $target payload access role" \
    "$scratch/$target-pass.out"
done

expect_failure() {
  local scenario=$1
  local scope=$2
  local target=$3
  local policy=$4
  local expected=$5
  if run_preflight "$scope" "$target" "$policy" "$scratch/$scenario.out"; then
    printf '%s authorized-secret IAM preflight must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fxq "$expected" "$scratch/$scenario.out"
  ! grep -Fq 'PASS:' "$scratch/$scenario.out"
}

expect_failure project-direct-access project model-adapter \
  "$scratch/direct-access-policy.json" \
  'FAIL: authorized qualification identity has a role granting secretmanager.versions.access'
expect_failure model-adapter-direct-access target-secret model-adapter \
  "$scratch/direct-access-policy.json" \
  'FAIL: authorized qualification identity has a role granting secretmanager.versions.access'
expect_failure temporal-cloud-direct-access target-secret temporal-cloud \
  "$scratch/direct-access-policy.json" \
  'FAIL: authorized qualification identity has a role granting secretmanager.versions.access'
expect_failure aggregate-access target-secret temporal-cloud \
  "$scratch/aggregate-access-policy.json" \
  'FAIL: aggregate principal inheritance cannot be excluded for a role granting secretmanager.versions.access'

printf 'development authorized-secret IAM preflight assertions passed\n'

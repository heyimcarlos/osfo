#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
scope=${DENIED_SECRET_IAM_SCOPE:-project}
identity_key=${SECRET_ACCESS_IDENTITY_KEY:-denied_secret}
identity_label=${SECRET_ACCESS_IDENTITY_LABEL:-denied}
proof_label=${SECRET_ACCESS_PROOF_LABEL:-denied-secret}
target_secret_suffix=${SECRET_ACCESS_TARGET_SUFFIX:-model-adapter}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

case "$scope" in
  project) expected_account=${FOUNDATION_SERVICE_ACCOUNT:?FOUNDATION_SERVICE_ACCOUNT is required} ;;
  target-secret) expected_account=${PLATFORM_SERVICE_ACCOUNT:?PLATFORM_SERVICE_ACCOUNT is required} ;;
  *) fail "$proof_label IAM preflight scope is unsupported" ;;
esac
case "$identity_key" in
  denied_secret | authorized_secret) ;;
  *) fail 'secret-access qualification identity selector is unsupported' ;;
esac
case "$target_secret_suffix" in
  model-adapter | temporal-cloud) ;;
  *) fail 'secret-access qualification target selector is unsupported' ;;
esac

effective_account=${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}
if [[ "$effective_account" != "$expected_account" ]]; then
  fail "$proof_label $scope IAM preflight requires its exact authorized identity"
fi
if ! project_id=$(jq -er \
  '.project_id | select(type == "string" and test("^[a-z][a-z0-9-]{4,28}[a-z0-9]$"))' \
  "$varset"); then
  fail 'development project identity is missing or malformed'
fi
if ! name_prefix=$(jq -er \
  '.name_prefix | select(type == "string" and test("^[a-z][a-z0-9-]{1,61}[a-z0-9]$"))' \
  "$varset"); then
  fail 'development name prefix is missing or malformed'
fi
if ! qualification_account=$(jq -er --arg identity_key "$identity_key" '
  .qualification_service_accounts[$identity_key]
  | select(type == "string" and test("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$"))
' "$varset"); then
  fail "$identity_label qualification identity is missing or malformed"
fi
if [[ "$qualification_account" != *"@$project_id.iam.gserviceaccount.com" ]]; then
  fail "$identity_label qualification identity is missing or malformed"
fi

target_member=serviceAccount:$qualification_account
target_secret=$name_prefix-$target_secret_suffix
target_scope_label=$target_secret_suffix
if [[ "$identity_key" == denied_secret && "$target_secret_suffix" == model-adapter ]]; then
  target_scope_label=target-secret
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if ! gcloud iam service-accounts describe "$qualification_account" \
  --project="$project_id" --format=json \
  >"$scratch/identity.json" 2>"$scratch/identity.error"; then
  fail "$identity_label qualification identity does not exist or is unreadable"
fi
if ! jq -e \
  --arg email "$qualification_account" \
  --arg name "projects/$project_id/serviceAccounts/$qualification_account" \
  --arg project_id "$project_id" '
  type == "object"
  and .email == $email
  and .name == $name
  and .projectId == $project_id
  and (.uniqueId | type == "string" and test("^[0-9]+$"))
  and (.disabled // false) == false
  and (.deleted // false) == false
' "$scratch/identity.json" >/dev/null; then
  fail "$identity_label qualification identity live record is malformed or does not match configuration"
fi

validate_policy() {
  local policy=$1
  local label=$2

  if ! jq -e '
    type == "object"
    and ((has("bindings") | not) or (.bindings | type) == "array")
    and all((.bindings // [])[];
      type == "object"
      and (.role | type == "string" and length > 0)
      and (.members | type == "array" and length > 0)
      and all(.members[]; type == "string" and length > 0)
      and (
        (
          (has("condition") | not)
          or .condition == null
          or (
            (.condition | type) == "object"
            and (.condition.expression | type == "string" and length > 0)
            and (
              ((.condition | has("title") | not) or (.condition.title | type == "string"))
            )
          )
        )
      )
    )
  ' "$policy" >/dev/null; then
    fail "$label IAM policy is malformed"
  fi
}

role_index=0
role_grants_payload_access() {
  local bound_role=$1
  role_index=$((role_index + 1))
  local role_file=$scratch/role-$role_index.json
  local role_id
  local organization_id

  if [[ "$bound_role" =~ ^roles/[A-Za-z0-9_.]+$ ]]; then
    if ! gcloud iam roles describe "$bound_role" --format=json \
      >"$role_file" 2>"$scratch/role-$role_index.error"; then
      fail "unable to resolve a potentially effective role for $proof_label qualification"
    fi
  elif [[ "$bound_role" == "projects/$project_id/roles/"* ]]; then
    role_id=${bound_role#"projects/$project_id/roles/"}
    if [[ ! "$role_id" =~ ^[A-Za-z0-9_.]+$ ]] \
      || ! gcloud iam roles describe "$role_id" --project="$project_id" --format=json \
        >"$role_file" 2>"$scratch/role-$role_index.error"; then
      fail "unable to resolve a potentially effective role for $proof_label qualification"
    fi
  elif [[ "$bound_role" =~ ^organizations/([0-9]+)/roles/([A-Za-z0-9_.]+)$ ]]; then
    organization_id=${BASH_REMATCH[1]}
    role_id=${BASH_REMATCH[2]}
    if ! gcloud iam roles describe "$role_id" \
      --organization="$organization_id" --format=json \
      >"$role_file" 2>"$scratch/role-$role_index.error"; then
      fail "unable to resolve a potentially effective role for $proof_label qualification"
    fi
  else
    fail "potentially effective $proof_label binding uses an unsupported role"
  fi

  if ! jq -e \
    --arg name "$bound_role" '
    type == "object"
    and .name == $name
    and (.includedPermissions | type) == "array"
    and all(.includedPermissions[]; type == "string" and length > 0)
    and .deleted != true
  ' "$role_file" >/dev/null; then
    fail "role definition for $proof_label qualification is malformed"
  fi

  jq -e '
    .includedPermissions
    | index("secretmanager.versions.access") != null
  ' "$role_file" >/dev/null 2>"$scratch/role-$role_index-permission.error"
}

check_policy_for_payload_access() {
  local policy=$1
  local label=$2
  local bound_role
  local principal_scope
  local role_permission_status
  local selected_bindings=$scratch/$label-selected-bindings.tsv

  validate_policy "$policy" "$label"
  if ! jq -r \
    --arg member "$target_member" '
      def directly_effective:
        . == $member
        or . == "allUsers"
        or . == "allAuthenticatedUsers"
        or . == "principal://goog/public:all";
      def unresolved_aggregate:
        startswith("group:")
        or startswith("domain:")
        or startswith("principalSet://");
      [(.bindings // [])[]
        | select(any(.members[]; directly_effective or unresolved_aggregate))
        | [
            .role,
            (if any(.members[]; directly_effective) then "effective" else "aggregate" end)
          ]]
      | unique[]
      | @tsv
    ' "$policy" >"$selected_bindings" 2>"$scratch/$label-selection.error"; then
    fail "unable to select potentially effective $proof_label role bindings"
  fi

  while IFS=$'\t' read -r bound_role principal_scope; do
    role_permission_status=0
    set +e
    role_grants_payload_access "$bound_role"
    role_permission_status=$?
    set -e
    case "$role_permission_status" in
      0)
        if [[ "$principal_scope" == aggregate ]]; then
          fail 'aggregate principal inheritance cannot be excluded for a role granting secretmanager.versions.access'
        fi
        fail "$identity_label qualification identity has a role granting secretmanager.versions.access"
        ;;
      1) ;;
      *) fail 'unable to evaluate a potentially effective role for secretmanager.versions.access' ;;
    esac
  done <"$selected_bindings"
}

if [[ "$scope" == project ]]; then
  if ! gcloud projects get-ancestors "$project_id" --format=json \
    >"$scratch/ancestors.json" 2>"$scratch/ancestors.error"; then
    fail "unable to read development project ancestry for $proof_label qualification"
  fi
  if ! jq -e --arg project_id "$project_id" '
    type == "array"
    and length == 1
    and .[0] == {id: $project_id, type: "project"}
  ' "$scratch/ancestors.json" >/dev/null; then
    fail "$proof_label IAM preflight cannot exclude inherited access from a non-project ancestor"
  fi
  if ! gcloud projects get-iam-policy "$project_id" --format=json \
    >"$scratch/project-policy.json" 2>"$scratch/project-policy.error"; then
    fail "unable to read project IAM policy for $proof_label qualification"
  fi
  check_policy_for_payload_access "$scratch/project-policy.json" project

  terraform_scan_status=0
  terraform_scan_output=$scratch/terraform-scan.out
  set +e
  grep -ER --include='*.tf' \
    'resource[[:space:]]+"google_secret_manager_secret_iam_(member|binding|policy)"|secretmanager[.]secrets[.]setIamPolicy' \
    "$repo_root/infra/roots/development/platform" "$repo_root/infra/modules" \
    >"$terraform_scan_output" 2>"$scratch/terraform-scan.error"
  terraform_scan_status=$?
  set -e
  case "$terraform_scan_status" in
    0)
      if [[ $(wc -l <"$terraform_scan_output") != 1 ]] \
        || ! grep -Fqx \
          "$repo_root/infra/modules/qualification-probe/main.tf:resource \"google_secret_manager_secret_iam_member\" \"authorized_secret\" {" \
          "$terraform_scan_output"; then
        fail 'disposable platform declares secret-level IAM authority outside the reviewed qualification target'
      fi
      ;;
    1) fail 'disposable platform is missing the reviewed qualification-secret IAM binding' ;;
    *) fail 'unable to scan disposable platform Terraform for secret-level IAM authority' ;;
  esac
  printf 'PASS: %s qualification identity has no project payload access role\n' "$identity_label"
  exit 0
fi

if ! gcloud projects describe "$project_id" --format=json \
  >"$scratch/project.json" 2>"$scratch/project.error"; then
  fail 'development project does not exist or is unreadable'
fi
if ! project_number=$(jq -ser --arg project_id "$project_id" '
  select(length == 1)
  | .[0]
  | select(
    type == "object"
    and .projectId == $project_id
    and (.projectNumber | type == "string" and test("^[0-9]+\\z"))
  )
  | .projectNumber
' "$scratch/project.json"); then
  fail 'development project live record is malformed or does not match configuration'
fi

if ! gcloud secrets describe "$target_secret" --project="$project_id" --format=json \
  >"$scratch/secret.json" 2>"$scratch/secret.error"; then
  fail 'target secret does not exist or is unreadable'
fi
if ! jq -se \
  --arg project_number "$project_number" \
  --arg target_secret "$target_secret" '
  length == 1
  and (
    .[0]
    | type == "object"
    and (.name | type == "string")
    and (
      .name
      | split("/") as $segments
      | ($segments | length == 4)
        and $segments[0] == "projects"
        and ($segments[1] | test("^[0-9]+\\z"))
        and $segments[1] == $project_number
        and $segments[2] == "secrets"
        and $segments[3] == $target_secret
    )
  )
' "$scratch/secret.json" >/dev/null; then
  fail 'target secret live record is malformed or does not match configuration'
fi
if ! gcloud secrets get-iam-policy "$target_secret" \
  --project="$project_id" --format=json \
  >"$scratch/target-secret-policy.json" 2>"$scratch/target-secret-policy.error"; then
  fail "unable to read target-secret IAM policy for $proof_label qualification"
fi
check_policy_for_payload_access "$scratch/target-secret-policy.json" target-secret
printf 'PASS: %s qualification identity has no %s payload access role\n' \
  "$identity_label" "$target_scope_label"

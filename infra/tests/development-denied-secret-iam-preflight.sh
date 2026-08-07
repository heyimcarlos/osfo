#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
expected_account=${FOUNDATION_SERVICE_ACCOUNT:?FOUNDATION_SERVICE_ACCOUNT is required}
effective_account=${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

if [[ "$effective_account" != "$expected_account" ]]; then
  fail 'denied-secret IAM preflight requires the foundation identity'
fi
if ! project_id=$(jq -er \
  '.project_id | select(type == "string" and test("^[a-z][a-z0-9-]{4,28}[a-z0-9]$"))' \
  "$varset"); then
  fail 'development project identity is missing or malformed'
fi
if ! denied_account=$(jq -er '
  .qualification_service_accounts.denied_secret
  | select(type == "string" and test("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$"))
' "$varset"); then
  fail 'denied qualification identity is missing or malformed'
fi
if [[ "$denied_account" != *"@$project_id.iam.gserviceaccount.com" ]]; then
  fail 'denied qualification identity is missing or malformed'
fi

target_member=serviceAccount:$denied_account
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if ! gcloud iam service-accounts describe "$denied_account" \
  --project="$project_id" --format=json \
  >"$scratch/identity.json" 2>"$scratch/identity.error"; then
  fail 'denied qualification identity does not exist or is unreadable'
fi
if ! jq -e \
  --arg email "$denied_account" \
  --arg name "projects/$project_id/serviceAccounts/$denied_account" \
  --arg project_id "$project_id" '
  type == "object"
  and .email == $email
  and .name == $name
  and .projectId == $project_id
  and (.uniqueId | type == "string" and test("^[0-9]+$"))
  and (.disabled // false) == false
  and (.deleted // false) == false
' "$scratch/identity.json" >/dev/null; then
  fail 'denied qualification identity live record is malformed or does not match configuration'
fi

if ! gcloud projects get-iam-policy "$project_id" --format=json \
  >"$scratch/project-policy.json" 2>"$scratch/project-policy.error"; then
  fail 'unable to read project IAM policy for denied-secret qualification'
fi

validate_policy() {
  local policy=$1
  local label=$2

  if ! jq -e '
    type == "object"
    and (.bindings | type) == "array"
    and all(.bindings[];
      type == "object"
      and (.role | type == "string" and length > 0)
      and (.members | type == "array" and length > 0)
      and all(.members[]; type == "string" and length > 0)
      and (
        has("condition") | not
        or .condition == null
        or (
          (.condition | type) == "object"
          and (.condition.expression | type == "string" and length > 0)
          and (
            (.condition | has("title")) | not
            or (.condition.title | type == "string")
          )
        )
      )
    )
  ' "$policy" >/dev/null; then
    fail "$label IAM policy is malformed"
  fi
}

validate_policy "$scratch/project-policy.json" project
if grep -ER --include='*.tf' \
  'resource[[:space:]]+"google_secret_manager_secret_iam_(member|binding|policy)"|secretmanager[.]secrets[.]setIamPolicy' \
  "$repo_root/infra/roots/development/platform" "$repo_root/infra/modules" \
  >/dev/null; then
  fail 'disposable platform declares secret-level IAM authority'
fi

role_index=0
while IFS= read -r bound_role; do
  role_index=$((role_index + 1))
  role_file=$scratch/role-$role_index.json

  if [[ "$bound_role" =~ ^roles/[A-Za-z0-9_.]+$ ]]; then
    if ! gcloud iam roles describe "$bound_role" --format=json \
      >"$role_file" 2>"$scratch/role-$role_index.error"; then
      fail 'unable to resolve a role bound to the denied qualification identity'
    fi
  elif [[ "$bound_role" == "projects/$project_id/roles/"* ]]; then
    role_id=${bound_role#"projects/$project_id/roles/"}
    if [[ ! "$role_id" =~ ^[A-Za-z0-9_.]+$ ]] \
      || ! gcloud iam roles describe "$role_id" --project="$project_id" --format=json \
        >"$role_file" 2>"$scratch/role-$role_index.error"; then
      fail 'unable to resolve a role bound to the denied qualification identity'
    fi
  elif [[ "$bound_role" =~ ^organizations/([0-9]+)/roles/([A-Za-z0-9_.]+)$ ]]; then
    organization_id=${BASH_REMATCH[1]}
    role_id=${BASH_REMATCH[2]}
    if ! gcloud iam roles describe "$role_id" \
      --organization="$organization_id" --format=json \
      >"$role_file" 2>"$scratch/role-$role_index.error"; then
      fail 'unable to resolve a role bound to the denied qualification identity'
    fi
  else
    fail 'denied qualification identity has an unsupported role binding'
  fi

  if ! jq -e \
    --arg name "$bound_role" '
    type == "object"
    and .name == $name
    and (.includedPermissions | type) == "array"
    and all(.includedPermissions[]; type == "string" and length > 0)
    and .deleted != true
  ' "$role_file" >/dev/null; then
    fail 'role definition for denied-secret qualification is malformed'
  fi
  if jq -e '
    .includedPermissions
    | index("secretmanager.versions.access") != null
  ' "$role_file" >/dev/null; then
    fail 'denied qualification identity has a role granting secretmanager.versions.access'
  fi
done < <(
  jq -r \
    --arg member "$target_member" '
    [.bindings[]
      | select(.members | index($member) != null)
      | .role]
    | unique[]
  ' "$scratch/project-policy.json"
)

printf 'PASS: denied qualification identity has no project or target-secret payload access role\n'

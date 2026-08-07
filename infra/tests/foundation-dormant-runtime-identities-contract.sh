#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

foundation=infra/roots/foundation/main.tf
outputs=infra/roots/foundation/outputs.tf
platform_vars=infra/roots/development/platform/development.tfvars.json

active_identities=$(sed -n \
  '/development_runtime_identities = toset(/,/  ])/p' "$foundation")
if [[ $(grep -Ec '^    "(agentrun|relay|temporal|transport)",$' <<<"$active_identities") != 4 ]] \
  || grep -Eq 'migration|reconciliation' <<<"$active_identities"; then
  printf 'active identity set must exclude dormant database-job identities\n' >&2
  exit 1
fi

dormant_identities=$(sed -n \
  '/development_dormant_runtime_identities = toset(/,/  ])/p' "$foundation")
for identity in migration reconciliation; do
  grep -Fq "\"$identity\"" <<<"$dormant_identities"
done
if [[ $(grep -Ec '^    "(migration|reconciliation)",$' <<<"$dormant_identities") != 2 ]]; then
  printf 'dormant identity set must contain exactly migration and reconciliation\n' >&2
  exit 1
fi

for protected_contract in \
  'development_protected_runtime_identities = setunion(' \
  'local.development_runtime_identities,' \
  'local.development_dormant_runtime_identities,'; do
  rg --fixed-strings --quiet "$protected_contract" "$foundation"
done

runtime_account=$(sed -n \
  '/resource "google_service_account" "development_runtime"/,/^}/p' "$foundation")
for protected_contract in \
  'for_each = local.development_protected_runtime_identities' \
  'prevent_destroy = true' \
  'disabled = contains(local.development_dormant_runtime_identities, each.key)'; do
  grep -Fq "$protected_contract" <<<"$runtime_account"
done

cloud_sql_authority=$(sed -n \
  '/development_runtime_cloud_sql_bindings =/,/  }/p' "$foundation")
grep -Fq 'setproduct(local.development_runtime_identities' <<<"$cloud_sql_authority"

secret_authority=$(sed -n \
  '/development_secret_access_bindings = {/,/  security_constraints =/p' "$foundation")
if grep -Eq 'migration|reconciliation' <<<"$cloud_sql_authority$secret_authority"; then
  printf 'dormant identities must not appear in Cloud SQL or secret authority maps\n' >&2
  exit 1
fi

if [[ $(rg --count 'google_service_account[.]development_runtime\[' "$foundation") != 2 ]]; then
  printf 'runtime identities must receive project authority only through reviewed maps\n' >&2
  exit 1
fi

runtime_act_as=$(sed -n \
  '/resource "google_service_account_iam_member" "development_runtime_act_as"/,/^}/p' \
  "$foundation")
for active_filter in \
  'for identity, account in google_service_account.development_runtime :' \
  'if contains(local.development_runtime_identities, identity)'; do
  grep -Fq "$active_filter" <<<"$runtime_act_as"
done

runtime_output=$(sed -n \
  '/output "development_runtime_service_accounts"/,/^}/p' "$outputs")
for active_filter in \
  'for identity, account in google_service_account.development_runtime :' \
  'if contains(local.development_runtime_identities, identity)'; do
  grep -Fq "$active_filter" <<<"$runtime_output"
done

jq -e '
  (.runtime_service_accounts | keys | sort) == [
    "agentrun", "relay", "temporal", "transport"
  ]
  and (.runtime_service_accounts | has("migration") | not)
  and (.runtime_service_accounts | has("reconciliation") | not)
' "$platform_vars" >/dev/null

if rg --quiet 'osfo-dev-(migration|reconciliation)' \
  infra/roots/development/platform infra/roots/development/runtime \
  infra/modules/data-authority; then
  printf 'dormant identities must not be consumed by platform or runtime roots\n' >&2
  exit 1
fi

for removed_job in database_bootstrap migration seed reconciliation; do
  if rg --fixed-strings --quiet \
    "resource \"google_cloud_run_v2_job\" \"$removed_job\"" \
    infra/roots infra/modules; then
    printf 'retired database job %s must remain absent\n' "$removed_job" >&2
    exit 1
  fi
done

rg --fixed-strings --quiet 'protected_dormant_identity_authority_absent: "PASS"' \
  infra/tests/development-platform-absent.sh

printf 'PASS: protected dormant identities are retained without runtime authority\n'

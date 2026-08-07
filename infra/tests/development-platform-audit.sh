#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
since=${1:?lifecycle start time is required}
report_file=${2:?audit report file is required}
project_id=$(jq -r '.project_id' "$varset")
platform_identity=$(jq -r '.terraform_service_account_email' "$varset")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

filter="timestamp>=\"$since\" AND protoPayload.authenticationInfo.principalEmail=\"$platform_identity\""
for attempt in {1..18}; do
  if gcloud logging read "$filter" --project="$project_id" --limit=500 \
    --order=asc --format=json >"$scratch/logs.json" \
    && jq -e '
      length > 0
      and any(.[]; (.protoPayload.methodName // "") | test("Delete|delete"))
    ' "$scratch/logs.json" >/dev/null; then
    break
  fi
  if ((attempt == 18)); then
    printf 'FAIL: retained audit history did not expose lifecycle deletion events\n' >&2
    exit 1
  fi
  sleep 10
done

jq --arg project_id "$project_id" --arg since "$since" --arg principal "$platform_identity" '{
  schema_version: 1,
  project_id: $project_id,
  lifecycle_started_at: $since,
  principal: $principal,
  checks: {
    retained_audit_history_query: "PASS",
    lifecycle_deletion_event: "PASS"
  },
  entries: [ .[] | {
    timestamp,
    service: .protoPayload.serviceName,
    method: .protoPayload.methodName,
    resource: .protoPayload.resourceName,
    principal: .protoPayload.authenticationInfo.principalEmail
  } ]
}' "$scratch/logs.json" >"$report_file"

printf 'PASS: retained audit history contains lifecycle deletion events\n'

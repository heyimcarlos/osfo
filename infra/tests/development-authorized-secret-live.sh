#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
platform_file=${1:?platform output file is required}
report_file=${2:?authorized-secret report file is required}
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -er '.project_id' "$varset")
region=$(jq -er '.region' "$varset")
job=$(jq -er '.qualification_probe_jobs.authorized_secret' "$platform_file")
secret=$(jq -er '.qualification_secret_name' "$platform_file")
identity=$(jq -er '.qualification_service_accounts.authorized_secret' "$platform_file")

if [[ ! "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
  || [[ ! "$region" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] \
  || [[ ! "$job" =~ ^[a-z][a-z0-9-]{0,62}$ ]] \
  || [[ ! "$secret" =~ ^[A-Za-z0-9_-]{1,255}$ ]] \
  || [[ ! "$identity" =~ ^[a-z0-9-]+@${project_id}[.]iam[.]gserviceaccount[.]com$ ]]; then
  fail 'authorized-secret managed identifiers are invalid'
fi

scratch=$(mktemp -d)
version=""
cleanup() {
  local exit_status=$?
  trap - EXIT
  rm -rf "$scratch"
  exit "$exit_status"
}
trap cleanup EXIT

umask 077
version_file=$scratch/version.json
execution_file=$scratch/execution.json
logs_file=$scratch/logs.json
candidate_report=$scratch/report.json

if ! sentinel=$(openssl rand -hex 32 2>/dev/null); then
  fail 'disposable qualification sentinel generation failed closed'
fi
expected_length=${#sentinel}
expected_sha256=$(printf '%s' "$sentinel" | sha256sum 2>/dev/null | cut -d' ' -f1) \
  || fail 'disposable qualification sentinel digest failed closed'
if [[ ! "$expected_length" =~ ^[1-9][0-9]*$ ]] \
  || [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  fail 'disposable qualification sentinel metadata is invalid'
fi

if ! printf '%s' "$sentinel" | gcloud secrets versions add "$secret" \
  --project="$project_id" --data-file=- --format=json \
  >"$version_file" 2>/dev/null; then
  fail 'disposable qualification secret version creation failed closed'
fi
unset sentinel
version=$(jq -e -r \
  'select(type == "object" and (keys | index("name")) != null)
    | .name
    | capture("/versions/(?<version>[1-9][0-9]*)$").version' \
  "$version_file" 2>/dev/null) \
  || fail 'disposable qualification secret version result is malformed'
if [[ ! "$version" =~ ^[1-9][0-9]*$ ]]; then
  fail 'disposable qualification secret version is invalid'
fi
if ! gcloud run jobs execute "$job" --project="$project_id" --region="$region" \
  --wait --format=json --container=probe \
  --update-env-vars="QUALIFICATION_VERSION=$version" \
  >"$execution_file" 2>/dev/null; then
  fail 'managed authorized-secret qualification execution failed closed'
fi
execution=$(jq -e -r '.metadata.name | select(type == "string")' \
  "$execution_file" 2>/dev/null) \
  || fail 'managed authorized-secret execution result is malformed'
if [[ ! "$execution" =~ ^${job}-[a-z0-9-]+$ ]]; then
  fail 'managed authorized-secret execution identity is invalid'
fi

log_filter="resource.type=\"cloud_run_job\" AND resource.labels.project_id=\"$project_id\" AND resource.labels.location=\"$region\" AND resource.labels.job_name=\"$job\" AND labels.\"run.googleapis.com/execution_name\"=\"$execution\""
qualified=false
for observation in {1..12}; do
  if ! gcloud logging read "$log_filter" --project="$project_id" \
    --freshness=1h --limit=50 --format=json >"$logs_file" 2>/dev/null; then
    fail 'managed authorized-secret log observation failed closed'
  fi
  if "$repo_root/infra/tests/evaluate-authorized-secret-proof.sh" \
    "$logs_file" "$project_id" "$region" "$job" "$execution" \
    "$expected_length" "$expected_sha256" "$candidate_report" \
    >/dev/null 2>&1; then
    qualified=true
    break
  fi
  if ((observation < 12)); then
    sleep 5
  fi
done
if [[ "$qualified" != true ]]; then
  "$repo_root/infra/tests/evaluate-authorized-secret-proof.sh" \
    "$logs_file" "$project_id" "$region" "$job" "$execution" \
    "$expected_length" "$expected_sha256" "$candidate_report" \
    >/dev/null || true
  fail 'managed authorized-secret result did not qualify'
fi

mv "$candidate_report" "$report_file"
printf 'PASS: managed authorized secret read produced sanitized evidence\n'

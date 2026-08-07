#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

logs_file=${1:?logs file is required}
expected_project=${2:?expected project is required}
expected_region=${3:?expected region is required}
expected_job=${4:?expected job is required}
expected_execution=${5:?expected execution is required}
expected_length=${6:?expected payload length is required}
report_file=${7:?report file is required}

if [[ ! "$expected_length" =~ ^[1-9][0-9]*$ ]]; then
  fail 'managed qualification evaluator inputs are invalid'
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
result_file=$scratch/result.json

set +e
jq -s -e \
  --arg project "$expected_project" \
  --arg region "$expected_region" \
  --arg job "$expected_job" \
  --arg execution "$expected_execution" '
    if length != 1 or (.[0] | type) != "array"
      then error("logs must be exactly one array")
      else .[0]
      end
    | map(select(
        .resource.type == "cloud_run_job"
        and .resource.labels.project_id == $project
        and .resource.labels.location == $region
        and .resource.labels.job_name == $job
        and .labels["run.googleapis.com/execution_name"] == $execution
        and (.textPayload | type == "string")
      ))
    | select(length == 1)
    | .[0]
    | .textPayload
    | select((fromjson? | type) == "object")
    | fromjson
    | select(
        type == "object"
        and (keys | sort) == [
          "identity_verified", "payload_length", "payload_sha256_match", "schema_version"
        ]
        and .schema_version == 1
        and .identity_verified == true
        and (.payload_length | type == "number")
        and .payload_sha256_match == true
      )' "$logs_file" >"$result_file" 2>/dev/null
evaluation_status=$?
set -e
if ((evaluation_status == 4)); then
  fail 'managed qualification result is missing or malformed'
fi
if ((evaluation_status != 0)); then
  fail 'managed qualification result evaluator failed closed'
fi

observed_length=$(jq -r '.payload_length' "$result_file" 2>/dev/null) \
  || fail 'managed qualification result evaluator failed closed'
if [[ "$observed_length" != "$expected_length" ]]; then
  fail 'managed qualification payload length does not match'
fi

report_tmp=$scratch/report.json
if ! jq -n \
  --arg project_id "$expected_project" \
  --arg region "$expected_region" \
  --arg job_name "$expected_job" \
  --arg execution_name "$expected_execution" \
  --argjson expected_payload_length "$expected_length" \
  '{schema_version: 1, project_id: $project_id, region: $region,
    job_name: $job_name, execution_name: $execution_name,
    checks: {authorized_secret_version_access: "PASS"},
    expected_payload_length: $expected_payload_length,
    payload_sha256_match: true}' >"$report_tmp" 2>/dev/null; then
  fail 'managed qualification report encoding failed closed'
fi
mv "$report_tmp" "$report_file"
printf 'PASS: authorized secret read matched expected length and digest\n'

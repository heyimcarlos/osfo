#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
probe=$repo_root/infra/modules/qualification-probe/authorized-secret-proof.sh
evaluator=$repo_root/infra/tests/evaluate-authorized-secret-proof.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mock_bin=$scratch/bin
mkdir -p "$mock_bin"

payload='osfo disposable qualification sentinel'
expected_length=${#payload}
expected_sha=$(printf '%s' "$payload" | sha256sum | cut -d' ' -f1)
project_id=osfo-development-123456789
region=us-east4
secret=osfo-dev-authorized-secret-proof
version=7
identity=osfo-dev-qual-authorized@osfo-development-123456789.iam.gserviceaccount.com
job=osfo-dev-authorized-secret-probe
execution=osfo-dev-authorized-secret-probe-abc12

# These single-quoted lines define the mocks. They are not evaluated here.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  *computeMetadata/v1/instance/service-accounts/default/email*)' \
  '    [[ "${MOCK_METADATA_MODE:-success}" == success ]] || exit 1' \
  '    printf "%s\n" "${MOCK_IDENTITY:?}"' \
  '    ;;' \
  '  *) exit 90 ;;' \
  'esac' >"$mock_bin/curl"
chmod +x "$mock_bin/curl"

# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "$*" == "secrets versions access 7 --secret=osfo-dev-authorized-secret-proof --project=osfo-development-123456789" ]] || exit 90' \
  'case "${MOCK_ACCESS_MODE:-success}" in' \
  '  success) printf "%s" "${MOCK_PAYLOAD:?}" ;;' \
  '  failure) printf "provider diagnostic must not escape\n" >&2; exit 1 ;;' \
  '  partial-failure) printf "payload fragment must not escape"; printf "provider diagnostic must not escape\n" >&2; exit 1 ;;' \
  '  *) exit 91 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

run_probe() {
  local scenario=$1
  shift
  local output=$scratch/$scenario.output
  env \
    PATH="$mock_bin:$PATH" \
    MOCK_PAYLOAD="$payload" \
    MOCK_IDENTITY="$identity" \
    PROJECT_ID="$project_id" \
    QUALIFICATION_SECRET="$secret" \
    QUALIFICATION_VERSION="$version" \
    EXPECTED_SERVICE_ACCOUNT="$identity" \
    "$@" \
    "$probe" >"$output" 2>&1
}

run_probe success
jq -e \
  --argjson expected_length "$expected_length" \
  --arg expected_sha "$expected_sha" \
  '. == {
    schema_version: 1,
    identity_verified: true,
    payload_length: $expected_length,
    payload_sha256: $expected_sha
  }' "$scratch/success.output" >/dev/null

expect_probe_fails() {
  local scenario=$1
  local expected_failure=$2
  shift 2
  local output=$scratch/$scenario.output

  if run_probe "$scenario" "$@"; then
    printf '%s authorized-secret probe must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fxq "$expected_failure" "$output"
  if grep -Eq 'osfo disposable qualification sentinel|payload fragment|provider diagnostic' "$output" \
    || grep -Fq '"schema_version":1' "$output"; then
    printf '%s authorized-secret probe leaked data or reported a result\n' "$scenario" >&2
    exit 1
  fi
}

expect_probe_fails wrong-identity \
  'FAIL: managed qualification identity does not match the reviewed identity' \
  MOCK_IDENTITY=wrong@osfo-development-123456789.iam.gserviceaccount.com
expect_probe_fails wrong-project \
  'FAIL: authorized secret-version access failed closed' \
  PROJECT_ID=wrong-project
expect_probe_fails wrong-secret \
  'FAIL: authorized secret-version access failed closed' \
  QUALIFICATION_SECRET=wrong-secret
expect_probe_fails missing-version \
  'FAIL: qualification secret version is not an exact positive integer' \
  QUALIFICATION_VERSION=latest
expect_probe_fails metadata-tool-failure \
  'FAIL: managed qualification identity could not be verified' \
  MOCK_METADATA_MODE=failure
expect_probe_fails provider-tool-failure \
  'FAIL: authorized secret-version access failed closed' \
  MOCK_ACCESS_MODE=failure
expect_probe_fails partial-provider-failure \
  'FAIL: authorized secret-version access failed closed' \
  MOCK_ACCESS_MODE=partial-failure

make_logs() {
  local result_json=$1
  jq -n \
    --arg project_id "$project_id" \
    --arg region "$region" \
    --arg job "$job" \
    --arg execution "$execution" \
    --arg result_json "$result_json" \
    '[{
      resource: {type: "cloud_run_job", labels: {
        project_id: $project_id,
        location: $region,
        job_name: $job
      }},
      labels: {"run.googleapis.com/execution_name": $execution},
      textPayload: $result_json
    }]' >"$scratch/logs.json"
}

make_logs "$(<"$scratch/success.output")"
"$evaluator" \
  "$scratch/logs.json" "$project_id" "$region" "$job" "$execution" \
  "$expected_length" "$expected_sha" "$scratch/report.json"
jq -e \
  --argjson expected_length "$expected_length" \
  '.checks.authorized_secret_version_access == "PASS"
    and .expected_payload_length == $expected_length
    and .payload_sha256_match == true
    and (has("payload_sha256") | not)' "$scratch/report.json" >/dev/null

expect_evaluator_fails() {
  local scenario=$1
  local expected_failure=$2
  local logs=$3
  shift 3
  local output=$scratch/$scenario.output

  if "$evaluator" \
    "$logs" "$project_id" "$region" "$job" "$execution" \
    "$expected_length" "$expected_sha" "$scratch/$scenario-report.json" \
    "$@" >"$output" 2>&1; then
    printf '%s authorized-secret evaluator must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fxq "$expected_failure" "$output"
  test ! -e "$scratch/$scenario-report.json"
}

jq '.[0].resource.labels.project_id = "wrong-project"' \
  "$scratch/logs.json" >"$scratch/wrong-project.logs.json"
expect_evaluator_fails wrong-project-result \
  'FAIL: managed qualification result is missing or malformed' \
  "$scratch/wrong-project.logs.json"

printf '[{"textPayload":"not-json"}]\n' >"$scratch/malformed.logs.json"
expect_evaluator_fails malformed-result \
  'FAIL: managed qualification result is missing or malformed' \
  "$scratch/malformed.logs.json"

jq '.[0].textPayload = (. [0].textPayload | fromjson | .payload_sha256 = ("0" * 64) | tojson)' \
  "$scratch/logs.json" >"$scratch/hash-mismatch.logs.json"
expect_evaluator_fails hash-mismatch \
  'FAIL: managed qualification payload digest does not match' \
  "$scratch/hash-mismatch.logs.json"

jq '.[0].textPayload = (. [0].textPayload | fromjson | .payload_length += 1 | tojson)' \
  "$scratch/logs.json" >"$scratch/length-mismatch.logs.json"
expect_evaluator_fails length-mismatch \
  'FAIL: managed qualification payload length does not match' \
  "$scratch/length-mismatch.logs.json"

jq '. + .' "$scratch/logs.json" >"$scratch/duplicate.logs.json"
expect_evaluator_fails duplicate-result \
  'FAIL: managed qualification result is missing or malformed' \
  "$scratch/duplicate.logs.json"

printf 'not-json\n' >"$scratch/evaluator-tool.logs.json"
expect_evaluator_fails evaluator-tool-failure \
  'FAIL: managed qualification result evaluator failed closed' \
  "$scratch/evaluator-tool.logs.json"

live_proof=$repo_root/infra/tests/development-authorized-secret-live.sh
live_bin=$scratch/live-bin
mkdir -p "$live_bin"
jq -n \
  --arg project_id "$project_id" \
  --arg identity "$identity" \
  --arg job "$job" \
  --arg secret "$secret" \
  '{qualification_probe_jobs: {authorized_secret: $job},
    qualification_secret_name: $secret,
    qualification_service_accounts: {authorized_secret: $identity}}' \
  >"$scratch/platform.json"
jq -n --arg project_id "$project_id" --arg region "$region" \
  '{project_id: $project_id, region: $region}' >"$scratch/varset.json"

# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "secrets versions add osfo-dev-authorized-secret-proof --project=osfo-development-123456789 --data-file=- --format=json")' \
  '    sentinel=$(</dev/stdin)' \
  '    printf "%s" "${#sentinel}" >"$MOCK_LIVE_LENGTH"' \
  '    printf "%s" "$sentinel" | sha256sum | cut -d" " -f1 >"$MOCK_LIVE_SHA"' \
  '    printf "%s\n" "{\"name\":\"projects/123456789012/secrets/osfo-dev-authorized-secret-proof/versions/7\"}"' \
  '    ;;' \
  '  "run jobs execute osfo-dev-authorized-secret-probe --project=osfo-development-123456789 --region=us-east4 --wait --format=json --container=probe --update-env-vars=QUALIFICATION_VERSION=7")' \
  '    printf "%s\n" executed >>"$MOCK_LIVE_EXECUTIONS"' \
  '    printf "%s\n" "{\"metadata\":{\"name\":\"osfo-dev-authorized-secret-probe-abc12\"}}"' \
  '    ;;' \
  '  "logging read "*)' \
  '    result=$(jq -cn --argjson length "$(<"$MOCK_LIVE_LENGTH")" --arg sha "$(<"$MOCK_LIVE_SHA")" '\''{schema_version: 1, identity_verified: true, payload_length: $length, payload_sha256: $sha}'\'')' \
  '    jq -n --arg result "$result" '\''[{resource: {type: "cloud_run_job", labels: {project_id: "osfo-development-123456789", location: "us-east4", job_name: "osfo-dev-authorized-secret-probe"}}, labels: {"run.googleapis.com/execution_name": "osfo-dev-authorized-secret-probe-abc12"}, textPayload: $result}]'\''' \
  '    ;;' \
  '  *) printf "unexpected live proof invocation\n" >&2; exit 90 ;;' \
  'esac' >"$live_bin/gcloud"
chmod +x "$live_bin/gcloud"

live_output=$scratch/live.output
PATH="$live_bin:$PATH" \
  TF_VARSET_FILE="$scratch/varset.json" \
  MOCK_LIVE_LENGTH="$scratch/live.length" \
  MOCK_LIVE_SHA="$scratch/live.sha" \
  MOCK_LIVE_EXECUTIONS="$scratch/live.executions" \
  "$live_proof" "$scratch/platform.json" "$scratch/live-report.json" \
  >"$live_output" 2>&1
grep -Fxq 'PASS: managed authorized secret read produced sanitized evidence' "$live_output"
[[ $(wc -l <"$scratch/live.executions") == 1 ]]
jq -e '
  .checks.authorized_secret_version_access == "PASS"
  and .expected_payload_length == 64
  and .payload_sha256_match == true
  and (has("payload_sha256") | not)
' "$scratch/live-report.json" >/dev/null
if grep -Fq "$(<"$scratch/live.sha")" "$scratch/live-report.json" "$live_output"; then
  printf 'managed live proof persisted a sentinel digest instead of a comparison\n' >&2
  exit 1
fi

if rg -n 'osfo disposable qualification sentinel|payload fragment|provider diagnostic' \
  "$scratch"/*.output "$scratch"/*report.json 2>/dev/null; then
  printf 'authorized-secret evidence leaked payload or provider diagnostics\n' >&2
  exit 1
fi

printf 'development authorized-secret proof assertions passed\n'

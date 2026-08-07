#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
probe=$repo_root/infra/modules/qualification-probe/authorized-secret-proof.sh
evaluator=$repo_root/infra/tests/evaluate-authorized-secret-proof.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mock_bin=$scratch/bin
mkdir -p "$mock_bin"

run_id=31180000000-1
payload=$(printf 'osfo-authorized-secret-proof-v1:%s' "$run_id" | sha256sum | cut -d' ' -f1)
expected_length=${#payload}
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
  '  success) [[ ${MOCK_PAYLOAD+x} ]] || exit 92; printf "%s" "$MOCK_PAYLOAD" ;;' \
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
    QUALIFICATION_RUN_ID="$run_id" \
    EXPECTED_SERVICE_ACCOUNT="$identity" \
    "$@" \
    "$probe" >"$output" 2>&1
}

run_probe success
jq -e \
  --argjson expected_length "$expected_length" \
  '. == {
    schema_version: 1,
    identity_verified: true,
    payload_length: $expected_length,
    payload_sha256_match: true
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
  if grep -Eq "$payload|payload fragment|provider diagnostic|[0-9a-f]{64}" "$output" \
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
expect_probe_fails unsafe-run-id \
  'FAIL: qualification run identifier contains unsafe characters' \
  QUALIFICATION_RUN_ID='unsafe run'
expect_probe_fails hash-mismatch \
  'FAIL: authorized secret-version payload digest does not match' \
  MOCK_PAYLOAD=wrong
expect_probe_fails empty-payload \
  'FAIL: authorized secret-version payload length is invalid' \
  MOCK_PAYLOAD=
expect_probe_fails metadata-tool-failure \
  'FAIL: managed qualification identity could not be verified' \
  MOCK_METADATA_MODE=failure
expect_probe_fails provider-tool-failure \
  'FAIL: authorized secret-version access failed closed' \
  MOCK_ACCESS_MODE=failure
expect_probe_fails partial-provider-failure \
  'FAIL: authorized secret-version access failed closed' \
  MOCK_ACCESS_MODE=partial-failure

real_sha256sum=$(command -v sha256sum)
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "${MOCK_DIGEST_MODE:-success}" in' \
  '  failure) exit 1 ;;' \
  '  invalid) printf "%s\n" invalid ;;' \
  '  *) exec "$REAL_SHA256SUM" "$@" ;;' \
  'esac' >"$mock_bin/sha256sum"
chmod +x "$mock_bin/sha256sum"
expect_probe_fails digest-tool-failure \
  'FAIL: authorized secret-version digest tool failed closed' \
  MOCK_DIGEST_MODE=failure REAL_SHA256SUM="$real_sha256sum"
expect_probe_fails invalid-digest-result \
  'FAIL: authorized secret-version digest is invalid' \
  MOCK_DIGEST_MODE=invalid REAL_SHA256SUM="$real_sha256sum"
rm "$mock_bin/sha256sum"

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
  "$expected_length" "$scratch/report.json"
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

  if PATH="$mock_bin:$PATH" "$evaluator" \
    "$logs" "$project_id" "$region" "$job" "$execution" \
    "$expected_length" "$scratch/$scenario-report.json" \
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

jq '.[0].textPayload = (. [0].textPayload | fromjson | .payload_sha256_match = false | tojson)' \
  "$scratch/logs.json" >"$scratch/hash-mismatch.logs.json"
expect_evaluator_fails hash-mismatch \
  'FAIL: managed qualification result is missing or malformed' \
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

real_jq=$(command -v jq)
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ " $* " == " -n "* ]]; then exit 1; fi' \
  'exec "$REAL_JQ" "$@"' >"$mock_bin/jq"
chmod +x "$mock_bin/jq"
REAL_JQ="$real_jq" expect_evaluator_fails report-encoding-failure \
  'FAIL: managed qualification report encoding failed closed' \
  "$scratch/logs.json"
rm "$mock_bin/jq"

live_proof=$repo_root/infra/tests/development-authorized-secret-live.sh
live_bin=$scratch/live-bin
mkdir -p "$live_bin"
real_sha256sum=$(command -v sha256sum)
real_mv=$(command -v mv)
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
  '    case "${MOCK_LIVE_MODE:-success}" in' \
  '      version-add-failure) printf "provider diagnostic must not escape\n" >&2; exit 1 ;;' \
  '      malformed-version) printf "%s\n" "{\"name\":7}" ;;' \
  '      wrong-project-version) printf "%s\n" "{\"name\":\"projects/999999999999/secrets/osfo-dev-authorized-secret-proof/versions/7\"}" ;;' \
  '      wrong-secret-version) printf "%s\n" "{\"name\":\"projects/123456789012/secrets/wrong-secret/versions/7\"}" ;;' \
  '      *) printf "%s\n" "{\"name\":\"projects/123456789012/secrets/osfo-dev-authorized-secret-proof/versions/7\"}" ;;' \
  '    esac' \
  '    ;;' \
  '  "projects describe osfo-development-123456789 --format=json")' \
  '    case "${MOCK_LIVE_MODE:-success}" in' \
  '      project-lookup-failure) printf "provider diagnostic must not escape\n" >&2; exit 1 ;;' \
  '      malformed-project) printf "%s\n" "{\"projectId\":\"wrong-project\",\"projectNumber\":\"123456789012\"}" ;;' \
  '      *) printf "%s\n" "{\"projectId\":\"osfo-development-123456789\",\"projectNumber\":\"123456789012\"}" ;;' \
  '    esac' \
  '    ;;' \
  '  "run jobs execute osfo-dev-authorized-secret-probe --project=osfo-development-123456789 --region=us-east4 --wait --format=json --container=probe --update-env-vars=QUALIFICATION_VERSION=7,QUALIFICATION_RUN_ID=31180000000-1")' \
  '    printf "%s\n" executed >>"$MOCK_LIVE_EXECUTIONS"' \
  '    case "${MOCK_LIVE_MODE:-success}" in' \
  '      execution-failure) printf "provider diagnostic must not escape\n" >&2; exit 1 ;;' \
  '      malformed-execution) printf "%s\n" "{\"metadata\":{}}" ;;' \
  '      wrong-execution) printf "%s\n" "{\"metadata\":{\"name\":\"wrong-execution\"}}" ;;' \
  '      *) printf "%s\n" "{\"metadata\":{\"name\":\"osfo-dev-authorized-secret-probe-abc12\"}}" ;;' \
  '    esac' \
  '    ;;' \
  '  "logging read "*)' \
  '    case "${MOCK_LIVE_MODE:-success}" in' \
  '      logging-failure) printf "provider diagnostic must not escape\n" >&2; exit 1 ;;' \
  '      empty-logs|sleep-failure) printf "%s\n" "[]"; exit 0 ;;' \
  '      malformed-logs) printf "%s\n" "not-json"; exit 0 ;;' \
  '    esac' \
  '    result=$(jq -cn --argjson length "$(<"$MOCK_LIVE_LENGTH")" '\''{schema_version: 1, identity_verified: true, payload_length: $length, payload_sha256_match: true}'\'')' \
  '    jq -n --arg result "$result" '\''[{resource: {type: "cloud_run_job", labels: {project_id: "osfo-development-123456789", location: "us-east4", job_name: "osfo-dev-authorized-secret-probe"}}, labels: {"run.googleapis.com/execution_name": "osfo-dev-authorized-secret-probe-abc12"}, textPayload: $result}]'\''' \
  '    ;;' \
  '  *) printf "unexpected live proof invocation\n" >&2; exit 90 ;;' \
  'esac' >"$live_bin/gcloud"
chmod +x "$live_bin/gcloud"

# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  '[[ "${MOCK_LIVE_MODE:-success}" != sentinel-tool-failure ]] || exit 1' \
  'exec "$REAL_SHA256SUM" "$@"' >"$live_bin/sha256sum"
chmod +x "$live_bin/sha256sum"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  '[[ "${MOCK_LIVE_MODE:-success}" != sleep-failure ]] || exit 1' \
  'exit 0' >"$live_bin/sleep"
chmod +x "$live_bin/sleep"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "${MOCK_LIVE_MODE:-success}" == report-publication-failure ]]; then' \
  '  count=0' \
  '  [[ ! -e "$MOCK_MV_COUNT" ]] || count=$(<"$MOCK_MV_COUNT")' \
  '  count=$((count + 1))' \
  '  printf "%s" "$count" >"$MOCK_MV_COUNT"' \
  '  ((count < 2)) || exit 1' \
  'fi' \
  'exec "$REAL_MV" "$@"' >"$live_bin/mv"
chmod +x "$live_bin/mv"

run_live() {
  local scenario=$1
  local mode=$2
  local report=$3
  local output=$scratch/$scenario.output
  : >"$scratch/live.executions"
  rm -f "$scratch/live.mv-count"
  PATH="$live_bin:$PATH" \
    TF_VARSET_FILE="$scratch/varset.json" \
    DEVELOPMENT_LIFECYCLE_RUN_ID="$run_id" \
    MOCK_LIVE_MODE="$mode" \
    MOCK_LIVE_LENGTH="$scratch/live.length" \
    MOCK_LIVE_EXECUTIONS="$scratch/live.executions" \
    MOCK_MV_COUNT="$scratch/live.mv-count" \
    REAL_SHA256SUM="$real_sha256sum" \
    REAL_MV="$real_mv" \
    "$live_proof" "$scratch/platform.json" "$report" \
    >"$output" 2>&1
}

live_output=$scratch/live.output
run_live live success "$scratch/live-report.json"
grep -Fxq 'PASS: managed authorized secret read produced sanitized evidence' "$live_output"
[[ $(wc -l <"$scratch/live.executions") == 1 ]]
jq -e '
  .checks.authorized_secret_version_access == "PASS"
  and .expected_payload_length == 64
  and .payload_sha256_match == true
  and (has("payload_sha256") | not)
' "$scratch/live-report.json" >/dev/null
if grep -Eq '[0-9a-f]{64}' "$scratch/live-report.json" "$live_output"; then
  printf 'managed live proof persisted a sentinel or digest instead of a comparison\n' >&2
  exit 1
fi

expect_live_fails() {
  local scenario=$1
  local mode=$2
  local expected_failure=$3
  local report=$scratch/$scenario-report.json
  if run_live "$scenario" "$mode" "$report"; then
    printf '%s managed live proof must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fxq "$expected_failure" "$scratch/$scenario.output"
  test ! -e "$report"
  if grep -Eq "$payload|provider diagnostic|[0-9a-f]{64}" "$scratch/$scenario.output"; then
    printf '%s managed live proof leaked a payload, digest, or provider error\n' \
      "$scenario" >&2
    exit 1
  fi
}

expect_live_fails sentinel-tool-failure sentinel-tool-failure \
  'FAIL: disposable qualification sentinel generation failed closed'
expect_live_fails version-add-failure version-add-failure \
  'FAIL: disposable qualification secret version creation failed closed'
expect_live_fails project-lookup-failure project-lookup-failure \
  'FAIL: development project lookup failed closed'
expect_live_fails malformed-project malformed-project \
  'FAIL: development project result is malformed'
for malformed_version_mode in malformed-version wrong-project-version wrong-secret-version; do
  expect_live_fails "$malformed_version_mode" "$malformed_version_mode" \
    'FAIL: disposable qualification secret version result is malformed'
done
expect_live_fails execution-failure execution-failure \
  'FAIL: managed authorized-secret qualification execution failed closed'
expect_live_fails malformed-execution malformed-execution \
  'FAIL: managed authorized-secret execution result is malformed'
expect_live_fails wrong-execution wrong-execution \
  'FAIL: managed authorized-secret execution identity is invalid'
expect_live_fails logging-failure logging-failure \
  'FAIL: managed authorized-secret log observation failed closed'
expect_live_fails empty-observations empty-logs \
  'FAIL: managed authorized-secret result did not qualify'
expect_live_fails malformed-observations malformed-logs \
  'FAIL: managed authorized-secret result did not qualify'
expect_live_fails sleep-failure sleep-failure \
  'FAIL: managed authorized-secret observation delay failed closed'
expect_live_fails report-publication-failure report-publication-failure \
  'FAIL: managed authorized-secret report publication failed closed'

if rg -n "$payload|payload fragment|provider diagnostic" \
  "$scratch"/*.output "$scratch"/*report.json 2>/dev/null; then
  printf 'authorized-secret evidence leaked payload or provider diagnostics\n' >&2
  exit 1
fi

printf 'development authorized-secret proof assertions passed\n'

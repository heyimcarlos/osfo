#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
proof=$repo_root/infra/modules/qualification-probe/denied-secret-proof.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mock_bin=$scratch/bin
mkdir -p "$mock_bin"

# The single-quoted lines are the source of the generated mock, not expressions
# for this contract process.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "$*" == "secrets versions access latest --secret=osfo-dev-model-adapter --project=osfo-development-123456789" ]] || exit 90' \
  'case "${MOCK_SECRET_ACCESS_MODE:?}" in' \
  '  denied) printf "mutable provider denial wording\n" >&2; exit 1 ;;' \
  '  success) printf "sensitive-payload-must-not-escape\n"; exit 0 ;;' \
  '  payload-on-failure) printf "sensitive-payload-must-not-escape\n"; exit 1 ;;' \
  '  *) exit 91 ;;' \
  'esac' >"$mock_bin/gcloud"
chmod +x "$mock_bin/gcloud"

pass_output=$scratch/pass-output
PATH="$mock_bin:$PATH" \
  MOCK_SECRET_ACCESS_MODE=denied \
  PROJECT_ID=osfo-development-123456789 \
  MODEL_SECRET=osfo-dev-model-adapter \
  "$proof" >"$pass_output" 2>&1
grep -Fxq 'PASS unintended_secret_accessor_denied_without_payload' "$pass_output"

expect_proof_fails() {
  local scenario=$1
  local mode=$2
  local expected_failure=$3
  local output=$scratch/$scenario-output

  if PATH="$mock_bin:$PATH" \
    MOCK_SECRET_ACCESS_MODE="$mode" \
    PROJECT_ID=osfo-development-123456789 \
    MODEL_SECRET=osfo-dev-model-adapter \
    "$proof" >"$output" 2>&1; then
    printf '%s denied-secret proof must fail closed\n' "$scenario" >&2
    exit 1
  fi
  grep -Fxq "$expected_failure" "$output"
  if grep -Fq 'sensitive-payload-must-not-escape' "$output" \
    || grep -Fq 'PASS ' "$output"; then
    printf '%s denied-secret proof leaked payload or reported PASS\n' "$scenario" >&2
    exit 1
  fi
}

expect_proof_fails \
  access-success success \
  'FAIL: denied secret-version access unexpectedly succeeded'
expect_proof_fails \
  payload-on-failure payload-on-failure \
  'FAIL: denied secret-version access emitted a payload'

printf 'development denied-secret runtime proof assertions passed\n'

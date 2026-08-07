#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
agent_run_id=${1:-}
destination=${2:-}
database_url=${OSFO_DATABASE_URL:-}

if [[ -z "$agent_run_id" || -z "$destination" || -z "$database_url" ]]; then
  printf 'MISSING: reconciliation requires an AgentRun ID, destination, and OSFO_DATABASE_URL\n' >&2
  exit 2
fi

work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT
output_log="$work_directory/reconciliation-output.log"

if ! OSFO_RECONCILIATION_AGENT_RUN_ID="$agent_run_id" \
  OSFO_RECONCILIATION_REQUIRE_PASS=true \
  node --conditions=development --import tsx \
    "$repo_root/scripts/qualification/reconcile-agent-run.ts" \
    >"$output_log" 2>&1; then
  exit 1
fi

encoded=$(sed -n \
  's/.*OSFO_RECONCILIATION_EVIDENCE:\([A-Za-z0-9+/=]*\).*/\1/p' \
  "$output_log" | head -1)
if [[ -z "$encoded" ]]; then
  exit 1
fi
printf '%s' "$encoded" | base64 --decode >"$destination"

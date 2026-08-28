#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"

if grep -E -q 'inspect-agent-storage|wrangler-state/v3/do|\.sqlite' "$control"; then
  printf 'account deletion verification must not inspect Wrangler SQLite storage directly\n' >&2
  exit 1
fi

if ! grep -F -q 'agent-runtime-observer.ts' "$control"; then
  printf 'account deletion verification must use the production Agent runtime observer\n' >&2
  exit 1
fi

observer="$repo_root/apps/worker/test/support/agent-runtime-observer.ts"
if ! grep -F -q 'inspectReminderVerificationState' "$observer"; then
  printf 'Reminder verification must use the production-owned Agent snapshot RPC\n' >&2
  exit 1
fi
if ! grep -F -q 'ResearchReportWorkflow' "$observer" ||
  ! grep -F -q 'ResearchReportTimerWorkflow' "$observer"; then
  printf 'Agent runtime observer must export every configured Research Report Workflow host\n' >&2
  exit 1
fi
if grep -E -q 'body_snapshot|callback_capability|\.body\b' "$observer"; then
  printf 'Agent runtime evidence must not expose private Reminder bodies or callback capabilities\n' >&2
  exit 1
fi
if ! grep -F -q 'reminder-think-runtime.json' "$control"; then
  printf 'WhatsApp verification must retain machine-readable Reminder Think evidence\n' >&2
  exit 1
fi
if [[ "$(grep -F -c '.reminderVerification.reminderCount >= 1' "$control")" != '1' ]]; then
  printf 'Account deletion must not require a Reminder outside Reminder verification\n' >&2
  exit 1
fi
observer_line="$(grep -n -F 'agent_runtime="$(inspect_agent_runtime' "$control" | head -n 1 | cut -d: -f1)"
seed_marker_line="$(grep -n -F '>"$state_dir/account-deletion-user-id"' "$control" | head -n 1 | cut -d: -f1)"
if [[ -z "$observer_line" || -z "$seed_marker_line" || "$seed_marker_line" -le "$observer_line" ]]; then
  printf 'Account deletion must not mark its seed complete before Agent observation succeeds\n' >&2
  exit 1
fi
if ! grep -F -q '([.[] | select(.kind == "discover")] | length == 1)' "$control"; then
  printf 'Research provider counts must remain independent jq predicates\n' >&2
  exit 1
fi

printf 'agent runtime observer verifier checks passed\n'

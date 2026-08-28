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
if grep -E -q 'body_snapshot|callback_capability|\.body\b' "$observer"; then
  printf 'Agent runtime evidence must not expose private Reminder bodies or callback capabilities\n' >&2
  exit 1
fi
if ! grep -F -q 'reminder-think-runtime.json' "$control"; then
  printf 'WhatsApp verification must retain machine-readable Reminder Think evidence\n' >&2
  exit 1
fi

printf 'agent runtime observer verifier checks passed\n'

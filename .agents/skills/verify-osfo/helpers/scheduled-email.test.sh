#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/scheduled-email.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
observer="$repo_root/apps/worker/test/support/agent-runtime-observer.ts"
workspace_manifest="$repo_root/package.json"

for required in \
  'scheduled-email)' \
  'scheduled_email_request()' \
  'observe_scheduled_email()' \
  '.dueToSendMilliseconds <= 60000' \
  '.sendToTerminalMilliseconds <= 120000' \
  '.terminalToFollowUpMilliseconds <= 60000' \
  '.gmailSendUsage == 1' \
  '.workflowStartUsage == 1' \
  '.scheduledEmailWorkflow.status == "complete"' \
  'provider_boundary=local-loopback-gmail-not-live-oauth'; do
  if ! grep -F -q "$required" "$control"; then
    printf 'Scheduled Email verifier is missing invariant: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'scheduleEmail' \
  'inspectScheduledEmail' \
  'kind: "tool-selection"' \
  '/_test/integrations/reset-ledger'; do
  if ! grep -F -q "$required" "$emulator"; then
    printf 'Provider emulator is missing Scheduled Email evidence: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'Connect Gmail' \
  'Approve exact Scheduled Email' \
  'Scheduled Email sent' \
  'scheduled-email-request' \
  'local Gmail provider boundary, not live Gmail OAuth'; do
  if ! grep -F -q "$required" "$feature"; then
    printf 'Scheduled Email browser drive is missing a real User step: %s\n' "$required" >&2
    exit 1
  fi
done

if ! grep -F -q 'ScheduledEmailWorkflow' "$observer"; then
  printf 'Agent runtime observer must export the Scheduled Email Workflow host\n' >&2
  exit 1
fi

if ! grep -F -q 'bash .agents/skills/verify-osfo/helpers/scheduled-email.test.sh' \
  "$workspace_manifest"; then
  printf 'Workspace verification must run the Scheduled Email verifier checks\n' >&2
  exit 1
fi

printf 'Scheduled Email verifier checks passed\n'

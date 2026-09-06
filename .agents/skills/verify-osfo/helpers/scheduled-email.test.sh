#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/scheduled-email.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
observer="$repo_root/apps/worker/test/support/agent-runtime-observer.ts"
approval_check="$repo_root/.agents/skills/verify-osfo/helpers/scheduled-email-approval.jq"
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
  'n.think_submission_id is not null' \
  '.scheduledEmailWorkflow.status == "complete"' \
  "--data-urlencode 'cron=0 * * * *'" \
  'provider_boundary=local-loopback-gmail-not-live-oauth'; do
  if ! grep -F -q -- "$required" "$control"; then
    printf 'Scheduled Email verifier is missing invariant: %s\n' "$required" >&2
    exit 1
  fi
done

approval_fixture='{"actionId":"action-1","approvalPresentation":{"operation":"integration.effect","actionDefinitionVersion":"osfo-scheduled-email-start-v1","actionId":"action-1","fields":[{"label":"Gmail mailbox","name":"gmailResource","value":"primary"},{"label":"Recipients","name":"recipients","value":"[\"recipient@example.test\"]"},{"label":"Subject","name":"subject","value":"Subject"},{"label":"Message","name":"body","value":"Body"},{"label":"Send at","name":"scheduledAt","value":"2026-08-28T12:00:00.000Z"}]}}'
approval_args=(--arg recipient 'recipient@example.test' --arg subject 'Subject' --arg body 'Body' --arg dueAt '2026-08-28T12:00:00.000Z')
if ! jq --exit-status "${approval_args[@]}" --from-file "$approval_check" <<<"$approval_fixture" >/dev/null; then
  printf 'Exact Scheduled Email Approval fixture must pass\n' >&2
  exit 1
fi
for mutation in \
  '.approvalPresentation.actionId = "changed"' \
  '.approvalPresentation.fields[0].value = "secondary"' \
  '.approvalPresentation.fields[1].value = "[]"' \
  '.approvalPresentation.fields[2].value = "changed"' \
  '.approvalPresentation.fields[3].value = "changed"' \
  '.approvalPresentation.fields[4].value = "2026-08-28T12:01:00.000Z"'; do
  if jq "$mutation" <<<"$approval_fixture" | jq --exit-status "${approval_args[@]}" --from-file "$approval_check" >/dev/null; then
    printf 'Scheduled Email Approval mutation unexpectedly passed: %s\n' "$mutation" >&2
    exit 1
  fi
done

if grep -F -q 'n.submission_id' "$control"; then
  printf 'Scheduled Email observer queries a nonexistent notification submission column\n' >&2
  exit 1
fi

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

fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
eval "$(sed -n '/^evidence_start() {$/,/^}$/p' "$control")"
doctor_run() { :; }
artifact_dir_for() { printf '%s/%s\n' "$fixture_dir" "$1"; }
feature_artifact_dir_for() { printf '%s/%s/%s\n' "$fixture_dir" "$1" "$2"; }
state_value() { printf 'fixture-%s\n' "$2"; }
curl() { printf '[]\n' >"$fixture_dir/provider-ledger.json"; }

scheduled_dir="$fixture_dir/combined/scheduled-email"
immediate_dir="$fixture_dir/combined/immediate-gmail-send"
mkdir -p "$scheduled_dir" "$immediate_dir"
printf 'preserve existing browser evidence\n' >"$scheduled_dir/browser-actions.txt"
printf '["existing Gmail send"]\n' >"$fixture_dir/provider-ledger.json"
for evidence in action.png result.png approval.json browser-evidence.json browser-actions.txt; do
  printf 'captured evidence\n' >"$immediate_dir/$evidence"
  if output="$(evidence_start combined scheduled-email 2>&1)"; then
    printf 'Unobserved Immediate Gmail %s must prevent Scheduled Email evidence start\n' "$evidence" >&2
    exit 1
  fi
  if [[ "$output" != *'observe combined immediate-gmail-send'* ]]; then
    printf 'Guard must name the required observation command, got: %s\n' "$output" >&2
    exit 1
  fi
  if [[ -e "$scheduled_dir/metadata.txt" || \
    "$(<"$scheduled_dir/browser-actions.txt")" != 'preserve existing browser evidence' || \
    "$(<"$fixture_dir/provider-ledger.json")" != '["existing Gmail send"]' || \
    "$(<"$immediate_dir/$evidence")" != 'captured evidence' ]]; then
    printf 'Rejected evidence start must preserve metadata, browser evidence, and the provider ledger\n' >&2
    exit 1
  fi
  rm "$immediate_dir/$evidence"
done

printf 'captured evidence\n' >"$immediate_dir/browser-evidence.json"
: >"$immediate_dir/observation-passed.txt"
if (evidence_start combined scheduled-email >/dev/null 2>&1); then
  printf 'An empty observation marker must not permit the provider reset\n' >&2
  exit 1
fi
printf 'observed_at=2026-09-06T00:00:00Z\ncommit=fixture-commit\n' \
  >"$immediate_dir/observation-passed.txt"
evidence_start combined scheduled-email >/dev/null
if [[ ! -s "$scheduled_dir/metadata.txt" || "$(<"$fixture_dir/provider-ledger.json")" != '[]' ]]; then
  printf 'Observed Immediate Gmail must permit Scheduled Email evidence start and its provider reset\n' >&2
  exit 1
fi

mkdir -p "$fixture_dir/scheduled-only/immediate-gmail-send"
printf 'started evidence\n' >"$fixture_dir/scheduled-only/immediate-gmail-send/metadata.txt"
: >"$fixture_dir/scheduled-only/immediate-gmail-send/browser-actions.txt"
evidence_start scheduled-only scheduled-email >/dev/null
if [[ ! -s "$fixture_dir/scheduled-only/scheduled-email/metadata.txt" ]]; then
  printf 'A run without Immediate Gmail action or result evidence must remain usable\n' >&2
  exit 1
fi

printf 'Scheduled Email verifier checks passed\n'

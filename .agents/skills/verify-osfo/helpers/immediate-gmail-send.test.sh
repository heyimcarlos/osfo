#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/immediate-gmail-send.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
observer="$repo_root/apps/worker/test/support/agent-runtime-observer.ts"
observation_check="$repo_root/.agents/skills/verify-osfo/helpers/immediate-gmail-send-observation.jq"
deletion_check="$repo_root/.agents/skills/verify-osfo/helpers/immediate-gmail-send-deletion.jq"
workspace_manifest="$repo_root/package.json"

observation_fixture='{
  "browser": {
    "action": {
      "control": "Approve exact Gmail send",
      "decision": "approve",
      "visibleConsequence": "Send this exact message to the listed external recipients.",
      "visibleFields": {
        "body": "Exact body",
        "gmailResource": "primary",
        "manifestVersion": "gmail-v1",
        "recipients": ["recipient@example.test"],
        "subject": "Exact subject"
      },
      "visibleTitle": "Send Gmail message"
    },
    "result": {
      "approvedNotice": "Immediate Gmail send approved.",
      "outcome": "Gmail message sent",
      "replayView": {
        "pendingApprovalCount": 0,
        "terminalCardCount": 1,
        "terminalStatus": "applied"
      }
    }
  },
  "durable": {
    "actionId": "verification-gmailSendEmail::cf-wai-tool-call::turn-1",
    "approvalConnectionBinding": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "integrationAction": {
      "_tag": "Applied",
      "providerRequestId": "request-1",
      "result": {
        "evidence": {
          "providerLogId": "log-1",
          "providerResourceId": "resource-1"
        },
        "operation": "GMAIL_SEND_EMAIL",
        "toolkit": "gmail"
      }
    },
    "presentation": {
      "actionId": "verification-gmailSendEmail::cf-wai-tool-call::turn-1",
      "consequences": ["Send this exact message to the listed external recipients."],
      "description": "Send the exact Gmail message shown here.",
      "fields": [
        {"label":"Gmail mailbox","name":"gmailResource","value":"primary"},
        {"label":"Integration manifest","name":"manifestVersion","value":"gmail-v1"},
        {"label":"Recipients","name":"recipients","value":"[\"recipient@example.test\"]"},
        {"label":"Subject","name":"subject","value":"Exact subject"},
        {"label":"Message","name":"body","value":"Exact body"}
      ],
      "presentationId": "presentation-1",
      "title": "Send Gmail message"
    },
    "presentationId": "presentation-1",
    "terminal": {
      "actionId": "verification-gmailSendEmail::cf-wai-tool-call::turn-1",
      "presentationId": "presentation-1",
      "status": "applied",
      "userId": "user-1"
    },
    "userId": "user-1"
  },
  "http": {"approvalRequests":1,"approvalSuccesses":1},
  "postgres": {
    "agentId":"agent-1",
    "authSessionId":"session-1",
    "gmailSendUsage":[{"allowanceKind":"gmailSends","basis":"observed","quantity":"1","sourceId":"verification-gmailSendEmail::cf-wai-tool-call::turn-1","sourceType":"integrationAction"}],
    "userId":"user-1"
  },
  "provider": {
    "integration":[{
      "connectionBinding":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "input":{"body":"Exact body","recipient_email":"recipient@example.test","subject":"Exact subject"},
      "logId":"log-1",
      "providerRequestId":"request-1",
      "providerResourceId":"resource-1",
      "providerTool":"GMAIL_SEND_EMAIL"
    }],
    "model":[{"kind":"tool-selection","operationId":"verification-gmailSendEmail","selectedTool":"gmailSendEmail","subject":"recipient@example.test|Exact subject|Exact body"}]
  },
  "replayQualification": {
    "commit":"commit-1",
    "guarantee":"second approval POST rejected with provider and accounting ledgers unchanged",
    "result":"PASS",
    "test":"uses trusted Agent setup, then proves public immediate Gmail approval and status HTTP"
  }
}'

observation_args=(
  --arg recipient 'recipient@example.test'
  --arg subject 'Exact subject'
  --arg body 'Exact body'
  --arg commit 'commit-1'
)

if ! jq --exit-status "${observation_args[@]}" --from-file "$observation_check" \
  <<<"$observation_fixture" >/dev/null; then
  printf 'Exact Immediate Gmail identity chain fixture must pass\n' >&2
  exit 1
fi

for mutation in \
  '.durable.presentation.actionId = "different-action"' \
  '.durable.terminal.actionId = "different-action"' \
  '.durable.terminal.presentationId = "different-presentation"' \
  '.durable.terminal.status = "notApplied"' \
  '.provider.integration[0].connectionBinding = ("b" * 64)' \
  '.provider.integration[0].providerRequestId = "different-request"' \
  '.provider.integration[0].logId = "different-log"' \
  '.provider.integration[0].providerResourceId = "different-resource"' \
  '.postgres.gmailSendUsage = []' \
  '.postgres.gmailSendUsage[0].sourceId = "different-action"' \
  '.postgres.gmailSendUsage += [.postgres.gmailSendUsage[0]]' \
  '.browser = "arbitrary action and result prose"' \
  '.browser.action.visibleFields.subject = "different-subject"' \
  '.browser.result.replayView.pendingApprovalCount = 1' \
  '.replayQualification = null'; do
  if jq "$mutation" <<<"$observation_fixture" \
    | jq --exit-status "${observation_args[@]}" --from-file "$observation_check" >/dev/null; then
    printf 'Immediate Gmail identity mutation unexpectedly passed: %s\n' "$mutation" >&2
    exit 1
  fi
done

deletion_fixture='{
  "agentRuntime":{"inspectable":false,"registered":false},
  "immediateGmailActionId":"verification-gmailSendEmail::cf-wai-tool-call::turn-1",
  "immediateGmailAgentFacetExists":false,
  "immediateGmailConnectionStateExists":false,
  "immediateGmailPresentationId":"presentation-1",
  "immediateGmailProofExpected":true,
  "userExists":false
}'
if ! jq --exit-status --from-file "$deletion_check" <<<"$deletion_fixture" >/dev/null; then
  printf 'Exact Immediate Gmail deletion fixture must pass\n' >&2
  exit 1
fi
for mutation in \
  '.immediateGmailActionId = ""' \
  '.immediateGmailPresentationId = ""' \
  '.immediateGmailAgentFacetExists = true' \
  '.immediateGmailConnectionStateExists = true' \
  '.agentRuntime.registered = true' \
  '.userExists = true'; do
  if jq "$mutation" <<<"$deletion_fixture" \
    | jq --exit-status --from-file "$deletion_check" >/dev/null; then
    printf 'Immediate Gmail deletion mutation unexpectedly passed: %s\n' "$mutation" >&2
    exit 1
  fi
done

deletion_receipt="$(jq '{
  actionId: .immediateGmailActionId,
  agentFacetExists: .immediateGmailAgentFacetExists,
  connectionStateExists: .immediateGmailConnectionStateExists,
  observedAt: "2026-09-01T00:00:00Z",
  presentationId: .immediateGmailPresentationId,
  userExists: .userExists
}' <<<"$deletion_fixture")"
if ! jq --exit-status '
  .actionId == "verification-gmailSendEmail::cf-wai-tool-call::turn-1" and
  .presentationId == "presentation-1" and .agentFacetExists == false and
  .connectionStateExists == false and .userExists == false and
  (.observedAt | fromdateiso8601) > 0' <<<"$deletion_receipt" >/dev/null; then
  printf 'Immediate Gmail deletion receipt must preserve the exact absence proof\n' >&2
  exit 1
fi

for required in \
  'immediate-gmail-send)' \
  'gmail_send_request()' \
  'observe_immediate_gmail_send()' \
  'provider_boundary=local-loopback-gmail-not-live-oauth'; do
  if ! grep -F -q -- "$required" "$control"; then
    printf 'Immediate Gmail verifier is missing invariant: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'inspectImmediateGmailVerificationState' \
  'integration:action:' \
  'osfo:immediate-gmail-send:approval:' \
  'osfo:immediate-gmail-send:terminal:'; do
  if ! grep -F -q -- "$required" "$observer"; then
    printf 'Agent runtime observer is missing Immediate Gmail evidence: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'gmailSendEmail' \
  'verification-gmailSendEmail' \
  'gmailResource: "primary"' \
  'kind: "tool-selection"' \
  '/_test/integrations/reset-ledger'; do
  if ! grep -F -q "$required" "$emulator"; then
    printf 'Provider emulator is missing Immediate Gmail evidence: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'Connect Gmail' \
  'Immediate Gmail Sends' \
  'Approve exact Gmail send' \
  'Gmail message sent' \
  'gmail-send-request' \
  'local Gmail provider boundary, not live Gmail OAuth'; do
  if ! grep -F -q "$required" "$feature"; then
    printf 'Immediate Gmail browser drive is missing a real User step: %s\n' "$required" >&2
    exit 1
  fi
done

if ! grep -F -q 'bash .agents/skills/verify-osfo/helpers/immediate-gmail-send.test.sh' \
  "$workspace_manifest"; then
  printf 'Workspace verification must run the Immediate Gmail verifier checks\n' >&2
  exit 1
fi

printf 'Immediate Gmail verifier checks passed\n'

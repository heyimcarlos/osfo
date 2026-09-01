#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/immediate-gmail-send.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
observer="$repo_root/apps/worker/test/support/agent-runtime-observer.ts"
observation_check="$repo_root/.agents/skills/verify-osfo/helpers/immediate-gmail-send-observation.jq"
deletion_check="$repo_root/.agents/skills/verify-osfo/helpers/immediate-gmail-send-deletion.jq"
finish_check="$repo_root/.agents/skills/verify-osfo/helpers/immediate-gmail-send-finish.jq"
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
    "authenticatedSessionCount": 1,
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
  '.durable.authenticatedSessionCount = 0' \
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
  "immediateGmailDeletionFeature":"account-deletion-replay",
  "immediateGmailDeletionQualification":{
    "commit":"commit-1",
    "guarantee":"every Immediate Gmail owned key erased while unrelated Agent storage survives",
    "result":"PASS",
    "test":"deletes every immediate Gmail owned key without touching unrelated Agent storage"
  },
  "immediateGmailPresentationId":"presentation-1",
  "immediateGmailProviderConnectionDeletion":{
    "connectionBinding":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "deleteOperationCount":1,
    "directProviderAbsence":true,
    "revokeOperationCount":1,
    "status":"deleted",
    "unrelatedConnectionAfter":{
      "connectedAccountId":"unrelated-connection-1",
      "status":"ACTIVE",
      "userId":"unrelated-user-1"
    },
    "unrelatedConnectionBefore":{
      "connectedAccountId":"unrelated-connection-1",
      "status":"ACTIVE",
      "userId":"unrelated-user-1"
    }
  },
  "immediateGmailProofExpected":true,
  "userExists":false
}'
if ! jq --exit-status --arg commit commit-1 --from-file "$deletion_check" \
  <<<"$deletion_fixture" >/dev/null; then
  printf 'Exact Immediate Gmail deletion fixture must pass\n' >&2
  exit 1
fi
for mutation in \
  '.immediateGmailActionId = ""' \
  '.immediateGmailPresentationId = ""' \
  '.immediateGmailDeletionFeature = "account-deletion"' \
  '.immediateGmailDeletionQualification = null' \
  '.immediateGmailDeletionQualification.commit = "different-commit"' \
  '.immediateGmailProviderConnectionDeletion.status = "not-qualified"' \
  '.immediateGmailProviderConnectionDeletion.revokeOperationCount = 0' \
  '.immediateGmailProviderConnectionDeletion.deleteOperationCount = 2' \
  '.immediateGmailProviderConnectionDeletion.directProviderAbsence = false' \
  '.immediateGmailProviderConnectionDeletion.unrelatedConnectionAfter.status = "REVOKED"' \
  '.immediateGmailProviderConnectionDeletion.unrelatedConnectionAfter.userId = "changed-user"' \
  '.immediateGmailProviderConnectionDeletion.unrelatedConnectionBefore.connectedAccountId = "changed-connection"' \
  '.agentRuntime.inspectable = true' \
  '.agentRuntime.registered = true' \
  '.userExists = true'; do
  if jq "$mutation" <<<"$deletion_fixture" \
    | jq --exit-status --arg commit commit-1 --from-file "$deletion_check" >/dev/null; then
    printf 'Immediate Gmail deletion mutation unexpectedly passed: %s\n' "$mutation" >&2
    exit 1
  fi
done

if grep -E -q 'listActionPresentations|inspectImmediateGmailSends|authSession(Id|ExpiresAt)' \
  "$observer"; then
  printf 'Immediate Gmail observer must not mint authority or invoke presentation-producing RPCs\n' >&2
  exit 1
fi

deletion_receipt="$(jq '{
  actionId: .immediateGmailActionId,
  deletionFeature: .immediateGmailDeletionFeature,
  directoryAgent: .agentRuntime,
  ownedKeyDeletionQualification: .immediateGmailDeletionQualification,
  observedAt: "2026-09-01T00:00:00Z",
  presentationId: .immediateGmailPresentationId,
  providerConnectionDeletion: .immediateGmailProviderConnectionDeletion,
  userExists: .userExists
}' <<<"$deletion_fixture")"
if ! jq --exit-status '
  .actionId == "verification-gmailSendEmail::cf-wai-tool-call::turn-1" and
  .presentationId == "presentation-1" and .deletionFeature == "account-deletion-replay" and
  .directoryAgent == {inspectable:false,registered:false} and .userExists == false and
  .providerConnectionDeletion == {
    connectionBinding:("a" * 64),
    deleteOperationCount:1,
    directProviderAbsence:true,
    revokeOperationCount:1,
    status:"deleted",
    unrelatedConnectionAfter:{
      connectedAccountId:"unrelated-connection-1",
      status:"ACTIVE",
      userId:"unrelated-user-1"
    },
    unrelatedConnectionBefore:{
      connectedAccountId:"unrelated-connection-1",
      status:"ACTIVE",
      userId:"unrelated-user-1"
    }
  } and
  .ownedKeyDeletionQualification.result == "PASS" and
  (.observedAt | fromdateiso8601) > 0' <<<"$deletion_receipt" >/dev/null; then
  printf 'Immediate Gmail deletion receipt must preserve the exact absence proof\n' >&2
  exit 1
fi

finish_outcome="$(jq --exit-status \
  --arg actionId 'verification-gmailSendEmail::cf-wai-tool-call::turn-1' \
  --arg connectionBinding 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  --arg presentationId presentation-1 \
  --arg commit commit-1 \
  --from-file "$finish_check" <<<"$deletion_receipt")"
if ! jq --exit-status '. == {commit:"commit-1",result:"PASS"}' \
  <<<"$finish_outcome" >/dev/null; then
  printf 'Complete provider deletion must produce the exact PASS outcome\n' >&2
  exit 1
fi
for mutation in \
  '.providerConnectionDeletion = null' \
  '.providerConnectionDeletion.status = "not-qualified"' \
  '.providerConnectionDeletion.revokeOperationCount = 0' \
  '.providerConnectionDeletion.deleteOperationCount = 2' \
  '.providerConnectionDeletion.directProviderAbsence = false' \
  '.providerConnectionDeletion.unrelatedConnectionAfter.status = "REVOKED"' \
  '.providerConnectionDeletion.unrelatedConnectionAfter.userId = "changed-user"' \
  '.providerConnectionDeletion.unrelatedConnectionBefore.connectedAccountId = "changed-connection"' \
  '.providerConnectionDeletion.connectionBinding = ("b" * 64)' \
  '.directoryAgent.inspectable = true' \
  '.ownedKeyDeletionQualification.commit = "different-commit"'; do
  if jq "$mutation" <<<"$deletion_receipt" \
    | jq --exit-status \
      --arg actionId 'verification-gmailSendEmail::cf-wai-tool-call::turn-1' \
      --arg connectionBinding 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
      --arg presentationId presentation-1 \
      --arg commit commit-1 \
      --from-file "$finish_check" >/dev/null 2>&1; then
    printf 'Immediate Gmail finish mutation unexpectedly produced PASS: %s\n' "$mutation" >&2
    exit 1
  fi
done

for required in \
  'immediate-gmail-send)' \
  'gmail_send_request()' \
  'observe_immediate_gmail_send()' \
  'account-deletion-integration-authority-operations-before.json' \
  'authorityOperationsAfter ==' \
  'unrelatedConnectionBefore.status == "ACTIVE"' \
  'provider_boundary=local-loopback-gmail-not-live-oauth'; do
  if ! grep -F -q -- "$required" "$control"; then
    printf 'Immediate Gmail verifier is missing invariant: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'inspectImmediateGmailApprovalVerificationState' \
  'inspectImmediateGmailResultVerificationState' \
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
  '/_test/integrations/authority-operations' \
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

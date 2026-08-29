#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/document-build.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
emulator_test="$repo_root/apps/worker/src/integrations/cloudflare/research-verification-provider.node.test.ts"
agent_runtime_test="$repo_root/apps/worker/src/agents/osfo/document-build-agent.runtime.test.ts"
free_denial_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-free-denial"
free_state_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-free-state"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

for required in \
  'document-build-free-denial)' \
  'document-build)' \
  'document_build_free_denial()' \
  'observe_document_build_free_denial()' \
  'document-build-free-denial-attempted' \
  'provider_browser_boundary=telegram-delivery-ledger' \
  "a.source_type = 'documentBuild' and a.allowance_kind = 'workflowStarts'" \
  "a.source_type = 'documentBuild' and a.allowance_kind = 'generatedDocuments'" \
  'assert-document-build-free-state' \
  '.actionId != $freeActionId' \
  'observe_document_build()' \
  '.artifactContentId == ("document:workflow:" + .workflowId)' \
  '.selectedTool == "startDocumentBuild"' \
  '.selectedTool == "inspectDocumentBuild"' \
  '.acceptedRunInviteCount == 1' \
  '.activeRunLinkCount == 1'; do
  if ! grep -F -q "$required" "$control"; then
    printf 'Document Build verifier is missing invariant: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  '.documentBuildCount == 0' \
  '.workflowStartUsage == 0' \
  '.generatedDocumentUsage == 0' \
  '.providerCostUsage == 0' \
  '.agentRuntime.documentBuildMain == null' \
  '.agentRuntime.documentBuildTimer == null'; do
  if ! grep -F -q "$required" "$free_state_assertion"; then
    printf 'Free Document Build state assertion is missing invariant: %s\n' "$required" >&2
    exit 1
  fi
done

jq --null-input '{
  userId: "verification-user",
  billingPlan: "free",
  billingPolicy: "launch-v1",
  allowancePlan: "free",
  allowancePolicy: "launch-v1",
  documentBuildCount: 0,
  actionDocumentBuildCount: 0,
  workflowStartUsage: 0,
  generatedDocumentUsage: 0,
  providerCostUsage: 0,
  documentUsageEvents: 0,
  documentNotificationCount: 0,
  sourceExists: true,
  artifactExists: false,
  attemptExists: false,
  ownerExists: false,
  agentRuntime: {
    inspectable: true,
    registered: true,
    documentBuildSource: {
      _tag: "Found",
      fileId: "web:00000000-0000-4000-8000-000000000289",
      userId: "verification-user"
    },
    documentBuildMain: null,
    documentBuildTimer: null,
    documentContent: null,
    documentAttempt: null,
    documentOwner: null
  }
}' >"$fixture_dir/free-state.json"
"$free_state_assertion" "$fixture_dir/free-state.json" \
  'verification-user' 'web:00000000-0000-4000-8000-000000000289'
if jq '.agentRuntime.documentBuildMain = { status: "unknown" }' \
  "$fixture_dir/free-state.json" >"$fixture_dir/unknown-main.json" && \
  "$free_state_assertion" "$fixture_dir/unknown-main.json" \
    'verification-user' 'web:00000000-0000-4000-8000-000000000289' 2>/dev/null; then
  printf 'An existing Free Document Build Workflow candidate falsely qualified as absent\n' >&2
  exit 1
fi
if jq '.agentRuntime.documentBuildTimer = { status: "unknown" }' \
  "$fixture_dir/free-state.json" >"$fixture_dir/unknown-timer.json" && \
  "$free_state_assertion" "$fixture_dir/unknown-timer.json" \
    'verification-user' 'web:00000000-0000-4000-8000-000000000289' 2>/dev/null; then
  printf 'An existing Free Document Build timer candidate falsely qualified as absent\n' >&2
  exit 1
fi

for required in \
  "publishes loadSkill for the verifier's natural Document Build request" \
  'Build a PDF from uploaded File ID' \
  'expect(turn.activeTools).toEqual(["loadSkill"])'; do
  if ! grep -F -q "$required" "$agent_runtime_test"; then
    printf 'Agent runtime is missing Document Build publication regression: %s\n' "$required" >&2
    exit 1
  fi
done

printf '%s\n' 'Committed Osfo result: Build a PDF from uploaded File ID web:00000000-0000-4000-8000-000000000289.' \
  >"$fixture_dir/echo.txt"
printf '%s\n' 'Document Build is not available on your current plan.' >"$fixture_dir/denial.txt"
jq --null-input '[
  {
    kind: "tool-selection",
    operationId: "verification-loadSkill",
    selectedTool: "loadSkill",
    subject: "document-build@system-document-build-v1"
  },
  {
    kind: "tool-selection",
    operationId: "verification-startDocumentBuild-free-verify-289",
    selectedTool: "startDocumentBuild",
    subject: "web:00000000-0000-4000-8000-000000000289"
  }
]' >"$fixture_dir/provider.json"

if "$free_denial_assertion" "$fixture_dir/echo.txt" "$fixture_dir/provider.json" \
  'verification-startDocumentBuild-free-verify-289' \
  'web:00000000-0000-4000-8000-000000000289' 2>/dev/null; then
  printf 'Generic model echo falsely qualified as a safe Free denial\n' >&2
  exit 1
fi
"$free_denial_assertion" "$fixture_dir/denial.txt" "$fixture_dir/provider.json" \
  'verification-startDocumentBuild-free-verify-289' \
  'web:00000000-0000-4000-8000-000000000289'
if jq 'map(select(.selectedTool != "startDocumentBuild"))' "$fixture_dir/provider.json" \
  >"$fixture_dir/unconsumed.json" && \
  "$free_denial_assertion" "$fixture_dir/denial.txt" "$fixture_dir/unconsumed.json" \
    'verification-startDocumentBuild-free-verify-289' \
    'web:00000000-0000-4000-8000-000000000289' 2>/dev/null; then
  printf 'An unconsumed Free Document Build action falsely qualified as a denial\n' >&2
  exit 1
fi
if jq 'reverse' "$fixture_dir/provider.json" >"$fixture_dir/reversed.json" && \
  "$free_denial_assertion" "$fixture_dir/denial.txt" "$fixture_dir/reversed.json" \
    'verification-startDocumentBuild-free-verify-289' \
    'web:00000000-0000-4000-8000-000000000289' 2>/dev/null; then
  printf 'A reversed Document Build tool sequence falsely qualified as a denial\n' >&2
  exit 1
fi
if jq '.[0:1] + [{
    kind: "tool-selection",
    operationId: null,
    selectedTool: "inspectDocumentBuild",
    subject: "document-build:unexpected"
  }] + .[1:]' "$fixture_dir/provider.json" >"$fixture_dir/intervening.json" && \
  "$free_denial_assertion" "$fixture_dir/denial.txt" "$fixture_dir/intervening.json" \
    'verification-startDocumentBuild-free-verify-289' \
    'web:00000000-0000-4000-8000-000000000289' 2>/dev/null; then
  printf 'An intervening Document Build tool selection falsely qualified as a denial\n' >&2
  exit 1
fi

for required in \
  'loads Document Build before selecting and safely presenting its denied action' \
  'const request = `Build a PDF from uploaded File ID ${fileId}.`' \
  'verification-startDocumentBuild-free-verify-289' \
  'verification-startDocumentBuild"'; do
  if ! grep -F -q "$required" "$emulator_test"; then
    printf 'Provider emulator is missing Document Build action regression: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'startDocumentBuild' \
  'inspectDocumentBuild' \
  '/_test/research/next-document-build-action' \
  'kind: "tool-selection"'; do
  if ! grep -F -q "$required" "$emulator"; then
    printf 'Provider emulator is missing explicit Document Build evidence: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'pathname === "/inbox"' \
  'telegramLedger' \
  'verificationRunId'; do
  if ! grep -F -q "$required" "$emulator"; then
    printf 'Provider emulator is missing the run-owned Telegram inbox: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
  'launch-v1 Free' \
  'shared-usage-v1' \
  'document-build-free-denial' \
  'Free denial checkpoint' \
  'document-build-free-denial/result.png' \
  'run-owned local provider inbox' \
  'Adventurer Plan' \
  'Choose text file' \
  'Keep the original authenticated Agent dashboard tab mounted' \
  'second Chrome tab' \
  'Return to the original dashboard tab' \
  'telegram-reply' \
  'Download PDF' \
  'Do not seed a FileRecord'; do
  if ! grep -F -q "$required" "$feature"; then
    printf 'Document Build browser drive is missing a real User step: %s\n' "$required" >&2
    exit 1
  fi
done

printf 'Document Build verifier checks passed\n'

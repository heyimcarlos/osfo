#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/document-build.md"
account_deletion_feature="$repo_root/.agents/skills/verify-osfo/features/account-deletion.md"
feature_map="$repo_root/.agents/skills/verify-osfo/features/README.md"
skill="$repo_root/.agents/skills/verify-osfo/SKILL.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
emulator_test="$repo_root/apps/worker/src/integrations/cloudflare/research-verification-provider.node.test.ts"
agent_runtime_test="$repo_root/apps/worker/src/agents/osfo/document-build-agent.runtime.test.ts"
free_denial_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-free-denial"
free_state_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-free-state"
artifact_state_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-artifact-state"
deletion_state_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-deletion-state"
tab_sequence_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-tab-sequence"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

for required in \
  'document-build-free-denial)' \
  'document-build)' \
  'document_build_free_denial()' \
  'observe_document_build_free_denial()' \
  'document-build-free-denial-attempted' \
  'provider_browser_boundary=telegram-delivery-ledger' \
  'r2_object_sha256' \
  'artifactObjectSha256' \
  "a.source_type = 'documentBuild' and a.allowance_kind = 'workflowStarts'" \
  "a.source_type = 'documentBuild' and a.allowance_kind = 'generatedDocuments'" \
  'assert-document-build-free-state' \
  'assert-document-build-artifact-state' \
  'assert-document-build-deletion-state' \
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

if ! grep -F -q 'Use the same authenticated dashboard tab for registration and channel linking' \
  "$skill" || \
  ! grep -F -q 'temporary provider or billing tabs' "$skill" || \
  ! grep -F -q 'Complete registration and channel linking in the same authenticated dashboard tab' \
    "$feature_map" || \
  ! grep -F -q 'Preserve tabs the selected feature explicitly marks mounted' "$feature_map" || \
  ! grep -F -q 'close or leave tabs it marks temporary' "$feature_map"; then
  printf 'Shared browser guidance conflicts with the Document Build tab sequence\n' >&2
  exit 1
fi
if ! grep -F -q 'Each Workflow instance must be terminal' "$account_deletion_feature" || \
  ! grep -F -q '`complete` when it finished before deletion' "$account_deletion_feature" || \
  ! grep -F -q '`terminated` when deletion interrupted it' "$account_deletion_feature"; then
  printf 'Account deletion misstates terminal Document Build Workflow evidence\n' >&2
  exit 1
fi

"$tab_sequence_assertion" "$feature"
printf '%s\n' \
  'capture that ready File ID as `action.png`' \
  'Start `document-build` evidence there' \
  'require the same `Ready. File ID:` value to remain visible' \
  'Return to the original dashboard tab' \
  'close or leave the billing tab' \
  'After the Adventurer paid state is visible' \
  'complete the browser-owned Adventurer upgrade' \
  'Open a second Chrome tab in the same Chrome session' \
  'Keep the original authenticated Agent dashboard tab mounted' \
  'Choose text file' >"$fixture_dir/reversed-tab-sequence.md"
if "$tab_sequence_assertion" "$fixture_dir/reversed-tab-sequence.md" 2>/dev/null; then
  printf 'A reversed Document Build browser tab sequence falsely qualified\n' >&2
  exit 1
fi
printf '%s\n' \
  'Choose text file' \
  'Keep the original authenticated Agent dashboard tab mounted' \
  'Open a second Chrome tab in the same Chrome session' \
  'After the Adventurer paid state is visible' \
  'close or leave the billing tab' \
  'Return to the original dashboard tab' \
  'require the same `Ready. File ID:` value to remain visible' \
  'Start `document-build` evidence there' \
  'capture that ready File ID as `action.png`' \
  'complete the browser-owned Adventurer upgrade' \
  >"$fixture_dir/late-adventurer-upgrade.md"
if "$tab_sequence_assertion" "$fixture_dir/late-adventurer-upgrade.md" 2>/dev/null; then
  printf 'A late Adventurer upgrade falsely qualified before the paid action screenshot\n' >&2
  exit 1
fi

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

jq --null-input '
  {
    userId: "verification-user",
    workflowId: "document-build:verification",
    artifactContentId: "document:workflow:document-build:verification",
    artifactObjectSha256: ("b" * 64),
    format: "pdf",
    sourceSha256: ("sha256:" + ("a" * 64)),
    sourceByteLength: "109",
    costEvidence: {
      providerOperationId: "document-build-provider-operation",
      usdMicros: "10"
    },
    agentRuntime: {
      documentContent: {
        size: 123,
        checksums: { md5: ("c" * 32), sha256: null },
        customMetadata: {
          osfo: ({
            userId: "verification-user",
            owner: { _tag: "Workflow", workflowId: "document-build:verification" },
            intentDigest: "document-build-intent",
            format: "pdf",
            retention: "accounted",
            artifact: {
              content: {
                contentId: "document:workflow:document-build:verification",
                byteLength: "123",
                sha256: ("b" * 64)
              },
              artifactRole: {
                _tag: "GeneratedDocumentV1",
                format: "pdf",
                pageCount: 1
              }
            },
            cost: {
              providerOperationId: "document-build-provider-operation",
              usdMicros: "10"
            }
          } | tojson)
        }
      },
      documentAttempt: {
        customMetadata: {
          osfo: ({
            userId: "verification-user",
            status: "completed",
            intentDigest: "document-build-intent",
            renderedPageCount: 1,
            cost: {
              providerOperationId: "document-build-provider-operation",
              usdMicros: "10"
            }
          } | tojson)
        }
      },
      documentOwner: {
        customMetadata: {
          osfo: ({
            userId: "verification-user",
            contentId: "document:workflow:document-build:verification"
          } | tojson)
        }
      },
      documentSourceObject: {
        size: 109,
        checksums: { sha256: ("a" * 64) },
        customMetadata: { "osfo-sha256": ("sha256:" + ("a" * 64)) }
      }
    }
  }
' >"$fixture_dir/artifact-state.json"
"$artifact_state_assertion" "$fixture_dir/artifact-state.json"
if jq '.artifactObjectSha256 = ("c" * 64)' \
  "$fixture_dir/artifact-state.json" >"$fixture_dir/mismatched-artifact-digest.json" && \
  "$artifact_state_assertion" "$fixture_dir/mismatched-artifact-digest.json" 2>/dev/null; then
  printf 'A generated artifact with mismatched stored bytes falsely qualified\n' >&2
  exit 1
fi
if jq '
    .agentRuntime.documentAttempt.customMetadata.osfo |=
      (fromjson | .status = "failed" | tojson)
  ' "$fixture_dir/artifact-state.json" >"$fixture_dir/failed-artifact-state.json" && \
  "$artifact_state_assertion" "$fixture_dir/failed-artifact-state.json" 2>/dev/null; then
  printf 'A failed Document Build attempt falsely qualified as successful artifact state\n' >&2
  exit 1
fi

jq --null-input '{
  documentProofExpected: true,
  documentSourceExists: false,
  documentArtifactExists: false,
  documentAttemptExists: false,
  documentOwnerExists: false,
  agentRuntime: {
    documentBuildSource: { _tag: "Unavailable" },
    documentBuildMain: { status: "complete" },
    documentBuildTimer: { status: "terminated" }
  }
}' >"$fixture_dir/deleted-document-build-state.json"
"$deletion_state_assertion" "$fixture_dir/deleted-document-build-state.json"
printf '%s\n' '{"documentProofExpected":false}' \
  >"$fixture_dir/no-document-build-state.json"
"$deletion_state_assertion" "$fixture_dir/no-document-build-state.json"
if jq '.agentRuntime.documentBuildMain.status = "running"' \
  "$fixture_dir/deleted-document-build-state.json" >"$fixture_dir/running-main-state.json" && \
  "$deletion_state_assertion" "$fixture_dir/running-main-state.json" 2>/dev/null; then
  printf 'A running Document Build host falsely qualified after account deletion\n' >&2
  exit 1
fi
if jq '.agentRuntime.documentBuildTimer.status = "running"' \
  "$fixture_dir/deleted-document-build-state.json" >"$fixture_dir/running-timer-state.json" && \
  "$deletion_state_assertion" "$fixture_dir/running-timer-state.json" 2>/dev/null; then
  printf 'A running Document Build timer falsely qualified after account deletion\n' >&2
  exit 1
fi
if jq '.documentArtifactExists = true' \
  "$fixture_dir/deleted-document-build-state.json" >"$fixture_dir/retained-artifact-state.json" && \
  "$deletion_state_assertion" "$fixture_dir/retained-artifact-state.json" 2>/dev/null; then
  printf 'A retained Document Build artifact falsely qualified after account deletion\n' >&2
  exit 1
fi
if jq '.agentRuntime.documentBuildMain.status = "terminated"' \
  "$fixture_dir/deleted-document-build-state.json" >"$fixture_dir/terminated-main-state.json"; then
  "$deletion_state_assertion" "$fixture_dir/terminated-main-state.json"
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
  'telegram-reply' \
  'Download PDF' \
  'Do not seed a FileRecord'; do
  if ! grep -F -q "$required" "$feature"; then
    printf 'Document Build browser drive is missing a real User step: %s\n' "$required" >&2
    exit 1
  fi
done

printf 'Document Build verifier checks passed\n'

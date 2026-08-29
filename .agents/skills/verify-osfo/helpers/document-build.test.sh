#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/document-build.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
emulator_test="$repo_root/apps/worker/src/integrations/cloudflare/research-verification-provider.node.test.ts"
free_denial_assertion="$repo_root/.agents/skills/verify-osfo/helpers/assert-document-build-free-denial"

for required in \
  'document-build-free-denial)' \
  'document-build)' \
  'document_build_free_denial()' \
  'observe_document_build_free_denial()' \
  'document-build-free-denial-attempted' \
  '.documentBuildCount == 0' \
  "a.source_type = 'documentBuild' and a.allowance_kind = 'workflowStarts'" \
  "a.source_type = 'documentBuild' and a.allowance_kind = 'generatedDocuments'" \
  '.workflowStartUsage == 0' \
  '.generatedDocumentUsage == 0' \
  '.providerCostUsage == 0' \
  '.documentBuildMain.status == "unknown"' \
  '.documentBuildTimer.status == "unknown"' \
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

fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT
printf '%s\n' 'Committed Osfo result: Build a PDF from supplied File ID web:00000000-0000-4000-8000-000000000289.' \
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

for required in \
  'loads Document Build before selecting and safely presenting its denied action' \
  'const request = `Build a PDF from supplied File ID ${fileId}.`' \
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
  'launch-v1 Free' \
  'shared-usage-v1' \
  'document-build-free-denial' \
  'Free denial checkpoint' \
  'document-build-free-denial/result.png' \
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

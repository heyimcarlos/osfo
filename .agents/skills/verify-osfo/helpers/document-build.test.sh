#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/document-build.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
emulator_test="$repo_root/apps/worker/src/integrations/cloudflare/research-verification-provider.node.test.ts"

for required in \
  'document-build-free-denial)' \
  'document-build)' \
  'document_build_free_denial()' \
  'observe_document_build_free_denial()' \
  'document-build-free-denial-attempted' \
  '.documentBuildCount == 0' \
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

for required in \
  'keeps the Free denial and Adventurer Document Build actions distinct' \
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
  'freeDenialActionIdFor' \
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

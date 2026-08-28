#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/document-build.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"

for required in \
  'document-build)' \
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
  'startDocumentBuild' \
  'inspectDocumentBuild' \
  'kind: "tool-selection"'; do
  if ! grep -F -q "$required" "$emulator"; then
    printf 'Provider emulator is missing explicit Document Build evidence: %s\n' "$required" >&2
    exit 1
  fi
done

for required in \
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

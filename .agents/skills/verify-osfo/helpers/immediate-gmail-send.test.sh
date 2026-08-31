#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
feature="$repo_root/.agents/skills/verify-osfo/features/immediate-gmail-send.md"
emulator="$repo_root/apps/worker/test/emulators/provider-emulator.ts"
workspace_manifest="$repo_root/package.json"

for required in \
  'immediate-gmail-send)' \
  'gmail_send_request()' \
  'observe_immediate_gmail_send()' \
  '.gmailSendUsage == 1' \
  '.gmailSendQuantity == "1"' \
  '.gmailSendBasis == "observed"' \
  'startswith($actionId + "::cf-wai-tool-call::")' \
  '.operationId == $actionId' \
  'provider_boundary=local-loopback-gmail-not-live-oauth'; do
  if ! grep -F -q -- "$required" "$control"; then
    printf 'Immediate Gmail verifier is missing invariant: %s\n' "$required" >&2
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

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"

if grep -E -q 'inspect-agent-storage|wrangler-state/v3/do|\.sqlite' "$control"; then
  printf 'account deletion verification must not inspect Wrangler SQLite storage directly\n' >&2
  exit 1
fi

if ! grep -F -q 'agent-runtime-observer.ts' "$control"; then
  printf 'account deletion verification must use the production Agent runtime observer\n' >&2
  exit 1
fi

printf 'agent runtime observer verifier checks passed\n'

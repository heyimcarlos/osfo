#!/usr/bin/env bash
set -euo pipefail
# The caller supplies an already-built document-sandbox image; this test never builds one.
image="$1"
repo_root="$(cd "$(dirname "$0")/../../../.." && pwd)"
workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT
bun "$repo_root/apps/worker/test/support/chat-pdf-form-fixture.ts" prepare "$workspace"
docker run --rm --network none --entrypoint python3 -i -v "$workspace:/workspace" "$image" - <<'PY'
import json
from pathlib import Path
from pdf_form import inspect, fill

workspace = Path('/workspace')
template = (workspace / 'template.pdf').read_bytes()
inspection = inspect(template)
fields = {field['name']: field for field in inspection['fields']}
print(json.dumps(inspection), flush=True)
for name in ('ApplicantName', 'DocumentDateLiteral', 'UnknownDate', 'ContactPermission', 'Service'):
    assert fields[name]['restriction'] is None, (name, fields[name])
assert fields['Service']['exportValues'] == ['New', 'Off', 'Renewal']
assert fields['ContactPermission']['exportValues'] == ['Agreed', 'Off']
for name in ('OfficeUseOnly', 'LockedReference', 'ApplicantSignature'):
    assert fields[name]['restriction'] == 'is protected', (name, fields[name])
edits = json.loads((workspace / 'fixture.json').read_text())['edits']
fill(template, {'pageCount': inspection['pageCount'], 'fields': edits}, workspace / 'filled.pdf')
try:
    fill(template, {'pageCount': 1, 'fields': [{'kind': 'text', 'name': 'OfficeUseOnly', 'value': 'Changed'}]}, workspace / 'forbidden.pdf')
except ValueError:
    pass
else:
    raise AssertionError('Office-only edit was accepted')
assert not (workspace / 'forbidden.pdf').exists()
PY
bun -e 'import { readFileSync } from "node:fs"; const { inspectDownload } = await import(process.argv[1]); await inspectDownload(readFileSync(process.argv[2]));' \
  "$repo_root/apps/worker/test/support/chat-pdf-form-fixture.ts" "$workspace/filled.pdf"

#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT
printf '%s\n' '{"name":"osfo-verification-binding-test","vars":{"OSFO_STAGE":"test","KEEP":"unchanged"}}' >"$scratch/config.json"
printf '%s\n' '{"BROWSER_HOST_ENDPOINT":"http://127.0.0.1:39270/inventory","BROWSER_HOST_OWNER_USER_ID":"registered-owner","BROWSER_HOST_SESSION_ID":"exact-extension","BROWSER_HOST_TOKEN":"synthetic-token-with-more-than-32-characters","BROWSER_HOST_ALLOWED_ORIGINS":"[\"http://127.0.0.1:39271\"]"}' >"$scratch/binding.json"
cp "$scratch/config.json" "$scratch/before.json"
if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/binding.json" wrong-owner >/dev/null 2>&1; then exit 1; fi
cmp "$scratch/config.json" "$scratch/before.json"
jq '.BROWSER_HOST_ENDPOINT="https://remote.invalid/browser"' "$scratch/binding.json" >"$scratch/remote.json"
if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/remote.json" registered-owner >/dev/null 2>&1; then exit 1; fi
cmp "$scratch/config.json" "$scratch/before.json"
bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/binding.json" registered-owner
jq --exit-status '.vars.KEEP == "unchanged" and .vars.BROWSER_HOST_OWNER_USER_ID == "registered-owner"' "$scratch/config.json" >/dev/null
if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/binding.json" registered-owner >/dev/null 2>&1; then exit 1; fi
printf 'Browser binding owner, loopback, single-use, and preservation checks passed\n'

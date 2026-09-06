#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT

# Derive the real run config without starting any processes or remote sessions.
bun "$script_dir/wrangler-config.mjs" \
  "$repo_root/apps/worker/wrangler.jsonc" "$scratch/config.json" \
  browser-binding-test postgres://osfo:osfo@127.0.0.1:5432/osfo_config_test \
  http://127.0.0.1:41001 http://127.0.0.1:41002 http://127.0.0.1:41003
jq --exit-status '.browser.binding == "BROWSER" and .browser.remote != true' "$scratch/config.json" >/dev/null
cp "$scratch/config.json" "$scratch/before.json"

for mode in local private-bindings.json ''; do
  if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$mode" >/dev/null 2>&1; then exit 1; fi
  cmp "$scratch/config.json" "$scratch/before.json"
done
for mutation in '.vars.OSFO_STAGE="production"' '.name="another-worker"' '.browser.binding="OTHER"' 'del(.browser)'; do
  jq "$mutation" "$scratch/before.json" >"$scratch/invalid.json"
  cp "$scratch/invalid.json" "$scratch/invalid-before.json"
  if bun "$script_dir/browser-binding.mjs" "$scratch/invalid.json" hosted >/dev/null 2>&1; then exit 1; fi
  cmp "$scratch/invalid.json" "$scratch/invalid-before.json"
done

bun "$script_dir/browser-binding.mjs" "$scratch/config.json" hosted
jq --exit-status '.browser == {binding: "BROWSER", remote: true}' "$scratch/config.json" >/dev/null
jq --sort-keys 'del(.browser.remote)' "$scratch/config.json" >"$scratch/after-normalized.json"
jq --sort-keys '.' "$scratch/before.json" >"$scratch/before-normalized.json"
cmp "$scratch/after-normalized.json" "$scratch/before-normalized.json"
[[ ! -e "$scratch/.dev.vars" ]]
cp "$scratch/config.json" "$scratch/enabled.json"
bun "$script_dir/browser-binding.mjs" "$scratch/config.json" hosted
cmp "$scratch/config.json" "$scratch/enabled.json"

# Existing run secrets are preserved byte for byte, without copying them into config.
printf 'UNCHANGED=synthetic-private-value\n' >"$scratch/.dev.vars"
cp "$scratch/.dev.vars" "$scratch/secrets-before"
bun "$script_dir/browser-binding.mjs" "$scratch/config.json" hosted
cmp "$scratch/.dev.vars" "$scratch/secrets-before"

# Exercise the actual command with process operations replaced. No account query is needed.
source <(sed -n '/^browser_bind() {$/,/^}$/p' "$script_dir/control-osfo")
doctor_run() { printf 'doctor\n' >>"$scratch/calls"; }
state_dir_for() { printf '%s\n' "$scratch"; }
docker() { printf 'Unexpected account query\n' >&2; return 1; }
state_value() { printf 'Unexpected account lookup\n' >&2; return 1; }
stop_process() { [[ "$1" == "$scratch" && "$2" == worker ]]; printf 'stop\n' >>"$scratch/calls"; }
start_worker_process() {
  [[ "$1" == fixture ]]
  jq --exit-status '.browser.remote == true' "$scratch/wrangler.json" >/dev/null
  printf 'start\n' >>"$scratch/calls"
}
cp "$scratch/before.json" "$scratch/wrangler.json"
if browser_bind fixture wrong-mode >/dev/null 2>&1; then exit 1; fi
[[ ! -e "$scratch/calls" ]]
browser_bind fixture hosted
[[ "$(stat -c '%a' "$scratch/wrangler.json")" == 600 ]]
printf 'doctor\nstop\nstart\ndoctor\n' >"$scratch/expected-calls"
cmp "$scratch/calls" "$scratch/expected-calls"
printf 'Hosted browser opt-in, canonical preservation, rejection, repeat, and Worker restart checks passed\n'

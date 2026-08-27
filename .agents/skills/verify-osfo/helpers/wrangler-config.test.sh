#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../../.." && pwd)"
scratch_dir="$(mktemp -d)"
output="$scratch_dir/wrangler.json"
postgres_url="postgres://osfo:osfo@127.0.0.1:5432/osfo_config_test"

cleanup() {
  rm -r "$scratch_dir"
}
trap cleanup EXIT

bun "$script_dir/wrangler-config.mjs" \
  "$repo_root/apps/worker/wrangler.jsonc" \
  "$output" \
  "wrangler-config-test" \
  "$postgres_url" \
  "http://127.0.0.1:41001" \
  "http://127.0.0.1:41002" \
  "http://127.0.0.1:41003"

jq --exit-status --arg postgres_url "$postgres_url" '
  .ai == null and
  .websearch == null and
  .secrets == null and
  .vars.OSFO_STAGE == "test" and
  (.hyperdrive | any(.binding == "DB" and .localConnectionString == $postgres_url)) and
  (.r2_buckets | all(.bucket_name | endswith("-wrangler-config-test")))
' "$output" >/dev/null

printf 'Wrangler verification config checks passed\n'

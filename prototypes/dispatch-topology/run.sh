#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
output_dir="$prototype_dir/evidence/$run_id"

mkdir -p "$output_dir"

docker compose -f "$prototype_dir/compose.yaml" down --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$prototype_dir/compose.yaml" up -d --wait

cleanup() {
  docker compose -f "$prototype_dir/compose.yaml" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

export PGHOST="127.0.0.1"
export PGPORT="55432"
export PGUSER="prototype"
export PGDATABASE="osfo_dispatch_prototype"

cargo run --release --manifest-path "$prototype_dir/Cargo.toml" -- \
  run \
  --output "$output_dir" \
  --container osfo-dispatch-prototype-postgres

echo "Evidence: $output_dir"

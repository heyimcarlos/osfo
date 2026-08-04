#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose --file "$prototype_dir/compose.yaml")

case "${1:-test}" in
  up)
    "${compose[@]}" up --detach --wait
    ;;
  down)
    "${compose[@]}" down
    ;;
  destroy)
    "${compose[@]}" down --volumes
    ;;
  test)
    "${compose[@]}" up --detach --wait
    OSFO_TEST_DATABASE_URL="${OSFO_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle}" \
      cargo test --manifest-path "$prototype_dir/Cargo.toml" -- --test-threads=1
    ;;
  evidence-local)
    "${compose[@]}" up --detach --wait
    run_id="$(date -u +%Y%m%dT%H%M%SZ)"
    evidence_root="$prototype_dir/evidence/$run_id"
    database_url="${OSFO_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle}"
    cargo build --release --manifest-path "$prototype_dir/Cargo.toml" \
      --bin evidence --bin focused_evidence --bin failure_evidence --bin merge_evidence
    for lane in open-arrival capacity-probes knee-probes; do
      OSFO_TEST_DATABASE_URL="$database_url" \
        OSFO_EVIDENCE_MANIFEST="$prototype_dir/config/evidence-$lane.json" \
        OSFO_EVIDENCE_DIR="$evidence_root-$lane" \
        "$prototype_dir/target/release/evidence"
    done
    OSFO_TEST_DATABASE_URL="$database_url" \
      OSFO_EVIDENCE_DIR="$evidence_root-focused" \
      "$prototype_dir/target/release/focused_evidence"
    OSFO_TEST_DATABASE_URL="$database_url" \
      OSFO_EVIDENCE_DIR="$evidence_root-failures" \
      "$prototype_dir/target/release/failure_evidence"
    "$prototype_dir/target/release/merge_evidence" "$evidence_root" \
      "$evidence_root-open-arrival" \
      "$evidence_root-capacity-probes" \
      "$evidence_root-knee-probes" \
      "$evidence_root-focused" \
      "$evidence_root-failures"
    echo "dashboard=$evidence_root/dashboard.html"
    ;;
  *)
    echo "usage: $0 [up|test|evidence-local|down|destroy]" >&2
    exit 2
    ;;
esac

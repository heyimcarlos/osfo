# OpenPoke scale evidence dashboards

This stack turns sealed B3 benchmark bundles into a reproducible Grafana
walkthrough. Grafana is a derived presentation view. The checksum manifest,
raw benchmark records, and PostgreSQL reconciliation remain authoritative.

## Data flow

```text
sealed run bundles
  -> checksum-verifying importer
  -> bounded Prometheus text metrics
  -> pinned Prometheus and Grafana OSS
  -> provisioned read-only dashboards
  -> fixed-range query responses and screenshots
  -> sealed presentation bundle
```

The importer module has one interface: a manifest containing explicit evidence
roots and bounded presentation metadata. It verifies every file listed by
`SEALED-SHA256SUMS` or `SHA256SUMS` before parsing any recognized artifact. It
never writes inside a source evidence root.

## One-command walkthrough

Pass three explicit sealed run directories in this order:

1. Best retained Montreal sustained run.
2. us-east4 current-WAL failure.
3. Invalid 4,096-reserve pilot.

```bash
./observability/run-presentation.sh \
  tmp/openpoke-presentation \
  /absolute/path/to/montreal-sustained-run \
  /absolute/path/to/us-east4-current-wal-failure \
  /absolute/path/to/reserve-4096-pilot
```

The command starts Grafana at `http://127.0.0.1:13000` and Prometheus at
`http://127.0.0.1:19090`, imports the bundles, locks the UTC range, saves loaded
dashboard definitions and query responses, captures 1920 × 1080 screenshots,
and seals the presentation bundle with `SEALED-SHA256SUMS`.

Ports can be changed with `OSFO_OPENPOKE_GRAFANA_PORT` and
`OSFO_OPENPOKE_PROMETHEUS_PORT`.

## Dashboard set

- **100k DAU Scorecard:** traffic arithmetic, root-outcome totals, user-visible
  gates, and current breaking point.
- **Capacity and PostgreSQL:** A/B/C/D matrix, receipt and admission latency,
  Cloud Run 429s, WAL, checkpoints, CPU, backends, and growth.
- **Durability and Recovery:** exact reconciliation, integrity counters, and
  explicitly missing recovery evidence.
- **Multi-device Streams:** the cursor contract and explicitly missing stream
  qualification evidence.
- **Topology Evolution:** retained and rejected delivery designs and the final
  fixed StreamingPull presentation topology.

All dashboards and the Prometheus data source are immutable provisioning files.
Grafana UI updates are disabled and anonymous access is viewer-only.

## Verification

```bash
bun run observability:test
bun run observability:typecheck
bun run observability:compose:check
```

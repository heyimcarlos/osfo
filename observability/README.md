# OpenPoke evidence cockpit

This stack presents the complete OpenPoke evidence catalog in Grafana. Grafana
is a derived view. Checksummed structured records remain authoritative, and
context from Markdown, GitHub, prototypes, or development snapshots retains its
original scope.

## Data flow

```text
catalog manifest
  -> artifact-index checksum and provenance verification
  -> structured adapters plus evidence.md coverage rows
  -> normalized catalog and machine-readable coverage report
  -> bounded Prometheus and OpenMetrics views
  -> eight provisioned read-only Grafana dashboards
  -> validated 1920x1080 captures and sealed presentation bundle
```

The manifest at `observability/evidence-catalog.manifest.json` inventories the
packet, all 13 packet runs, the final A/B/C/D summary, receipt derivation,
sanitized development snapshots, selected historical records, GitHub context,
and every remaining prototype evidence tree. Each source is imported,
represented, linked, or excluded with a reason.

The compiler fails closed on duplicate source, artifact, or normalized record
identities, checksum mismatches, unsafe paths, malformed boundaries, and
credential-shaped output. GitHub context is always external and contextual.
Prototype, local, and development records cannot become production
qualification. Missing facts do not emit numeric zero samples.

## One-command walkthrough

The default manifest is complete and requires no positional run roots:

```bash
./observability/run-presentation.sh tmp/openpoke-presentation
```

An alternate reviewed manifest can be supplied explicitly:

```bash
./observability/run-presentation.sh \
  tmp/openpoke-presentation \
  observability/evidence-catalog.manifest.json
```

The command compiles the catalog and coverage report, starts the pinned local
Prometheus and Grafana stack, verifies healthy targets and catalog metrics,
captures all eight dashboards at exactly 1920x1080, rejects loading, error,
No data, raw metric label, and above-fold UUID states, then seals the complete
bundle with `SEALED-SHA256SUMS`.

Ports can be changed with `OSFO_OPENPOKE_GRAFANA_PORT` and
`OSFO_OPENPOKE_PROMETHEUS_PORT`.

## Dashboard set

- **Executive Summary:** development demo status, production qualification,
  the selected admission result, and critical gaps.
- **Development Runtime:** HTTPS transport, immutable OpenRouter profile,
  durable receipt and outcome, cursor resume, cancellation disposition, and
  fixed topology.
- **Load and Admission:** exact traffic arithmetic, all packet runs, receipt
  repetitions, authoritative A/B/C/D cells, and the historical 464/s boundary.
- **PostgreSQL and Capacity:** WAL, checkpoints, CPU, backends, admission time,
  relation sizes, and fixed fleet geometry.
- **Durability and Recovery:** before and after claim loss, historical process
  loss, 4/6/8 fleet screens, duplicate safety, and missing full outage proof.
- **Multi-device and Streaming:** local three-tab, historical four-device,
  all bounded development SSE attempts, and missing target-load fault cuts.
- **ToolCalls and External Actions:** #67 and #68 current foundations,
  historical Mailpit control, provider smoke, and missing provider, integration,
  browser, load, and production ActionReceipt proof.
- **Evidence Catalog and Provenance:** filters, coverage, explicit exclusions,
  integrity provenance, and drill-down links.

Every dashboard defaults to development, keeps a useful first viewport, uses
human aliases, and moves raw provenance below the fold. PASS is green, FAIL is
red, MISSING is gray, and contextual or historical facts use neutral or muted
styling rather than qualification green.

## Verification

```bash
bun run demo:evidence:verify
bun run observability:test
bun run observability:typecheck
bun run observability:compose:check
bun run format:check
bun run lint
bun run typecheck
```

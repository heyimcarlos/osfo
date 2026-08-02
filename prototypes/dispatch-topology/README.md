# PROTOTYPE: PostgreSQL dispatch topology

This is throwaway evidence for the question:

> Can PostgreSQL remain both lifecycle authority and runnable-work queue across
> the 700 AgentRun/s human baseline, a preliminary 2,083 AgentRun/s proactive
> target, synchronized timer triggers, overload, managed-database latency
> proxies, and injected worker failure while preserving ordering, durability,
> fairness, fencing, bounded saturation, and recovery? Where does it break
> first?

It is not production Osfo code. It uses a disposable PostgreSQL container and
synthetic remote work. Database transactions and connections are released
before synthetic remote work begins.

The load driver uses open arrivals. It does not slow the offer rate when the
database falls behind. A 5,000-item caller queue and a 2-second admission
deadline make overload visible as dropped or timed-out work. Every accepted
receipt is checked separately for terminal durability.

## Run

Requirements: Docker, Rust, and Cargo.

```sh
./prototypes/dispatch-topology/run.sh
```

Each run creates a timestamped directory under `evidence/` containing:

- `run-config.json`: exact test inputs and thresholds;
- `environment.json`: host, container, and PostgreSQL facts;
- `samples.csv`: one-second measurements;
- `results.json`: machine-readable scenario results and verdicts;
- `REPORT.md`: reviewable narrative and evidence table;
- `dashboard.html`: self-contained presentation view.

To rebuild only the narrative report and dashboard from persisted JSON and CSV
without rerunning the load test:

```sh
cargo run --release -- render --evidence evidence/<timestamp>
```

The dashboard separates traffic, execution concurrency, backpressure, claim
latency, oldest pending age, and database CPU into panels with one unit per
axis. It labels the offer-window boundary so the load and recovery phases are
visible. Its presentation choices are documented in
[`dispatch-dashboard-observability-comparables.md`](../../docs/research/dispatch-dashboard-observability-comparables.md).

The Docker profile is intentionally explicit: PostgreSQL 17, 4 vCPU, 4 GiB
memory, and 100 connections. It is a reproducible local comparison point, not a
claim of equivalence to a particular managed Cloud SQL tier. A later GCP run
must record the selected instance class, storage, IOPS, network path, flags,
and maintenance settings beside these local facts.

Human-baseline stages hold a pooled connection for 0, 1, 3, 5, and 10 ms per
PostgreSQL stored-function operation. They are latency sensitivity tests, not
Cloud SQL benchmarks. They show how round-trip delay changes this topology
before any cloud account or bill is involved.

The preliminary proactive envelope assumes 20 human and 20 proactive
admissions per daily active user. This is an explicit hypothesis to replace
with beta telemetry. The timer comparison offers the same 5,000 triggers at
once and spread across 60 seconds.

This harness directly controls PostgreSQL claims, leases, worker death, and
stale completions. Goose is the preferred later driver for an HTTP admission
boundary and end-to-end user journeys. Drill is not used because an HTTP-only
benchmark cannot orchestrate the required database failure and fencing proof.

SSE contention is excluded. This prototype owns dispatch topology evidence.

The measured worker-concurrency and broker boundary is documented in
[`broker-dispatch-concurrency.md`](../../docs/research/broker-dispatch-concurrency.md).

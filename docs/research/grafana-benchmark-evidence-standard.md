# Grafana benchmark evidence standard

Research date: 2026-08-03.

## Decision

Grafana is the live operator and diagnosis view for issue 13. It is not the
durable source of truth and a screenshot is not acceptance evidence.

The durable confirmation must be a checksummed run bundle that contains the
workload manifest, exact UTC stage boundaries, raw benchmark records, database
reconciliation, raw histogram series, fixed-range query responses, active
observability configuration, versioned dashboard and rule definitions, service
histories, failure timelines, and machine-readable gate verdicts. Grafana then
renders those saved facts on a shared absolute timeline.

Use this evidence hierarchy:

```text
authoritative benchmark records and PostgreSQL reconciliation
  -> raw Prometheus and Cloud Monitoring series for a fixed UTC window
    -> exact, versioned query definitions and machine-readable gate results
      -> provisioned Grafana dashboards, annotations, and alert definitions
        -> offline HTML, PNG, CSV, and optional Grafana snapshots
```

An issue 13 `PASS` is valid only when every required workload and failure row
exists and every correctness gate is computed from authoritative records. A
green Grafana panel, snapshot, PDF, or screenshot cannot substitute for a
missing row or prove zero lost work.

This standard also applies the official Google SRE guidance summarized in
[`google-sre-load-confirmation-guidance.md`](./google-sre-load-confirmation-guidance.md).
Google's guidance supplies the reliability method. The rates, durations,
invariants, and PASS rules below are Osfo policy.

## Why Grafana alone is insufficient

Grafana panels query and transform data from other data sources. The panel
inspector can expose the raw returned data, the query request, panel JSON, data
JSON, query statistics, and CSV output. CSV exports may include transformations
and formatted values, so an export must say whether it is raw or transformed.
This makes Grafana useful for inspection, but the rendered panel remains a
derived view. See the [Grafana panel inspector documentation](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-inspector/).

Grafana dashboard JSON should be saved because it contains layout, variables,
styles, data sources, and queries. PNG output reflects browser size and zoom,
requires an image renderer, and cannot preserve query semantics. PDF export is
an Enterprise feature. See [Grafana dashboard sharing and export](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/).

Grafana snapshots remove queries and panel links, contain only the metric data
visible at creation time, may expire, and can expose that data to anyone who has
the link. Therefore use a local snapshot only as a convenience artifact, never
as the durable acceptance record. The durable bundle must remain usable without
a running Grafana instance.

## Confirmation unit

One evidence bundle represents one immutable benchmark run. Every run and every
stage needs a stable ID. The same `run_id` and bounded `stage` value must appear
in the load-generator records, annotations, exported queries, reports, and
failure timeline.

Do not put AgentRun IDs, Workflow IDs, request IDs, or arbitrary error text in
metric labels. Prometheus treats every unique label set as a new time series and
warns against high-cardinality labels. Put individual identifiers in structured
records, logs, traces, and Temporal histories, then link representative slow or
failed observations through exemplars. See [Prometheus instrumentation practices](https://prometheus.io/docs/practices/instrumentation/#do-not-overuse-labels)
and the [OpenTelemetry exemplar data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#exemplars).

Use bounded metric dimensions such as:

- `profile`: cold, restore, or per-step checkpoint
- `stage`: warmup, steady, burst, fanout, workflow_mix, approvals,
  timer_herd, retry_storm, failure, drain, or recovery
- `operation`: admission, claim, renew, reconstruct, model_commit,
  tool_commit, child_admit, child_join, workflow_start, workflow_outcome,
  wake, sandbox_create, sandbox_execute, artifact_export, smtp, or journey
- `outcome`: accepted, completed, failed, canceled, shed, duplicate, stale,
  timeout, rejected, caller_drop, or degraded
- `provider`, `region`, `dependency`, `failure_class`, and `worker_type`

## Service and SLI contract

The confirmation starts at the user-visible AgentRun journey, then uses
component metrics to explain the result. This follows Google's recommendation
to define users and critical activities first, measure the four golden signals,
and treat resource signals as diagnostic causes rather than proof of success.
See [Implementing SLOs](https://sre.google/workbook/implementing-slos/) and
[Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/).

The manifest and evidence must use these exact units:

| Unit | Meaning |
| --- | --- |
| Offered AgentRun | Client demand scheduled by the open-loop generator, including caller-side drops and work rejected before acceptance |
| Received AgentRun | Offered demand that reached the admission boundary |
| Accepted AgentRun | Authoritative pending AgentRun and durable admission receipt committed |
| Completed AgentRun | Accepted AgentRun that reached exactly one valid terminal state |
| Correct AgentRun | Completed AgentRun whose records, ordering, artifact, approvals, and terminal semantics satisfy every required invariant |
| Timely AgentRun | Correct AgentRun that meets a product-declared latency threshold |
| Shed AgentRun | Received work rejected before durable acceptance because declared capacity was unavailable |
| Reference journey | The complete parent, child, workflow, sandbox, artifact, approval, and ToolCall mix required by issue 13 |

The generator must record intended send time, actual send time, caller-side
drop, server receipt, acceptance, and terminal outcome. The required traffic
accounting is:

```text
offered = received + caller_drop
received = accepted + shed_or_rejected
accepted = completed + failed + canceled + still_in_flight
```

Report good events divided by eligible events for correctness, acceptance,
completion after drain, timeliness, degraded quality, and principal fairness.
Incorrect semantic output and a declared latency violation are errors even when
the protocol reports success. Keep successful and failed latency distributions
separate. Latency targets remain `MISSING` until the product declares them, so
observed baselines never become retroactive SLOs.

The full production-shaped deterministic lane must run at the inherited offered
rates of 700, 1,400, 2,083, and 4,167 AgentRuns per second. The manifest must
also freeze the journey and cost mix: children per parent, persistence profile,
approval timing, timer distribution, sandbox and artifact sizes, retry
distribution, and noisy versus quiet principals. A metadata-only component run
may locate a bottleneck, but it cannot satisfy the end-to-end confirmation.

## Frozen run identity and configuration

Save these values before traffic begins:

| Category | Required fields |
| --- | --- |
| Run | run ID, fixed seed, issue and matrix version, source commit and dirty-tree patch hash, operator, UTC start, planned UTC end |
| Workload | full manifest, target rates, durations, open-loop arrival process, intended event schedule, concurrency, queue bounds, worker counts, principal mix, journey and cost-class mix, child fan-out, approval and timer distributions, retry policy, failure schedule |
| Application | binary checksum, build profile, feature flags, environment names with values redacted where secret, schema and migration versions |
| Topology | region and zone, same-region assertion, network path, service placement, Temporal persistence isolation, Cloud SQL connection method |
| Cloud SQL | instance edition, PostgreSQL maintenance version, vCPU, memory, storage type and size, IOPS and throughput settings, availability mode, database flags, `max_connections` |
| Temporal | server, CLI, UI, Rust SDK, client, Core SDK, workflow type and workflow version, task queues, namespace, history shard count, worker slot and poller configuration |
| Dependencies | Grafana, Prometheus, postgres exporter, Cloud SQL Auth Proxy, Docker, sandbox image digest, Mailpit, artifact store, Rig, and every provider version or digest |
| Telemetry | scrape interval, scrape timeout, rule evaluation interval, OTel export interval and temporality, histogram boundaries, retention, active Prometheus flags and features |
| Cost | resource creation timestamps, deletion timestamps, price catalog identifiers, quantity and unit assumptions, and later actual billing export when available |

Save the intended files and the configuration that services actually loaded.
Prometheus exposes its loaded configuration, flags, runtime information, build
information, and enabled features through its status API. Preserve responses
from `/api/v1/status/config`, `/api/v1/status/flags`,
`/api/v1/status/runtimeinfo`, `/api/v1/status/buildinfo`, and
`/api/v1/features`. See the [Prometheus HTTP API status endpoints](https://prometheus.io/docs/prometheus/latest/querying/api/#status).

Provision Grafana dashboards and data sources from version-controlled files.
Set `allowUiUpdates: false` for evidence runs so an operator cannot silently
change an acceptance query in the UI. Grafana documents that UI changes to a
provisioned dashboard are not written back to the provisioning source and can
later be overwritten by that source. See [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/).

Sanitize data-source exports. Keep endpoints, data-source UIDs, query options,
and plugin versions, but never credentials, tokens, client certificates, or
private addresses that the public evidence must not expose.

## Collection resolution and stage duration

Prometheus defaults its scrape and rule evaluation intervals to one minute.
OpenTelemetry periodic metric export also defaults to 60 seconds. Those
defaults are too coarse for a short overload, timer-herd, or recovery stage.
See [Prometheus configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
and [OpenTelemetry periodic metric reader configuration](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#periodic-exporting-metricreader).

Use this issue 13 collection profile:

| Source | Evidence interval | Reason |
| --- | --- | --- |
| Load generator and authoritative lifecycle counters | Per event plus 1-second rollups | Exact totals and capacity curves cannot depend on scraping |
| Osfo app, queue, pool, process, sandbox, artifact, SMTP, and Temporal SDK metrics | 1-second scrape | Captures bursts, timer herds, retry storms, and recovery |
| Temporal server metrics | 1-second scrape | Aligns server, queue, persistence, and worker behavior |
| PostgreSQL exporter and direct PostgreSQL sampler | 1-second sample in a fresh transaction | Separates lock, I/O, client, and connection waits without stale transaction snapshots |
| Cloud SQL Auth Proxy and host or container metrics | 1-second scrape | Measures network, pool, CPU, memory, restart, and throttling behavior |
| Cloud Monitoring Cloud SQL metrics | Native 60-second samples | The service controls this interval |
| Recording rules | 1-second evaluation for run-local evidence | Keeps evaluation aligned with the evidence scrape interval |
| Grafana panels | Minimum interval fixed to 1 second | Prevents automatic downsampling from changing a run view |

The one-second profile is a test configuration, not a universal production
default. Record Prometheus CPU, memory, scrape duration, sample counts, missed
rule evaluations, and scrape failures to show that observation did not become
the bottleneck.

Cloud SQL metrics are generally sampled every 60 seconds and may remain
invisible for up to 165 seconds. A 10-second or 30-second stage can prove
application behavior, but it cannot support a Cloud SQL saturation claim. Each
capacity point used to identify the knee should contain at least ten complete
Cloud SQL samples. The target confirmation stage should hold its exact target
for at least 30 minutes. Begin collection at least three minutes before the
measured window and wait at least 165 seconds after it before exporting Cloud
Monitoring data. See the [Cloud SQL metrics reference](https://docs.cloud.google.com/sql/docs/postgres/admin-api/metrics).

These durations are an Osfo evidence policy derived from the documented Cloud
SQL sampling behavior. They are not Google product requirements. Failure cuts
and short bursts may be shorter, but their database-resource interpretation
must use direct PostgreSQL and one-second application telemetry.

## Four live dashboards

All panels use one locked absolute UTC range, one time zone, and shared stage
annotations. Do not mix unrelated units on one axis.

### 1. Acceptance and correctness

This is the top-level run scorecard. It answers whether the offered load was
handled correctly, not why performance changed.

Required panels and tables:

1. Run identity, topology, versions, source revision, target rates, stage,
   profile, fixed seed, UTC range, and telemetry completeness.
2. Intended sends, actual sends, caller-side drops, received, accepted, shed
   before acceptance, claimed, completed, failed, canceled, degraded, correct,
   timely, and still in flight, as totals and per-second rates.
3. Reconciliation equations:
   `offered = received + caller_drop`,
   `received = accepted + shed_or_rejected`, and
   `accepted = completed + failed + canceled + still_in_flight`.
4. Zero-loss and invariant counters, including duplicate authority records,
   stale commits accepted, mutable fragments, multiple terminal outcomes,
   duplicate wakes, terminal runs reclaimed, semantic-sequence mismatch,
   checkpoint-only recovery failures, sandbox-only artifact failures, and
   unauthorized Temporal writes.
5. Backlog count and oldest age for pending, retry-ready, running, and waiting
   AgentRuns, plus drain completion time.
6. Workload fidelity: intended versus actual send rate, arrival lag, caller
   drops, journey and cost-class mix, child fan-out, retry amplification, and
   principal mix compared with the immutable manifest.
7. Principal fairness: offered, accepted, shed, throughput, oldest age,
   degraded quality, and error rate for the noisy and quiet cohorts.
8. A table with one row for every required load stage, persistence profile,
   journey variant, and failure cut. Missing rows render `MISSING`, never pass.
9. A table with `PASS`, `FAIL`, or `MISSING` for every issue 13 exit criterion,
   with the exact query or reconciliation artifact and observed value.

Application and database records are authoritative for this dashboard.
Prometheus counters provide the aligned operational view, but their totals must
reconcile with the saved benchmark event stream and final PostgreSQL query.

### 2. Lifecycle latency, queueing, and capacity

This dashboard separates time spent working from time spent waiting. For every
applicable operation show p50, p90, p95, p99, observed maximum, sample count,
throughput, and error rate.

Required rows:

- admission and idempotency resolution
- claim, lease renewal, takeover, and stale-fence rejection
- cold reconstruction and checkpoint restoration
- ModelCall intent and outcome commit
- ToolCall intent, approval, attempt, retry backoff, and outcome commit
- child admission and ChildJoin settlement
- workflow start acceptance, Temporal start, reconciliation, terminal delivery,
  and Osfo wake
- Temporal workflow-task and Activity-task schedule-to-start and execution
- sandbox create, resume, execute, export, stop, and delete
- artifact upload, checksum verification, and ArtifactRef commit
- SMTP execution and ToolCall terminal commit
- total AgentRun and end-to-end journey

Plot these components separately:

```text
end-to-end elapsed
  = caller or admission queue
  + active Osfo service processing
  + database pool acquisition and transaction time
  + Temporal task-queue waiting and execution
  + dependency execution
  + intentional approval delay
  + intentional timer duration
  + retry backoff
  + drain or wake delay
```

Exclude intentional approval delay and configured timer duration only from the
named service-processing distribution. Preserve and show total elapsed journey
latency separately.

The capacity view must plot offered rate, accepted rate, completed rate, shed
rate, queue age, p50/p90/p95/p99 latency, observed maximum, and the first
saturated resource against each tested target. The knee is the first region
where completed throughput stops scaling proportionally while queue age,
shedding, tail latency, or a resource saturation signal grows. Save the
calculation and the complete points, not only a line drawn on a graph.

Run both gradual ramps and impulse arrivals, continue beyond the knee, then
remove the overload and measure recovery. A safe overload PASS requires early
shedding before durable acceptance and expensive dependency work, bounded queue
count and oldest age, bounded and jittered retries, visible retry amplification,
no collapse in useful completed throughput, exact accepted-work reconciliation,
and automatic return from shedding or degradation. Compare backlog, latency,
errors, and resource use with the pre-run steady band after drain. Google
recommends testing until failure and beyond because graceful rejection and
recovery cannot be inferred from a normal-load point. See
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/).

### 3. Cloud SQL and PostgreSQL

Align application traffic with these database families:

| Question | Required evidence |
| --- | --- |
| Database throughput | commit and rollback transaction rate, statement rate by lifecycle query family, rows inserted/updated/deleted/returned, application metadata commits |
| Connections | current and peak backends, backends by state and application, new-connection rate, pool used, pool idle, pool waiters, acquisition latency, configured maximum |
| Waits and locks | client backends grouped by `wait_event_type` and `wait_event`, lock-only waiters, ungranted `pg_locks`, lock-wait age, deadlocks |
| CPU and memory | utilization, reserved cores, total memory, memory excluding cache, components, swap, host or container CPU throttling |
| Storage and network | read/write operations and bytes, storage latency, utilization and quota, provisioned IOPS and throughput, temp bytes/files, sent/received bytes |
| Write pressure | WAL inserted, written, and flushed byte rate, WAL records and full-page images, `wal_buffers_full`, checkpoints and checkpoint write/sync time |
| Cache and I/O | PostgreSQL blocks read from disk versus buffer hits, `pg_stat_io` reads/writes/fsyncs and timing by backend/context/object |
| Query behavior | calls, rows, total and mean execution, p50/p95/p99 database latency, I/O time, lock time, and top normalized queries by lifecycle family |
| Maintenance | autovacuum activity, oldest transaction age, dead tuples, analyze/vacuum counts where relevant to a long soak |

Do not label total Cloud SQL `postgresql/backends_in_wait` as lock contention.
That metric includes Activity, BufferPin, Extension, IO, IPC, Lock, LWLock, and
Timeout waits. Group it by wait event type, filter to client backends, and show
`Lock` and `LWLock` explicitly. Use `pg_locks` for outstanding and ungranted lock
detail. See the [Cloud SQL metrics reference](https://docs.cloud.google.com/sql/docs/postgres/admin-api/metrics),
[PostgreSQL activity statistics](https://www.postgresql.org/docs/17/monitoring-stats.html),
and [PostgreSQL lock monitoring](https://www.postgresql.org/docs/17/monitoring-locks.html).

Capture before and after snapshots, plus the one-second samples, for
`pg_stat_database`, `pg_stat_wal`, `pg_stat_io`, `pg_stat_checkpointer`,
`pg_stat_activity`, `pg_locks`, and `pg_stat_statements`. Preserve every
`stats_reset` timestamp and calculate counter deltas. PostgreSQL cumulative
statistics can lag by about one second and are cached until the sampling
transaction ends by default. Use fresh autocommit transactions or clear the
statistics snapshot before every sample. I/O and WAL timing are meaningful only
when `track_io_timing` and `track_wal_io_timing` were enabled for the entire
interval. See [PostgreSQL 17 monitoring statistics](https://www.postgresql.org/docs/17/monitoring-stats.html)
and [`pg_stat_statements`](https://www.postgresql.org/docs/17/pgstatstatements.html).

Enable Cloud SQL Query Insights for the confirmation run and tag normalized SQL
by bounded lifecycle family: admission, claim, renew, reconstruct, transition,
child, join, workflow, wake, completion, and reconciliation. Save its active
configuration, aggregate and per-family metrics, and top normalized queries.
Enterprise edition retains Query Insights data for seven days, limits reported
query combinations, samples query plans, and stores normalized rather than
literal queries. Query Insights latency is database query latency, not Osfo
end-to-end latency. See [Cloud SQL Query Insights](https://docs.cloud.google.com/sql/docs/postgres/using-query-insights).

For every Cloud Monitoring export save the exact metric type, resource and
metric filters, group-by labels, per-series aligner, cross-series reducer,
alignment period, absolute start/end, and raw API response. Alignment reduces
points inside each alignment period and can change a chart's meaning. See
[Cloud Monitoring aggregation](https://docs.cloud.google.com/monitoring/api/v3/aggregation).

### 4. Temporal and dependencies

Temporal has three different evidence layers. Preserve all three:

1. Temporal service metrics explain frontend, matching, history, and Temporal
   persistence behavior.
2. Temporal Rust SDK metrics explain Osfo worker slots, polling, task waiting,
   execution, replay, cache behavior, and client RPCs.
3. Workflow histories prove the durable event sequence for selected and failed
   workflows.

Temporal's pre-production guide says SDK metrics, not only service or Cloud
metrics, should be accessible before load testing. It calls out task
schedule-to-start, workflow execution time, failures, downstream latency and
saturation, retry behavior, worker resource use, backlog growth, drain time,
and correctness under load. It also recommends recording each experiment's
start and stop times and examining recovery as closely as failure. See
[Temporal pre-production testing](https://docs.temporal.io/best-practices/pre-production-testing).

Required Temporal SDK families, with the documented `temporal_` prefix, include:

- `workflow_task_schedule_to_start_latency`
- `activity_schedule_to_start_latency`
- `workflow_task_execution_latency`
- `activity_execution_latency`
- `workflow_task_replay_latency`
- `workflow_endtoend_latency`
- `worker_task_slots_available` and `worker_task_slots_used`
- workflow and Activity poll success, empty poll, throughput, and failures
- workflow completed, failed, canceled, continued-as-new, and timed-out outcomes
- sticky-cache size, hits, misses, and forced evictions
- client request throughput, failures, and latency by operation

Temporal defines schedule-to-start as time from task scheduling into a Task
Queue until a Worker starts it. Worker slot gauges report used and available
execution capacity. See [Temporal worker performance](https://docs.temporal.io/develop/worker-performance)
and the [Temporal SDK metrics reference](https://docs.temporal.io/references/sdk-metrics).

Required Temporal service families include:

- `service_requests`, `service_errors`, and `service_latency` by service and
  operation
- resource-exhausted errors
- `persistence_requests`, `persistence_errors`, and `persistence_latency` by
  operation
- approximate backlog count and age, task add and dispatch rates, poll success,
  poll timeout, no-poller tasks, and pending polls by Osfo Task Queue and task
  type
- workflow success, failure, timeout, termination, and cancellation
- timer and Activity retry behavior
- service CPU, memory, restarts, goroutines, and Temporal persistence pool use

Poll `DescribeTaskQueue` once per second for the Osfo workflow and Activity Task
Queues and save approximate backlog count, backlog age, task add rate, task
dispatch rate, and poller or worker identity. These API snapshots complement
Prometheus and preserve the queue state the service reported during the run.
Temporal documents Task Queue backlog and rate fields as part of Worker
performance analysis. See [Temporal Task Queue metrics](https://docs.temporal.io/develop/worker-performance#task-queue-metrics).

Use the exact metric names emitted by the pinned server and SDK version. Temporal
publishes official SDK and server dashboard definitions, which are useful query
comparables but are described by Temporal as templates and starting points, not
complete production dashboards. Vendor and pin the reviewed definitions before
the run. See the
[Temporal dashboards repository](https://github.com/temporalio/dashboards),
[Temporal service metrics reference](https://docs.temporal.io/references/cluster-metrics),
[Temporal 1.29.1 metric definitions](https://github.com/temporalio/temporal/blob/v1.29.1/common/metrics/metric_defs.go),
and the [Temporal Core SDK dashboard](https://github.com/temporalio/dashboards/blob/master/sdk/temporal-core-sdks-otel.json).

Save complete workflow histories for every rare failure sample and a seeded
selection from each normal stage. Record history event count and bytes, workflow
and run IDs in the evidence index, task queue, workflow type and version,
retries, timers, updates, result, replay result, and intentional nondeterminism
result. IDs belong in the evidence index, not metric labels.

The same dashboard row should include Docker sandbox concurrency and duration,
artifact bytes and checksum failures, GCS operations and latency, SMTP attempts
and outcomes, Mailpit delivery assertions, dependency availability, process
restarts, network bytes, CPU, memory, and throttling. This lets the reviewer
distinguish PostgreSQL metadata time from dependency execution.

## Percentile and histogram policy

Do not save only p50, p90, p95, and p99 values. Save the underlying
distribution.

Prometheus summaries calculate quantiles in the instrumented process. Their
quantiles cannot be aggregated across workers or recalculated for a different
window. Histograms preserve bucket counts, sum, and count, so a reviewer can
aggregate workers and calculate different quantiles later. See [Prometheus
histograms and summaries](https://prometheus.io/docs/practices/histograms/).

For every latency family preserve:

- exact per-request values from the benchmark recorder when practical
- all classic histogram `_bucket`, `_count`, and `_sum` series, or every native
  histogram sample
- exact bucket boundaries and units
- counter reset and process restart markers
- operation, outcome, profile, and stage dimensions
- exact PromQL, query window, range step, and observation count
- p50, p90, p95, p99, observed maximum, and sample count computed from the
  per-request dataset
- the Grafana histogram estimate beside the exact benchmark percentile, with
  the difference reported

`histogram_quantile()` estimates the value by interpolating within a bucket.
For classic histograms apply `rate()` before aggregation so counter resets are
detected, then aggregate with the `le` label retained. Save the exact query. See
[`histogram_quantile()`](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile)
and [`rate()`](https://prometheus.io/docs/prometheus/latest/querying/functions/#rate).

Place classic histogram boundaries at and tightly around decision-relevant
latencies, with enough upper-tail coverage to avoid placing p99 in `+Inf`. A p99
inside a wide bucket is not precise evidence. Call the greatest observed sample
`observed maximum`, never p100.

Do not average, add, or re-percentile already-computed quantiles. Do not combine
one-minute percentile points into a stage percentile. Recompute the stage
percentile from exact events or aggregated histogram buckets across the stage.
For fewer than 100 observations, publish every sample and mark p99 unstable.
For a p99 acceptance claim, retain at least 10,000 exact observations per stage
and report a deterministic bootstrap confidence interval. The sample-count and
bootstrap rules are Osfo evidence policy, not Prometheus product requirements.

## Annotations and failure timelines

Create Grafana annotations for:

- run collection start and final scrape
- warm-up start and end
- every target-rate stage start and end
- every configuration, deployment, or worker-count change
- timer herd, approval batch, and retry storm start and end
- each injected failure, observed detection, recovery action, service recovery,
  backlog drain, and invariant verification
- run abort, telemetry gap, or observer failure

Each annotation needs `run_id`, `stage`, event type, UTC timestamp, component,
failure ID when applicable, and a short non-secret description. Save the
annotation request, response, and fixed-window annotation export because manual
annotations otherwise live in the Grafana database. See [Grafana annotations](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/annotate-visualizations/)
and the [Grafana annotations API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/annotations/).

The authoritative failure timeline is a separate structured file with the
durable cut point, injected mechanism, expected invariant, exact identifiers,
observed transitions, recovery, final state, and `PASS`, `FAIL`, or `MISSING`.
Grafana annotations point to those rows. They do not replace them.

## Queries and rules as evidence

Every panel and gate query must be reviewable as code. Save:

- Prometheus scrape configuration and recording-rule YAML
- Grafana dashboard JSON and provisioning YAML
- sanitized data-source provisioning
- Grafana alert provisioning and exported rule definitions
- Cloud Monitoring query definitions
- direct PostgreSQL sampler SQL
- final PostgreSQL reconciliation SQL
- unit tests for recording and alert rules
- `promtool check rules` and `promtool test rules` output

Prometheus recording rules evaluate expressions at a declared interval and
persist their results as time series. Prometheus provides syntax checking and
rule-unit testing through `promtool`. See [Prometheus recording rules](https://prometheus.io/docs/prometheus/latest/configuration/recording_rules/)
and [unit testing rules](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/).

Provision alerts for observer failure and invalid evidence, even though issue
13 does not yet have latency pass thresholds:

- scrape target down or missing samples
- scrape or rule evaluation missed
- exporter or collector dropped data
- counter reconciliation mismatch
- any correctness invariant violation
- accepted work remaining after drain deadline
- database connection exhaustion or pool waiters
- ungranted lock wait beyond the declared diagnostic threshold
- Temporal no-poller tasks, growing backlog age, resource exhaustion, or worker
  slots exhausted
- process restart or unexpected counter reset

Save alert definitions and state transitions. Grafana supports YAML and JSON
alert-resource provisioning and export. See [Grafana alert file provisioning](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/)
and [alert resource export](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/export-alerting-resources/).

## Durable run bundle

The runner should create this bundle automatically before infrastructure
teardown:

```text
evidence/<run-id>/
  MANIFEST.json
  README.md
  checksums.sha256
  verdict.json
  gates/
    issue-13-matrix.json
    correctness.json
    reconciliation-before.json
    reconciliation-after.json
  workload/
    manifest.json
    events.ndjson.zst
    latency-samples.parquet
    one-second-rollups.csv
    stage-boundaries.json
  prometheus/
    tsdb-snapshot.tar.zst
    query-manifest.json
    queries/<gate-or-panel>.json
    series-metadata.json
    targets.json
    loaded-config.json
    flags.json
    runtime-info.json
    build-info.json
    features.json
    recording-rules.yml
    alert-rules.yml
    rule-tests.yml
    promtool-check.txt
    promtool-test.txt
  grafana/
    dashboard.json
    dashboard-provisioning.yml
    datasources.sanitized.yml
    alerting.yml
    dashboard-api.json
    annotations.json
    dashboard.png
    panels/
  postgres/
    sampler.sql
    samples.ndjson.zst
    before.json
    after.json
    pg-stat-statements-before.csv
    pg-stat-statements-after.csv
    reconciliation.sql
  cloud-sql/
    instance.sanitized.json
    monitoring-query-manifest.json
    monitoring-series.json.zst
    query-insights-config.json
    query-insights-export.json.zst
    pricing.json
    teardown.json
  temporal/
    server-config.sanitized.json
    worker-config.json
    task-queue-snapshots.ndjson.zst
    histories/
    replay-results.json
    nondeterminism-negative-test.json
  dependencies/
    sandbox-results.json
    artifact-results.json
    smtp-results.json
    rig-conformance.json
  failures/
    matrix.json
    timeline.ndjson
  traces/
    exemplar-query.json
    selected-traces.json.zst
  dashboard.html
  REPORT.md
```

The Prometheus range-query manifest records, for every export: query name,
complete PromQL, source series, UTC start and end, step, range-vector window,
expected units, label grouping, returned sample count, warnings, and SHA-256.
Prometheus range queries accept explicit start, end, and step and return JSON.
See the [Prometheus range-query API](https://prometheus.io/docs/prometheus/latest/querying/api/#range-queries).

Take a Prometheus TSDB snapshot with the head included after the final scrape.
The Prometheus Admin API snapshot endpoint preserves current data when
`skip_head=false`. Store the compressed snapshot outside ephemeral Prometheus
storage and checksum it. The local TSDB otherwise defaults to 15 days of
retention and is not replicated. See the [Prometheus snapshot API](https://prometheus.io/docs/prometheus/latest/querying/api/#snapshot)
and [Prometheus storage](https://prometheus.io/docs/prometheus/latest/storage/).

If OpenTelemetry transports any metric, preserve its temporality, aggregation,
resource attributes, scope, export interval, and Collector configuration.
Cumulative and delta streams have different time semantics. Force-flush the
SDK and Collector at run end and record exporter retries, failures, and dropped
points. See the [OpenTelemetry metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#temporality)
and [metrics SDK](https://opentelemetry.io/docs/specs/otel/metrics/sdk/#periodic-exporting-metricreader).

## Telemetry completeness gate

No performance conclusion is valid unless all required sources were observable
for the full measured window. Save and evaluate:

- `up` for every Prometheus target
- scrape duration, samples scraped, samples after relabeling, sample-limit and
  body-size headroom, and scrape failure logs
- missed rule-group evaluations and rule evaluation errors
- Prometheus restarts and counter resets
- OTel Collector accepted, sent, retried, failed, and dropped data
- Cloud Monitoring first and last expected sample, ingestion delay, and missing
  periods
- load-generator clock offset and time synchronization state
- expected versus observed sample count for every required series

Prometheus can expose extra scrape metrics for timeout, sample-limit, and body
size headroom. See [Prometheus scrape configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#scrape_config).

Set the gate to `MISSING`, not `PASS`, if a required source is absent, a target
was down during the measured interval, an export contains warnings that affect
the result, or the raw data needed to recompute a claim was not retained.

## Cost evidence

Cost is a separate calculation, not a Grafana percentile. Save:

- exact resource shape and location
- creation, ready, traffic start/end, and deletion timestamps
- catalog SKU IDs, currency, unit prices, and retrieval timestamp
- machine, storage, network, artifact, logging, monitoring, and Temporal costs
- measured usage quantities where applicable
- the calculation formula and assumptions
- actual billing export after it becomes available

Label an immediate result `estimated cost`. Do not call it billed cost. Keep the
later billing record linked to the same run ID. Record any free-tier, minimum,
or rounding assumptions.

## Retention policy for issue 13

Prometheus retention is an operational setting, not an evidence policy. Adopt
this Osfo policy:

1. Keep the compact bundle, manifest, gate results, query definitions,
   dashboards, reports, checksums, and teardown proof for the lifetime of the
   architectural decision.
2. Keep exact workload events, database samples, Prometheus TSDB snapshot,
   Cloud Monitoring export, Query Insights export, Temporal histories, and
   selected traces until issue 13 is resolved and one later independent run has
   reproduced the accepted capacity conclusion.
3. After reproduction, archive rather than delete raw evidence. Record the
   archive URI, checksum, size, format, encryption, and retention date in the
   compact bundle.
4. Keep rare failure-path samples and histories indefinitely because unstable
   percentiles are not a substitute for those individual observations.
5. Never store credentials or secret environment values in any evidence tier.

This is a project policy recommendation, not a retention duration prescribed by
Grafana, Prometheus, Google Cloud, Temporal, PostgreSQL, or OpenTelemetry.

## Machine-readable acceptance rule

The final `verdict.json` should fail closed:

```json
{
  "run_id": "...",
  "verdict": "PASS | FAIL | MISSING",
  "correctness_gate": "PASS | FAIL | MISSING",
  "telemetry_gate": "PASS | FAIL | MISSING",
  "workload_fidelity_gate": "PASS | FAIL | MISSING",
  "safe_overload_gate": "PASS | FAIL | MISSING",
  "recovery_gate": "PASS | FAIL | MISSING",
  "topology_gate": "PASS | FAIL | MISSING",
  "load_matrix_gate": "PASS | FAIL | MISSING",
  "failure_matrix_gate": "PASS | FAIL | MISSING",
  "capacity_envelope": {
    "unit": "offered AgentRuns/s",
    "highest_confirmed": null,
    "knee_lower_bound": null,
    "knee_upper_bound": null
  },
  "missing_rows": [],
  "failed_invariants": [],
  "evidence_checksums": "checksums.sha256"
}
```

`PASS` requires all of the following:

1. The exact inherited target matrix ran without reducing target rates after a
   failure.
2. Same-region application compute and Cloud SQL were used, with Temporal
   persistence isolated from Osfo Cloud SQL.
3. Every issue 13 load stage, persistence profile, reference-journey variant,
   ToolCall path, and required failure cut has an evidence row.
4. The correctness and final PostgreSQL reconciliation gates pass.
5. Open-loop offered-load accounting and the frozen journey and cost mix pass
   the workload-fidelity gate.
6. Post-knee shedding, queues, retries, useful throughput, fairness, and
   accepted-work preservation pass the safe-overload gate.
7. The telemetry completeness gate passes.
8. Exact sample counts and distributions support every reported percentile.
9. Capacity points bracket the knee and a recovery stage returns backlog age,
   accepted-work reconciliation, latency, and resource use to the declared
   steady-state band.
10. Raw data, queries, dashboard definitions, histories, versions, costs, and
   teardown proof exist and match `checksums.sha256`.

## Implication for the current prototype

The current offline HTML and Grafana screenshot are useful diagnostic artifacts,
but they cannot confirm issue 13. The corrected run needs the raw query and TSDB
bundle, exact target matrix, Query Insights query-family tags, direct PostgreSQL
sampling, Cloud Monitoring exports after ingestion delay, Temporal SDK worker
metrics, stage annotations, complete failure matrix, telemetry completeness
gate, and fail-closed machine verdict defined here.

The present dashboard audit found these concrete gaps:

- no run, stage, injection, recovery, or configuration-change annotations
- cumulative offered, accepted, completed, and error counters presented without
  rate conversion
- one precomputed p99 gauge rather than aggregatable histogram buckets and exact
  per-request samples
- no shed, caller-drop, lost-accepted-work, duplicate-authority, stale-commit,
  duplicate-wake, or other correctness counters
- no Temporal Rust SDK or worker metrics
- Cloud SQL stages too short to support the native 60-second saturation series
- no durable Prometheus TSDB snapshot or fixed-window raw query exports

In particular, Temporal server metrics alone are insufficient. The Temporal
Rust SDK metrics exporter must be enabled explicitly so the run captures worker
slots, task schedule-to-start, task execution, replay, poll outcomes, cache, and
SDK failures. Verify those SDK series are present before starting measured
traffic. The Rust SDK telemetry configuration makes metrics export optional, so
an unset exporter disables this evidence. See the
[Temporal Rust SDK 0.5 telemetry source](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/common/src/telemetry.rs).

The current focused lane also constructs a new Temporal runtime and Worker for
each workflow sample. That does not represent a stable worker fleet and it
multiplies the SDK's poller and slot defaults by the number of concurrent
samples. The corrected benchmark must start one fixed, declared worker fleet,
export metrics for each worker instance, drive workflows through separate
clients, and keep that fleet unchanged across comparable stages. The pinned
Rust SDK source owns the evaluated worker defaults. See the
[Temporal Rust SDK 0.5 worker options](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk/src/lib.rs)
and [Core SDK tuner defaults](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk-core/src/worker/tuner.rs).

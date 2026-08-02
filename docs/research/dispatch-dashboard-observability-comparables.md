# Dispatch dashboard observability comparables

Research date: 2026-08-02.

## Decision

The dispatch evidence dashboard should separate three questions:

1. What load did the test offer, and what did the system accept?
2. Did durable work wait, execute, fail, or recover within the declared limits?
3. Which resource saturated at the observed breaking point?

Use a small load-stage scorecard, then separate time-series panels for traffic,
durable queue state, latency distributions, errors, and saturation. Do not put
backlog counts and latency on one unlabeled scale. Keep the failure scenario as
an execution timeline with linked evidence rather than reducing it to one
success badge.

This combines the strongest patterns from Restate, Temporal, and Google SRE:

- a high-level status view that links to individual stuck or failed work;
- separate logical execution history and physical resource metrics;
- queue depth, queue age, worker capacity, throughput, errors, and tail latency;
- percentiles and histogram distributions instead of averages alone;
- visible thresholds and experiment annotations;
- drill-down identifiers that connect summary metrics to one durable history.

## Restate

### Product UI

Restate's product UI is primarily a logical execution debugger, not its cluster
metrics dashboard. It shows an invocation's last successful action, retry count,
error, deployment, and cross-service call chain. Its list view can filter work
that has not made progress since a chosen time. The underlying query example is
effectively an age-of-stuck-work query over nonterminal invocations. See the
[Restate UI announcement](https://restate.dev/blog/announcing-restate-ui).

The newer UI presents a live execution timeline with retries, nested RPC calls,
events, promises, cancellation signals, and links between related invocations.
Restate explicitly describes this as the logical view of an invocation. It
keeps a separate physical trace view, joined by invocation ID. See the
[Restate 1.5 announcement](https://www.restate.dev/blog/announcing-restate-1-5)
and [Restate tracing documentation](https://docs.restate.dev/server/monitoring/tracing).

For long-running work, Restate emits a start span, one span for every attempt,
and an end span. Failed retryable attempts are marked as errors and spans are
published when they end, so an operator can inspect a run before the whole
invocation finishes. Journal commands and suspension or yield points become
events on the attempt span. The product UI remains the durable logical history.
This split is useful for Osfo: the failure proof should show the lifecycle and
claim epochs, while database and worker charts show the physical cause.

Restate also redesigned its high-scale landing page around invocation state and
shortcuts to stuck or in-flight invocations. This is an operational overview,
not a replacement for the per-invocation timeline. See the
[Restate 1.7 announcement](https://www.restate.dev/blog/announcing-restate-1-7).

### Prometheus and Grafana

Restate publishes separate Overview and Internals Grafana dashboards. The
Overview is explicitly for cluster health, resources, and throughput. The
Internals dashboard covers the log, invoker, partition processor, and RocksDB.
See the [official Restate metrics documentation](https://docs.restate.dev/server/monitoring/metrics).

The current dashboard definitions linked from that documentation use:

| Layer | Presentation | Representative panels |
| --- | --- | --- |
| Overview | stat, gauge, bar gauge, time series | nodes, leaders, blocked partitions, error rate, memory, storage, HTTP request rate, P99 HTTP latency, invoker tasks |
| Internals | stat and time series | task rate by status, task duration, invoker capacity, active connections and streams, connection utilization, blocked-on-stream count, command rate and P99 latency, log lag, snapshot age, write stalls |

The exact current panel set is an inspection of the Grafana definitions linked
by Restate's documentation. It is therefore a description of Restate's
published dashboard artifact, not a statement that every panel is a documented
service-level indicator. See the exact
[Overview dashboard JSON](https://github.com/restatedev/restate/blob/main/monitoring/grafana/restate-overview.json)
and
[Internals dashboard JSON](https://github.com/restatedev/restate/blob/main/monitoring/grafana/restate-internals.json).

Two Restate choices should not be copied. Its Kafka panel combines request rate
and consumer lag, which have different units. Some internal panels also label a
`quantile="1.0"` series as P100. Osfo should keep unlike units in separate
panels and call a sample's greatest observed value **observed maximum**, never
P100.

Restate's own metrics example overlays ingress throughput in operations per
second with ingress P99 latency. It also splits ingress counters by admitted,
completed, throttled, and other states. This is a useful model for comparing
offered AgentRuns per second, acknowledged admission, authoritative admission,
timeouts, and upstream drops without calling all of them generic QPS.

## Temporal

### Product UI

Temporal's product UI is also a logical execution-history view. Its Event
History timeline uses high-density rows, expands related scheduled, started,
and completed events together, filters by event type or only pending and failed
events, shows a pending Activity's current attempt and next retry, supports live
updates, and can pause the feed for investigation. See Temporal's
[Event History timeline announcement](https://temporal.io/changelog/updated-event-history-timeline-view-is-now-available).

Temporal now also exposes a fleet-oriented Worker view inside the product UI.
Worker heartbeats surface available task slots, CPU usage, configuration, and
the Workers assigned to a Workflow Task Queue. This is a current-state
inspection view rather than a replacement for time-series monitoring. See
[Temporal Worker performance](https://docs.temporal.io/develop/worker-performance#visualize-workers-in-the-ui).

That presentation suggests the following for the Osfo failure proof:

- group claim, lease expiry, takeover, stale completion, rejection, and final
  completion as one related lifecycle;
- show the epoch and attempt on each transition;
- highlight failed or stale transitions, while keeping successful recovery
  visible;
- retain exact timestamps and identifiers for review;
- make the sequence expandable instead of replacing it with prose.

### Prometheus and Grafana

Temporal publishes separate server, SDK, and Cloud Grafana dashboard JSON in
its [official dashboards repository](https://github.com/temporalio/dashboards).
The distinction matters: product Event History explains one workflow, while
Grafana explains fleet and queue behavior.

The current SDK dashboards use time-series panels for:

- RPC requests versus failures, failures per operation, request throughput,
  and P95 RPC latency;
- workflow completion, end-to-end latency, and failures by type;
- workflow task throughput, P95 schedule-to-start latency, failures, P95
  execution latency, P95 replay latency, and empty polls;
- activity throughput, failures, P95 execution latency, and P95
  schedule-to-start latency;
- worker slots available and used;
- sticky-cache size, hits, misses, and forced eviction.

See the
[Temporal Core SDK dashboard](https://github.com/temporalio/dashboards/blob/master/sdk/temporal-core-sdks-otel.json).
The server dashboard separately presents request rate and errors, latency by
service operation, persistence requests and errors, persistence P95 latency,
scheduled versus started versus completed Activities, resource use, restarts,
and workflow outcomes. See the
[Temporal server dashboard](https://github.com/temporalio/dashboards/blob/master/server/server-general.json).

The Cloud dashboard adds queue-specific time series: approximate backlog count
by task queue, sync-match rate, poll successes and timeouts, tasks with no
poller, resource-exhausted errors, workflow outcomes, schedule overruns, missed
catch-up windows, throttling, and replication lag. See the
[Temporal Cloud OpenMetrics dashboard](https://github.com/temporalio/dashboards/blob/master/cloud/temporal_cloud_openmetrics.json).

Temporal Server also defines both approximate backlog count and approximate
backlog age in seconds. Its task-queue statistics include task-add rate and
task-dispatch rate. See the
[Temporal Server metric definitions](https://github.com/temporalio/temporal/blob/main/common/metrics/metric_defs.go).

The direct comparison for Osfo is:

| Temporal concept | Osfo evidence metric |
| --- | --- |
| Approximate backlog count | durable Pending AgentRuns |
| Approximate backlog age | oldest pending age |
| Schedule-to-start latency | durable admission to successful claim latency |
| Slots available and used | worker concurrency limit, running workers, available capacity |
| Poll success and timeout | successful claims, empty polls, claim retries |
| Tasks with no poller | pending work with no active claimant, if observed |
| Resource exhausted | admission rejection, caller deadline, and bounded caller-queue drop, separately |
| Scheduled, started, completed | authoritative accepted, claimed, completed |

Temporal's published dashboards mostly select P95 for SDK and persistence
latency and P99 is not a universal default. The correct lesson is to name the
percentile and window, not to copy one percentile everywhere. For a capacity
artifact, show P50, P95, and P99 summaries and a bucketed latency distribution.

Temporal's Worker-health guide explicitly treats queue health as the
combination of schedule-to-start latency, sync-match rate, approximate backlog
count, poll success, and worker slots. It suggests plotting schedule-to-start
P95 and alerting on P99, and alerting when backlog grows over time for one Task
Queue. See [Monitor worker health](https://docs.temporal.io/cloud/worker-health).
Osfo has no sync-match equivalent because every claim comes from PostgreSQL,
but claim success versus empty polls is the closest efficiency signal.

Temporal's Cloud percentiles have an important presentation warning. P50, P95,
and P99 are calculated independently in one-minute windows. They cannot be
accurately recomputed into longer-window percentiles or aggregated across
dimensions. Tail percentiles generally need about 20 samples per window before
they are meaningful. See the
[OpenMetrics metrics reference](https://docs.temporal.io/cloud/metrics/openmetrics/metrics-reference).
Osfo should state the aggregation window and sample count for every percentile,
and should never imply that its cumulative stage P95 is a rolling P95.

## Google SRE

Google's four golden signals are latency, traffic, errors, and saturation.
Traffic must use a system-specific unit. Errors include explicit failures,
incorrect results, and policy failures such as exceeding a latency objective.
Saturation describes how full the constrained resource is, and systems often
degrade before reaching 100 percent. Google also recommends separating latency
for successful and failed requests. See
[Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/).

For tails, Google recommends bucketed latency counts suitable for histograms,
with roughly exponential bucket boundaries. It calls out one-minute P99 as a
possible early saturation signal. Its SLO chapter shows P50, P85, P95, and P99
time-series lines on a logarithmic latency axis and warns that averages hide
long tails. See
[Service Level Objectives](https://sre.google/sre-book/service-level-objectives/).

The strongest plot example for this prototype appears in Google's
troubleshooting chapter: latency P50, P95, and P99 are drawn as lines over a
heatmap that shows how many requests fell into each latency bucket at each
point in time. That lets the viewer see both the distribution and the summary
percentiles. The same case places traffic, latency, aggregate CPU, and instance
count in separate aligned charts. Google also recommends annotating charts
with deployment or configuration-change boundaries. See
[Effective Troubleshooting](https://sre.google/sre-book/effective-troubleshooting/).

Google's monitoring workbook says dashboards should support visual status,
diagnosis, capacity trends, and before-versus-after experiment comparison. It
recommends tracking active threads, queue waiting time, and other resources
without obvious hard limits in addition to CPU, RAM, and disk. It also warns
that a global error graph without a status or cause breakdown forces operators
to correlate logs manually. See the
[SRE Workbook monitoring chapter](https://sre.google/workbook/monitoring/).

## Concrete dashboard changes

### Header and vocabulary

- Call the offered-rate unit **offered AgentRuns per second**, never generic
  QPS.
- Expand round-trip time on first use: **simulated database round-trip delay
  (RTT proxy)**.
- Rename **Caller Q** to **admission requests waiting or in flight**.
- State the sample interval and whether each percentile is cumulative for the
  stage or calculated in a rolling interval.
- Define the healthy thresholds before presenting the results.

### Stage scorecard

Keep one comparison table, but group the columns visually:

1. **Traffic:** offered AgentRuns/s, offered total, in-window acknowledged/s,
   authoritative accepted.
2. **Errors:** rejected, caller timeouts, caller-side drops, ambiguous commits,
   lost accepted work.
3. **Queue and latency:** claim P50/P95/P99, peak pending, oldest pending age,
   drain time.
4. **Saturation:** peak admission waiting, running, connections, PostgreSQL CPU,
   lock waiters, and query latency.

Use full names in column headers or tooltips. A presentation artifact should
not require the audience to infer what a counter includes.

### Aligned time-series panels

For each stage, use one shared time axis and separate panels:

1. **Traffic and admission outcomes:** offered, acknowledged, authoritative,
   dropped, timed out, and rejected AgentRuns per second. Use lines for rates
   and a categorical outcome breakdown for totals.
2. **Durable queue:** Pending, Running, and Completed counts. Add oldest pending
   age as a separate small panel, not a second unit on the count axis.
3. **Claim latency:** P50, P95, and P99 in milliseconds, plus the 1 second
   threshold. If samples permit, use a heatmap of claim-latency buckets with the
   percentile lines overlaid. Otherwise label the existing line as cumulative
   stage P95 and keep the summary percentiles beside it.
4. **Admission latency:** P50, P95, and P99 from offer time to acknowledged or
   failed caller result. Separate successful and failed or timed-out requests.
5. **Worker capacity:** running AgentRuns, worker limit, available slots, claim
   throughput, and empty polls. The worker limit should be a visible constant
   line.
6. **PostgreSQL saturation:** CPU, pool connections used versus limit, lock
   waiters, query P95/P99, and transaction throughput. Use separate axes or
   panels for counts, percentages, and durations.

Annotate the beginning and end of the offer window, the worker death, lease
expiry, takeover, stale completion attempt, and completion. This makes the
causal sequence visible and follows Google's experiment and deployment
annotation pattern.

### Failure proof

Present the failure proof as a compact durable timeline:

```text
accepted -> claimed epoch 1 -> worker exits -> lease expires
         -> reconciliation -> claimed epoch 2
         -> stale epoch 1 completion rejected -> epoch 2 completes
```

Each event should expose timestamp, AgentRun ID, Thread ID, Principal, worker,
claim epoch, state before and after, and the database assertion or row count
that proves the transition. Add links from the stage's failure marker to this
timeline and from the timeline to the raw JSON evidence. This adopts the
logical-history pattern used by Restate and Temporal while preserving the
physical PostgreSQL measurements alongside it.

### Presentation hierarchy

The first screen should answer five questions without interaction:

- What was the offered AgentRun rate?
- How many were durably accepted, dropped, rejected, or ambiguous?
- Did Pending count and oldest pending age return to zero?
- Which declared threshold broke first?
- Was any accepted work lost or committed by a stale worker?

The second level should explain why through the aligned time series. The third
level should preserve the exact failure lifecycle and downloadable raw data.
This mirrors Restate and Temporal's separation between fleet metrics and one
execution's durable history.

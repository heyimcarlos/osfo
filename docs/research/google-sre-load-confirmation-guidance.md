# Google SRE guidance for load confirmation

Research date: 2026-08-03.

## Scope

This note applies the official Google *Site Reliability Engineering* book and
*The Site Reliability Workbook* to the production-shaped AgentRun lifecycle
prototype in [issue 13](https://github.com/heyimcarlos/osfo/issues/13). It uses
only first-party Google SRE material.

The document deliberately separates:

- **Google guidance**, which summarizes the cited books.
- **Proposed Osfo policy**, which is our concrete interpretation for issue 13.

Google does not prescribe Osfo's traffic targets, stage durations, lifecycle
invariants, or evidence bundle. Those remain Osfo decisions.

## Decision

Issue 13 should be treated as a controlled reliability confirmation, not as a
Grafana demo or a single throughput measurement. A valid run must answer four
questions:

1. At the declared production-shaped demand and journey mix, what fraction of
   offered AgentRuns become correct, timely outcomes?
2. Where does useful completed throughput stop scaling, and which resource or
   queue saturates first?
3. Beyond that point, does Osfo shed work before acceptance and preserve the
   work it accepted, or does useful throughput collapse?
4. After load or a dependency failure is removed, does the system recover and
   drain without manual repair, loss, duplication, or stale commits?

Grafana should make those answers visible on one timeline. The authoritative
PASS or FAIL result must still come from exact workload records, PostgreSQL
reconciliation, retained distributions, and the complete failure matrix.

## Google guidance

### Start from the user journey and good events

Google recommends first identifying the users, their common and critical
activities, the request and data flow, and the critical dependencies. It then
recommends a small set of specific, measurable SLIs that represent the most
important user experience. Request-driven availability, latency, and quality,
plus pipeline correctness, are example SLI types. Correctness can be measured
by injecting inputs with known outputs and checking the resulting records.
[Implementing SLOs](https://sre.google/workbook/implementing-slos/)

SLO targets are product and business decisions, not values an infrastructure
test should invent. An error budget expresses the allowed rate of bad events,
and 100 percent objectives are generally undesirable, but the chosen target
must reflect the product's actual requirement.
[Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)

### Monitor symptoms first, then causes

Google's four golden signals are latency, traffic, errors, and saturation.
Latency should distinguish successful and failed requests. Errors include
explicit failure, incorrect output, and responses that violate a stated latency
policy. Saturation describes how full the constrained resource is, and tail
latency can be an early signal of it.
[Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)

Google distinguishes black-box, user-visible symptoms from white-box causes.
Both are needed for diagnosis, but paging should primarily reflect an urgent,
actionable user symptom. Resource metrics explain a failure, but do not by
themselves establish that users succeeded or failed.
[Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)

### Do not confuse request rate with work

Google warns that queries per second can be a poor capacity measure because
different requests can have very different resource costs, and those costs can
change with client, time, data, configuration, or software version.
[Handling Overload](https://sre.google/sre-book/handling-overload/)

Production-like synthetic traffic must include the request mixes that expose
load-dependent bugs. The workbook explicitly notes that some failures appear
only under particular load levels or request mixes. Launch traffic can also
have a different mix from steady state and invalidate an otherwise plausible
load test.
[On-Call](https://sre.google/workbook/on-call/),
[Reliable Product Launches at Scale](https://sre.google/sre-book/reliable-product-launches/)

The managing-load case study also concludes that demand should be measured as
close to the client as possible. Otherwise, refusals before the usual server
instrumentation can make offered traffic invisible.
[Managing Load](https://sre.google/workbook/managing-load/)

### Test until failure, beyond failure, and through recovery

Google calls understanding heavy-load behavior one of the most important steps
in preventing cascading failure. It recommends increasing load until each
component breaks. At overload, a well-behaved component should reject or
degrade some work while maintaining useful throughput, rather than crash or
collapse its success rate.
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

The same chapter recommends both gradual ramps and impulse traffic because
cache behavior can produce different results. It also requires observing the
return to nominal load, including whether degraded mode exits automatically and
how far load must fall before the service stabilizes. Stateful tests should
track state across interactions and check correctness at high load, where
subtle concurrency defects often appear.
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

Individual components can have different breaking points, so component tests
are still useful, but they do not replace the system-level production-shaped
test. Google notes that synthetic traffic may miss real limits and recommends
carefully scoped real-traffic testing when appropriate.
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

### Bound queues and make overload safe

Queues consume memory and turn overload into waiting time. For steady traffic,
Google recommends small queues relative to the worker pool and early rejection
when the service cannot sustain the offered rate. Bursty systems should size
queues according to worker use, processing time, and the expected burst shape.
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

Load shedding should prevent resource exhaustion, health-check failure, and
extreme latency while preserving as much useful work as possible. Google
recommends failing early and cheaply when overloaded, ideally at a high-level
choke point before expensive backend work begins.
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

Retries can turn a small failure into a positive feedback loop. Google
recommends deadlines, bounded retry counts, and randomized exponential backoff.
The workload must test the behavior of important clients, including whether
they queue while the service is down and whether their retries synchronize.
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

Autoscaling, load balancing, and shedding can themselves form feedback loops.
Google recommends instrumenting their intersections, setting bounds and kill
switches, keeping spare capacity, and ensuring downstream dependencies can
absorb the load added by scaling.
[Managing Load](https://sre.google/workbook/managing-load/)

### Capacity is a curve with a safety margin

Google defines stress tests as a way to understand the limits of the system and
its components. Load tests reveal the breaking point, enable regression tests,
and support an explicit tradeoff between utilization and safety margin.
[Testing for Reliability](https://sre.google/sre-book/testing-reliability/),
[Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)

Capacity planning should correlate raw resources with service capacity and
include both organic growth and launch-driven demand. Google also warns that
the resource-to-capacity relationship should be remeasured rather than treated
as a permanent fact.
[Introduction](https://sre.google/sre-book/introduction/),
[A Collection of Best Practices for Production Services](https://sre.google/sre-book/service-best-practices/)

Load tests are required for most launches because overload behavior is nonlinear
and difficult to predict from first principles. A service can move from a
linear region into rising latency, wasted work, retry amplification, or total
lockup.
[Reliable Product Launches at Scale](https://sre.google/sre-book/reliable-product-launches/)

### Preserve distributions, not averages

Google cautions that averages conceal tail behavior. Percentiles reveal both
the typical case and plausible worst cases, while artificial bounds such as
zero and timeout deadlines make normal-distribution assumptions unsafe.
[Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)

The monitoring chapter recommends bucketed latency counts and appropriate
measurement resolution. Coarse CPU samples can miss short spikes that drive
tail latency. The workbook likewise recommends percentile-capable monitoring
and explicitly suggests retaining raw metrics separately for offline analysis.
[Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/),
[Monitoring](https://sre.google/workbook/monitoring/)

### Failure tests must be reproducible

Google notes that randomized failure and distributed-state tests are not proof
merely because they pass once. It recommends preserving the random action log
or seed, replaying the observed sequence, and running enough repeats to support
the inference being made. Testing reduces uncertainty, but a passing test does
not prove universal reliability.
[Testing for Reliability](https://sre.google/sre-book/testing-reliability/)

Production probes complement preproduction tests because the deployed frontend,
backend, configuration, and release versions may form a combination that the
release test never exercised. Known-good and known-bad probes therefore remain
useful after a test environment passes.
[Testing for Reliability](https://sre.google/sre-book/testing-reliability/)

### Alert on SLO consumption, not dashboard anxiety

The workbook defines an SLI as good events divided by total events and uses
error-budget burn rate to connect alerts to material SLO risk. Multiwindow,
multi-burn-rate alerts improve the balance between detection speed, precision,
and reset time.
[Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)

This guidance is for service operations. It does not mean issue 13 should
invent a production SLO or page an operator during a benchmark. It means the
confirmation should calculate good and bad event ratios in a form that can
later support an agreed SLO.

## Proposed Osfo policy

The following is an Osfo interpretation of the preceding guidance.

### Define the confirmation contract before the run

The immutable manifest must define these distinct units:

| Unit | Meaning |
| --- | --- |
| Offered AgentRun | Client demand presented to admission, including work shed before acceptance |
| Accepted AgentRun | Durable admission receipt and authoritative pending AgentRun committed |
| Completed AgentRun | Accepted AgentRun reaching exactly one valid terminal state |
| Reference journey | The complete parent, child, workflow, sandbox, artifact, approval, and ToolCall mix required by issue 13 |
| Dependency operation | Cloud SQL, Temporal, sandbox, artifact, and SMTP work generated by those journeys |

Report each rate separately. Never compare complete journeys per second with an
AgentRun admission target as though they were the same unit.

For each stage, declare the expected journey mix and cost dimensions, including
children per parent, workflow mode, persistence profile, approval timing,
sandbox and artifact size, retry distribution, and noisy versus quiet
principals. Preserve the generated event stream so the observed mix can be
compared with the manifest.

The issue 13 target matrix must pin the inherited offered rates of 700, 1,400,
2,083, and 4,167 AgentRuns per second. It must not lower those rates after a
failed probe. Separate admission-only tests may locate a component limit, but
only the required production-shaped deterministic path can satisfy issue 13.

### Use explicit issue 13 SLIs without inventing product SLOs

Issue 13 should calculate these experimental SLIs:

1. **Correctness:** correct terminal semantic outcomes divided by accepted
   AgentRuns, plus zero-tolerance invariant counters.
2. **Acceptance availability:** accepted AgentRuns divided by offered AgentRuns,
   with shed work identified separately from internal failure.
3. **Completion availability:** valid terminal outcomes divided by accepted
   AgentRuns after the declared drain deadline.
4. **Latency:** the proportion of successful and failed events below each
   declared threshold, alongside exact p50, p90, p95, p99, observed maximum,
   and sample count.
5. **Quality and fairness:** undegraded journeys and quiet-principal success
   divided by their respective totals during overload.

The inherited traffic targets and issue 13's zero-loss correctness rules are
acceptance requirements. Latency targets remain `MISSING` until product owners
declare them. Baseline percentiles are evidence, not retroactive SLOs.

Deliberately injected benchmark failures must not be mixed with a production
service error budget. Give each failure stage its own expected good and bad
event contract.

### Execute a fixed traffic-shape matrix

Run all required stages in the same-region production-shaped topology with a
fixed worker fleet and fixed dependency configuration:

1. Warm caches and connection pools, then prove a stable pre-run baseline.
2. Hold each required steady target.
3. Apply the 2x burst both as a gradual ramp and an impulse.
4. Run the declared mixed lifecycle and principal distribution at the target.
5. Run child fan-out, approval batch, timer herd, and retry storm stages.
6. Continue beyond the knee until useful throughput, shedding, and saturation
   behavior are unambiguous.
7. Remove the overload and measure recovery, backlog drain, invariant
   reconciliation, and return to the pre-run band.
8. Repeat the same matrix for all three persistence profiles without changing
   unrelated configuration.

Arrival scheduling must be open-loop. The generator records the intended send
time, actual send time, caller-side drop, server receipt, acceptance, and final
outcome. This prevents a saturated client or generator from silently reducing
the offered load.

### Define safe-overload gates

Overload is a PASS only if all of these hold:

- Offered demand remains visible even when rejected before the application.
- Shedding happens before durable acceptance and before expensive downstream
  work whenever capacity is unavailable.
- Completed useful throughput does not collapse after the knee.
- Queue count and oldest age are bounded by the declared policy.
- Retries remain bounded, jittered, and deadline-aware.
- Retry traffic and total dependency attempts are visible as amplification
  ratios.
- Accepted work reconciles exactly and drains after load returns to normal.
- Quiet principals retain the declared fair share during noisy-principal load.
- The system exits shedding or degraded mode without manual database repair.

The first rejected request is not necessarily the capacity knee. The knee is a
region supported by the offered, accepted, completed, shed, queue-age, latency,
and saturation curves. The evidence must also identify the first constrained
resource and the post-knee behavior.

### Make failure stages scientific experiments

Every required failure row must record:

- hypothesis and expected invariant
- fixed seed and action sequence
- exact durable cut point
- blast radius and affected traffic cohort
- injection, detection, mitigation, service recovery, and backlog-drain times
- offered, accepted, completed, failed, canceled, shed, and retried counts
- authoritative before and after state
- final invariant reconciliation
- replay result and repeat count
- `PASS`, `FAIL`, or `MISSING`

Run dependency blackholes and delays, not only clean connection refusals. Run
worker loss both gradually and abruptly. Exercise failure at baseline load,
target load, and overload where issue 13 requires the combination. Preserve
every rare-path observation rather than turning a few samples into a p99.

### Separate live acceptance panels from diagnostic panels

The Grafana hierarchy should be:

```text
user-visible good events and correctness
  -> traffic, latency, errors, saturation, and recovery
    -> queue, pool, worker, dependency, and resource causes
      -> individual traces, histories, logs, and database records
```

A database CPU or Temporal backlog panel can explain a failed gate. It cannot
turn a failed user-visible gate into PASS. Likewise, low CPU does not establish
unused end-to-end capacity if network latency, serialized transactions, a pool,
or a worker queue is already limiting useful throughput.

## Concrete changes to the Grafana evidence standard

Revise
[`grafana-benchmark-evidence-standard.md`](./grafana-benchmark-evidence-standard.md)
with these additions:

1. Add a **service and SLI contract** before the dashboard sections. Define
   offered, accepted, completed, correct, timely, degraded, shed, and in-flight
   events, including the measurement point and denominator for each ratio.
2. Organize the top dashboard explicitly around the four golden signals. Split
   successful and failed latency. Treat incorrect semantic output and deadline
   violation as errors, not only protocol failure.
3. Add **workload fidelity** panels and gates: intended versus actual send rate,
   journey and cost-class mix, arrival lag, caller-side drops, child fan-out,
   retry amplification, and principal mix.
4. Add **safe overload** panels: useful completed throughput versus offered
   demand, early shedding, queue count and oldest age, in-flight work, deadlines,
   retry rate, degraded quality, and the first constrained resource.
5. Add explicit **ramp, impulse, post-knee, and recovery** annotations and
   machine gates. Recovery must compare queue age, latency, error rate, and
   resource use with the pre-run steady band.
6. Add a **capacity safety margin** result. Report the confirmed envelope, knee
   bounds, tested post-knee behavior, and headroom from the chosen operating
   point. Do not derive the operating point from peak throughput alone.
7. Add **failure experiment metadata** to the durable bundle: hypothesis, seed,
   ordered action log, blast radius, cut point, timestamps, repeat count, and
   replay result.
8. Add symptom-oriented alert and gate queries based on good events divided by
   total events. Keep resource thresholds diagnostic unless they represent a
   declared imminent saturation policy.
9. Add observer-impact evidence: load-generator CPU, memory, network, scheduling
   lag, and dropped sends, plus Prometheus ingestion and scrape overhead.
10. Add a rule that an evidence-valid `FAIL` is preferable to an altered or
    incomplete `PASS`. Missing target rows, absent distributions, changed
    traffic mixes, or unreconciled accepted work remain `MISSING` or `FAIL`.

The current standard already has the correct durable hierarchy, exact samples,
histograms, TSDB snapshot, configuration capture, annotations, telemetry gate,
and fail-closed verdict. These additions connect that evidence to user-visible
service outcomes, workload fidelity, overload stability, and recovery.

## Concrete changes to issue 13 acceptance

Issue 13 should resolve only when one immutable evidence bundle demonstrates:

1. The exact required topology, worker fleet, dependency versions, request mix,
   persistence profile, fixed seed, and target rates were actually used.
2. The full production-shaped deterministic lane ran at 700, 1,400, 2,083, and
   4,167 offered AgentRuns per second without adapting the rates downward.
3. Gradual and impulse traffic, steady load, mixed journeys, post-knee overload,
   failure under load, drain, and recovery all have complete evidence rows.
4. Offered demand is measured at the generator, and the equations
   `offered = received + caller_drop` and
   `received = accepted + shed_or_rejected` reconcile.
5. Every accepted AgentRun reaches exactly one valid terminal outcome or is
   explicitly accounted as in flight at the declared boundary. The final drain
   must leave zero unexplained accepted work.
6. Correctness is checked during overload and recovery, not only before and
   after the run.
7. Useful completed throughput, queue age, successful and failed latency,
   retry amplification, shedding, and the saturated resource identify the
   capacity knee and post-knee behavior.
8. The complete issue 13 failure matrix has repeatable, replayable rows with
   recovery and authoritative reconciliation.
9. The telemetry completeness and workload-fidelity gates pass, and the raw
   data can reproduce every dashboard claim.
10. The report clearly separates three outcomes:
    - evidence validity: was the experiment complete and reproducible?
    - target result: did this implementation meet the declared traffic and
      correctness requirements?
    - capacity conclusion: what operating envelope and safety margin were
      actually demonstrated?

A complete run that fails 700 AgentRuns per second is a valid confirmation of a
failed hypothesis and should identify the bottleneck. A run at a reduced target
is not confirmation of the stated requirement. A dashboard screenshot is never
confirmation by itself.

## Primary sources

- [Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [Testing for Reliability](https://sre.google/sre-book/testing-reliability/)
- [Handling Overload](https://sre.google/sre-book/handling-overload/)
- [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- [Reliable Product Launches at Scale](https://sre.google/sre-book/reliable-product-launches/)
- [A Collection of Best Practices for Production Services](https://sre.google/sre-book/service-best-practices/)
- [Implementing SLOs](https://sre.google/workbook/implementing-slos/)
- [Monitoring](https://sre.google/workbook/monitoring/)
- [Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Managing Load](https://sre.google/workbook/managing-load/)
- [On-Call](https://sre.google/workbook/on-call/)

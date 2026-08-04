# Deployed ingress and dispatch on Cloud Run, Cloud SQL, and Temporal Cloud

Research date: 2026-08-03
Scope: GitHub issue 20, Candidate A versus Candidate B
Sources: current first-party product documentation and upstream project documentation only

## Executive finding

Candidate A is a valid production-shaped baseline:

```text
external load generator
  -> authenticated Cloud Run ingress service
  -> Cloud SQL transaction: ThreadEvent + root AgentRun
  -> fixed Cloud Run AgentRun worker pool: claim, lease, fence, execute
  -> Temporal Cloud: workflow history and task queues
  -> fixed Cloud Run Temporal worker pool: poll and execute user code
```

Candidate B can be evaluated as an optimization, but Pub/Sub must remain a
wake hint:

```text
admission transaction
  -> ThreadEvent + AgentRun + outbox row
  -> outbox publisher
  -> Pub/Sub authenticated push
  -> request-based Cloud Run worker
  -> authoritative claim and fence in Cloud SQL
  -> periodic Cloud SQL reconciliation
```

The main constraints are concrete:

- Cloud Run worker pools fit continuous non-HTTP polling, but they are billed
  while idle and do not natively autoscale.
- Temporal's managed Cloud Run Serverless Worker integration can control a
  worker pool, but it is pre-release, access-gated, and currently documents
  Go, Python, and TypeScript rather than Rust.
- Cloud Run service maximum-instance settings protect Cloud SQL only
  approximately. Cloud Run can briefly exceed a configured maximum during
  spikes and deployments.
- Pub/Sub push is at-least-once in practice, does not support exactly-once,
  and has a maximum 600-second push request deadline.
- PostgreSQL explicitly documents `SKIP LOCKED` as suitable for multiple
  consumers of a queue-like table, but it returns an inconsistent view and
  provides no documented fairness or starvation guarantee.
- The Temporal Rust SDK is in Public Preview. It is suitable for this
  prototype only as an explicitly measured deployment hypothesis.

## Sourced platform facts

### 1. Authenticated Cloud Run ingress

Cloud Run network ingress and request authentication are separate controls.
The default network setting permits internet reachability, while IAM
authentication still applies. Google recommends combining network ingress
restrictions with IAM where applicable. The three network settings are
`internal`, `internal-and-cloud-load-balancing`, and `all`.
[Cloud Run ingress](https://cloud.google.com/run/docs/securing/ingress)

For authenticated service-to-service calls, the caller presents a
Google-signed OIDC ID token whose audience is the receiving service URL or a
configured custom audience. The caller service account needs
`roles/run.invoker`. Google recommends a per-service user-managed service
account with least privilege.
[Cloud Run service-to-service authentication](https://cloud.google.com/run/docs/authenticating/service-to-service)

Cloud Run service identity supplies application default credentials to a
container. Google explicitly warns against setting `GOOGLE_APPLICATION_CREDENTIALS`
inside Cloud Run and recommends assigning a user-managed service account to
the resource.
[Cloud Run service identity](https://cloud.google.com/run/docs/securing/service-identity)

**Implication for the prototype:** the simplest external load-test path is a
direct `run.app` endpoint with `all` network ingress, no unauthenticated IAM
binding, and a load-generator identity granted only `roles/run.invoker`.
Production end-user authentication remains an application concern and must
not be conflated with the load generator's Cloud IAM identity.

If the external load generator is not running on Google Cloud, use Workload
Identity Federation to obtain short-lived credentials and an ID token rather
than downloading a service-account key.
[Cloud Run with Workload Identity Federation](https://cloud.google.com/iam/docs/tutorial-cloud-run-workload-id-federation)

### 2. Rust AgentRun and Temporal worker hosting

Cloud Run defines three execution resources. Services receive HTTP requests
and autoscale. Jobs run to completion. Worker pools are continuous, non-HTTP,
pull-based containers with no load-balanced URL.
[Cloud Run resource types](https://cloud.google.com/run/docs/overview/what-is-cloud-run)

Worker pools do not natively autoscale. Their instance count is set manually,
including zero to disable a pool. Google documents external scaling through
the Admin API, Workflows, or the CREMA/KEDA-based external autoscaler. Every
requested worker-pool instance is billed as active even when idle.
[Worker-pool manual scaling](https://cloud.google.com/run/docs/configuring/workerpools/manual-scaling)
[External-metric worker-pool scaling](https://cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling)

Worker pools always receive CPU while running. On shutdown, Cloud Run sends
`SIGTERM`, waits 10 seconds, then sends `SIGKILL`. The container must handle
shutdown and make interrupted work recoverable.
[Cloud Run container lifecycle](https://cloud.google.com/run/docs/container-contract#instance-lifecycle)

Cloud Run accepts any container that satisfies the container runtime
contract, so a Rust binary is not tied to a managed language runtime. A
worker-pool instance supports at most 8 vCPU and 32 GiB memory. Regional CPU,
memory, Direct VPC, and instance quotas can impose lower fleet bounds.
[Cloud Run quotas and limits](https://cloud.google.com/run/quotas)
[Worker-pool CPU limits](https://cloud.google.com/run/docs/configuring/workerpools/cpu)

Temporal Cloud hosts the Temporal service. Workflow and Activity code remains
customer code in the customer's environment. Temporal Workers poll Task
Queues and report task results back to the service.
[Temporal Cloud application boundary](https://temporal.io/cloud)
[Temporal architecture and worker polling](https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md)

Temporal recommends choosing a Namespace close to the Worker region to reduce
latency. Its current GCP regions include `us-central1`, `us-west1`, `us-east4`,
`europe-west3`, `asia-south1`, and `asia-southeast2`.
[Temporal Cloud service regions](https://docs.temporal.io/cloud/regions)

The upstream Temporal Rust SDK describes itself as Public Preview and under
active development, with APIs that can continue to change.
[Temporal Rust SDK](https://github.com/temporalio/sdk-rust)

Temporal also documents a Serverless Worker integration for GCP Cloud Run
Worker Pools. Temporal's Worker Controller Instance changes the pool's
instance count through the Cloud Run Admin API as work arrives and drains.
The integration is currently pre-release, may change incompatibly, and
requires access from Temporal support or an account team. Its current guide
lists only the Go, Python, and TypeScript SDKs.
[Temporal Serverless Workers on Cloud Run](https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers/cloud-run)

**Implication for the prototype:** use two separate fixed Cloud Run worker
pools. One polls Cloud SQL for Osfo AgentRuns. The other runs the Rust
Temporal Worker and polls Temporal Cloud. A 10-second shutdown window means
both processes must stop polling promptly. AgentRun work relies on leases and
fencing for takeover. Temporal work relies on Temporal task retry and
Activity idempotency. Pin the exact Rust SDK revision and report Public
Preview status in the evidence.

Do not make Temporal's Serverless Worker integration the Rust prototype
baseline. It is a valuable follow-up conformance lane after Temporal adds Rust
support and the account receives access. Until then, any Osfo external scaler
is an owned control loop and must be benchmarked separately from a fixed pool.

### 3. Cloud SQL connectivity and direct dispatch

Cloud Run can reach private resources through Direct VPC egress without a
Serverless VPC Access connector. Worker pools are supported, receive an IP
from the selected subnet, and can use private Cloud SQL connectivity.
Direct VPC startup can delay connectivity by a minute or more, and Google
recommends a startup check with retries. Networking maintenance can reset
connections, so clients must reconnect.
[Cloud Run Direct VPC](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc)

The Cloud SQL Auth Proxy and language connectors provide IAM-authorized,
TLS-encrypted connections, but do not create a new network path. Private-IP
connections still require VPC reachability. The proxy itself does not limit
application connection count, so the application must pool and bound
connections.
[Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy)

Google's Cloud SQL connection guide explicitly documents a 100-connection
limit per Cloud Run service instance and per Cloud Run job task for the
built-in connection path. It does not state that this limit applies to worker
pools. Total application connections still grow with fleet size. Cloud SQL
recommends connection pools, automatic reconnection, and explicit limits
because each connection consumes client and server resources. Place Cloud Run
and Cloud SQL in the same region for latency, availability, and network-cost
reasons.
[Connect Cloud Run to Cloud SQL](https://cloud.google.com/sql/docs/postgres/connect-run)
[Manage Cloud SQL connections](https://cloud.google.com/sql/docs/postgres/manage-connections)

Cloud SQL derives the initial PostgreSQL `max_connections` value from the
machine configuration. The deployed value must be read from `pg_settings`.
Cloud SQL also notes that `max_connections`, `autovacuum_max_workers`, and
`max_worker_processes` share the backend-process ceiling.
[Cloud SQL PostgreSQL quotas and limits](https://cloud.google.com/sql/docs/postgres/quotas)

PostgreSQL states that `FOR UPDATE SKIP LOCKED` skips rows that cannot be
locked immediately. This produces an inconsistent view and is unsuitable for
general-purpose reads, but can avoid contention among multiple consumers of a
queue-like table. Row locks remain until transaction end. `SKIP LOCKED`
applies only to row locks, not the required table lock.
[PostgreSQL `SELECT` locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
[PostgreSQL row-level locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)

PostgreSQL does not promise row order without a constraining `ORDER BY`. It
also documents that `READ COMMITTED` queries combining `ORDER BY` and a
locking clause can return rows out of order when a selected ordering column
changes concurrently.
[PostgreSQL `LIMIT` and ordering](https://www.postgresql.org/docs/current/queries-limit.html)
[PostgreSQL locking-clause cautions](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

Do not paginate claims with `OFFSET`: PostgreSQL locks rows skipped by
`OFFSET` when a locking clause is present. At `REPEATABLE READ` or
`SERIALIZABLE`, a serialization failure requires retrying the complete
transaction. The exact claim CTE, ordering key, lease, and fence are Osfo
design choices rather than PostgreSQL guarantees.

**Implication for Candidate A:** claim a small ordered batch and update its
owner, lease expiry, and monotonic fence in one short transaction. Commit
before model, sandbox, SMTP, or Temporal calls. Enforce the connection budget:

```text
all fleet max instances * per-instance pool limit
  + deployment overlap reserve
  + administration and migration reserve
  < observed Cloud SQL max_connections
```

Cloud Run can briefly exceed a configured service maximum, and a rollout can
temporarily keep old and new revisions alive. The connection budget therefore
needs safety margin rather than equality.
[Cloud Run maximum-instance behavior](https://cloud.google.com/run/docs/configuring/max-instances-limits)

Measure empty-poll query rate, rows examined per successful claim, lock waits,
claim collisions, database CPU, I/O, WAL, connections, pending age, and
oldest-item age. Add lease reconciliation and starvation detection because
the PostgreSQL contract does not provide a fairness guarantee.

### 4. Pub/Sub push as a wake hint

Pub/Sub push sends each message as an HTTPS request. A success status
acknowledges it. Any other status or an expired deadline causes redelivery.
Push delivery uses adaptive slow start, and widespread failures trigger a
global push backoff for the subscription.
[Pub/Sub push subscriptions](https://cloud.google.com/pubsub/docs/push)

Authenticated push places a Google-signed OIDC JWT in the request. For Cloud
Run, the push service account needs `roles/run.invoker`, and the configured
audience must match the receiver.
[Authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

Pub/Sub defaults to at-least-once delivery without ordering guarantees.
Exactly-once is available only to pull and StreamingPull subscriptions. Push
subscriptions do not support exactly-once because the push receiver cannot
know whether Pub/Sub received and processed its HTTP acknowledgement.
[Pub/Sub subscription semantics](https://cloud.google.com/pubsub/docs/subscription-overview)
[Pub/Sub exactly-once limits](https://cloud.google.com/pubsub/docs/exactly-once-delivery)

The subscription acknowledgement deadline is 10 to 600 seconds. For push,
that value is also the HTTP request timeout, and an individual push delivery
cannot extend it.
[Pub/Sub subscription properties](https://cloud.google.com/pubsub/docs/subscription-properties)
[Pub/Sub RPC subscription contract](https://cloud.google.com/pubsub/docs/reference/rpc/google.pubsub.v1#subscription)

**Implication for Candidate B:** the signal carries only an immutable
identifier. Every delivery must re-read and conditionally claim the AgentRun
in Cloud SQL. Duplicate, delayed, and reordered messages must become no-ops
when the authoritative row is already leased or terminal. The outbox publisher
and a periodic database reconciler are correctness requirements, not optional
optimizations.

A push handler that executes the whole AgentRun must finish and acknowledge
inside the 600-second Pub/Sub ceiling. Returning success before durable
handoff is unsafe under request-based billing because CPU is allocated only
while a request is active and an idle service instance can be terminated.
[Cloud Run billing settings](https://cloud.google.com/run/docs/configuring/billing-settings)

Therefore Candidate B must prove one of these bounded contracts:

1. Each push request claims and completes a bounded AgentRun within the push
   deadline, with leases recovering termination.
2. The request durably hands the run to another owned execution mechanism
   before acknowledging. This adds another queue or persistent worker and
   weakens the proposed simplicity and scale-to-zero benefit.

Do not mirror Temporal task queues into Pub/Sub. Temporal Workers already
poll Temporal Cloud task queues, and Temporal Cloud remains the workflow
execution authority.

### 5. Autoscaling and capacity bounds

Cloud Run services autoscale on requests and resource signals. Maximum
concurrency is configurable up to 1,000 requests per instance. Revisions
default to a 100-instance maximum, but the service-level maximum should be
set explicitly when protecting Cloud SQL.
[Cloud Run concurrency](https://cloud.google.com/run/docs/about-concurrency)
[Cloud Run maximum instances](https://cloud.google.com/run/docs/configuring/max-instances)

A configured maximum can be exceeded briefly during traffic spikes. Revision
rollouts can also overlap old and new revision maxima. When all instances are
busy, Cloud Run can hold an incoming request for up to 30 seconds before it
fails.
[Cloud Run maximum-instance cautions](https://cloud.google.com/run/docs/configuring/max-instances-limits)

Worker pools have manual instance counts. External autoscaling changes that
count through the Admin API and therefore has a control-loop delay rather than
request-time scaling. CREMA is an additional service using KEDA-compatible
external metrics, which adds operational and compute cost.
[Cloud Run worker-pool scaling](https://cloud.google.com/run/docs/configuring/workerpools/manual-scaling)

Temporal Cloud applies APS, RPS, and OPS Namespace limits. On-Demand limits
adapt to trailing seven-day use and can throttle sudden load with
`ResourceExhausted`. Temporal specifically lists load testing as a use case
for Provisioned Capacity. Capacity and throttling metrics must be captured so
Temporal is not confused with a worker or database bottleneck.
[Temporal Cloud capacity modes](https://docs.temporal.io/cloud/capacity-modes)

The default Namespace APS floor is 500. On-Demand capacity grows by the
lesser of four times the trailing seven-day mean APS and twice the trailing
seven-day p90 APS. One provisioned Temporal Resource Unit supplies 500 APS,
1,500 RPS, and 4,000 OPS, and the available provisioned sizes begin at two
TRUs. At 232 admitted messages per second, the 500 APS floor permits only
about 2.15 billable Actions per message before throttling. That arithmetic is
an Osfo capacity warning, not an estimate of actual amplification. Measure
Actions per message on the reference journey and provision capacity or obtain
a raised floor before the full-rate lane if the measured value is higher.
[Temporal Cloud system limits](https://docs.temporal.io/cloud/limits)

### 6. Worker-health evidence

Temporal's minimum Worker observations combine SDK and Cloud metrics:
Workflow and Activity Schedule-to-Start latency, sync match rate, poll success
rate, available task slots, and approximate Task Queue backlog. Its suggested
starting alerts are p99 Schedule-to-Start above 200 ms, sync match below 95%,
poll success below 90%, zero available slots, and backlog growing over time.
For high-volume, low-latency operation it prefers sync match above 99% and
poll success above 95%. These are Temporal's operational starting points, not
Osfo end-to-end service-level objectives.
[Temporal Worker health](https://docs.temporal.io/cloud/worker-health)

The benchmark must graph both Temporal Cloud-side and Rust SDK-side signals,
plus worker CPU, memory, restarts, and network errors. Avoid setting an
Activity Schedule-to-Start timeout during load tests because Temporal warns
that it skews this observation and is non-retryable.

## Current public pricing inputs

Use gross public list cost before credits and discounts. Freeze the deployed
region, resource configuration, UTC window, provider pricing URLs, and exact
Cloud Billing SKU IDs with every benchmark. Candidate A and B share ingress,
Cloud SQL, Temporal Cloud, provider, artifact, logging, and monitoring costs.
The comparison must still report those common costs because either candidate
can change their measured usage.

| Cost component | Quantity to preserve | Current public pricing contract |
| --- | --- | --- |
| Cloud Run ingress | requests, active vCPU-seconds, GiB-seconds, startup/shutdown time, minimum-instance idle time | Request-based billing charges active instance time and requests. Instance-based billing charges the full instance lifecycle. Rates vary by region. [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Candidate A AgentRun pool | worker-pool instance-seconds by vCPU and GiB, including idle time | Worker pools charge all running instances as active, even while idle. The current list table exposes per-vCPU-second and per-GiB-second rates. [Cloud Run pricing](https://cloud.google.com/run/pricing#worker-pools) |
| Temporal worker pool | same worker-pool quantities, separately tagged | Same worker-pool rates. Do not include Temporal service infrastructure here. |
| Candidate B push workers | successful authenticated requests, redeliveries, active vCPU-seconds, GiB-seconds, cold starts | Request-based Cloud Run rates. At steady traffic, Google states instance-based billing can be more economical, so compare measured billing modes. [Cloud Run billing guidance](https://cloud.google.com/run/docs/configuring/billing-settings#how-to-choose) |
| Candidate B Pub/Sub | publish bytes, delivery bytes, retry bytes, retained backlog GiB-hours, cross-region transfer | First 10 GiB of basic throughput per billing account per month is free, then $40/TiB. Pricing uses a minimum 1 KB per request. Retained acknowledged data and backlog older than one day cost $0.27/GiB-month. [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing) |
| Cloud SQL | edition, region, vCPU-hours, GiB-hours, HA mode, SSD GiB-months, backups, public IPv4, network transfer | Compute, memory, storage, backups, and network prices vary by edition and region. Preserve exact selected table values and SKU IDs. [Cloud SQL pricing](https://cloud.google.com/sql/pricing) |
| Temporal Cloud | plan, billable Actions by type, Active and Retained GB-hours, capacity mode | Essentials includes 1M Actions, 1 GB Active Storage, and 40 GB Retained Storage. Overage begins at $50 per million Actions, $0.042 per Active GB-hour, and $0.00105 per Retained GB-hour. Plan cost is the greater of $100/month or 5% of usage spend. [Temporal Cloud pricing](https://docs.temporal.io/cloud/pricing) |
| Temporal load amplification | Workflow starts, Activity starts and retries, heartbeats reaching the service, timers, Signals, Queries, Updates | Actions are the billing unit. Usage and Billing data is authoritative because Event History and metrics do not always map one-to-one to billed Actions. [Temporal Cloud Actions](https://docs.temporal.io/cloud/actions) |
| Shared external providers | model tokens and requests, E2B duration and resources, GCS operations and bytes, egress, logs, metrics, traces | Capture provider invoice or public-list quantities separately. Do not treat trial credits as zero economic cost. |

Use these cost equations on the identical recorded workload:

```text
Candidate A total
  = shared platform and provider cost
  + AgentRun worker-pool active cost
  + direct-poll database resource cost

Candidate B total
  = shared platform and provider cost
  + outbox publisher cost
  + Pub/Sub publish, delivery, retry, retention, and transfer cost
  + push-worker request and active compute cost
  + reconciler cost
  + outbox and claim database resource cost
```

For each lane report cost per accepted message, completed root response, and
1,000 AgentRuns. Also report idle cost, peak cost, retry amplification, and
the fixed monthly Temporal plan allocation separately from marginal Actions.

Cloud prices vary by region. Do not copy a sample rate from another region.
Resolve and preserve the actual regional SKU IDs and list prices from the
[Google Cloud Billing Catalog API](https://cloud.google.com/billing/v1/how-tos/catalog-api).
For Temporal, use the Cloud Billing API report as the authoritative
Namespace-level cost record. Current-month data is provisional until month
close, and generated reports include usage only through roughly current time
minus 24 hours.
[Temporal Cloud Billing API](https://docs.temporal.io/cloud/billing-api)

## Osfo decision rules to validate

The following are design inferences, not provider guarantees:

1. Keep Candidate A unless the deployed 23, 232, and 464 messages/s traces
   show that direct polling or claim contention is the first limiting resource.
2. Candidate A passes only if accepted messages remain lossless, pending age
   is bounded, leases recover terminated workers, fences reject stale owners,
   and Cloud SQL keeps connection, CPU, I/O, WAL, lock, and query latency
   headroom.
3. Candidate B is justified only if the same trace and failure matrix improves
   useful completion, recovery, or total cost enough to pay for outbox,
   Pub/Sub, push authentication, duplicate handling, and reconciliation.
4. Compare a fixed fleet first. Test Candidate A external worker-pool scaling
   and Candidate B request autoscaling separately so neither control loop
   obscures the dispatch capacity curve.
5. Size every Cloud Run maximum from the measured per-instance database pool
   and add rollout and spike headroom. A configured maximum is not a hard
   instantaneous connection guarantee.
6. Treat the 600-second push deadline as a correctness boundary. Any workload
   class that can exceed it requires an explicit durable handoff or remains on
   the direct worker pool.
7. Keep AgentRun workers and Temporal workers as separately deployable fleets.
   Cloud SQL owns AgentRun lifecycle. Temporal Cloud owns workflow execution
   history. Neither fleet writes the other's authority directly.
8. Before the 232 and 464 messages/s lanes, calculate measured Temporal
   Actions per message against the Namespace's observed APS, RPS, and OPS
   limits. Any throttling invalidates an application-capacity conclusion
   unless it is explicitly the failure condition under test.

This research supports deployment and experiment design. It does not select a
winner before the identical deployed workload, correctness gate, recovery
cuts, and gross cost evidence have been measured.

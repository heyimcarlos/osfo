# Pub/Sub does not publish a PostgreSQL commit

Date: 2026-08-04  
Status: research note for Wayfinder #38, no decision change  
Scope: the durable Cloud SQL PostgreSQL to Pub/Sub handoff, the selected Pub/Sub push worker seam, and capacity at the Osfo target.

## Executive conclusion

Wayfinder #25 selected Pub/Sub primary delivery, and issue #39 selected an
authenticated Pub/Sub push subscription that sends one HTTP request per wakeup
to an autoscaling Cloud Run worker service. Those decisions stand. Neither one
publishes anything after an AgentRun commits.

Pub/Sub starts its work only after a publisher calls the Publish API. Google
defines a publisher as an application that creates and sends a message to a
topic. After Pub/Sub receives the message, it stores, replicates, and delivers
it. A normal Pub/Sub topic has no integration that watches Cloud SQL rows.
[Pub/Sub publish workflow](https://docs.cloud.google.com/pubsub/docs/publish-message-overview)

The remaining ticket #38 boundary is therefore:

```text
PostgreSQL admission transaction
  | AgentRun authority
  ` durable outbox obligation
             |
             v
      retrying relay process
             |
             v
        Pub/Sub Publish API
             |
             v
 authenticated HTTPS push
             |
             v
 autoscaling Cloud Run worker service
```

The durable publisher is not a Pub/Sub server setting. It is the combination
of a committed outbox obligation and application code that retries publication
until Pub/Sub confirms acceptance. Once Pub/Sub accepts the message, Pub/Sub
owns storage and delivery. The worker still needs an idempotent point claim
because push delivery is at least once.

The evidence does not identify Pub/Sub service capacity as the B3 bottleneck.
Osfo's target is about 348 wakeups/s and stress is about 696 wakeups/s. Even in
a small Pub/Sub region, those rates use less than 2 percent of the default push
quota. The B3 failure is in the custom relay, shared database, and worker
interaction. Endpoint timeouts then caused Pub/Sub to reduce push concurrency,
retry, and amplify the latency tail.

The central recommendation is to keep Pub/Sub push and keep a durable outbox
bridge, but simplify the publisher shape. Start with one active relay process
for throughput and one eligible peer if rapid failover matters. Do not treat
four logical owners, 16 or 64 sequence stripes, or a publisher fleet as a
Pub/Sub requirement.

## What was already decided

Issue 39 selected authenticated Pub/Sub push into a request-based Cloud Run
service with min zero, max eight, one vCPU, one GiB, concurrency 32, and a
bounded PostgreSQL pool. The point-addressed claim, claim epoch, lease, terminal
fence, and acknowledgement-after-terminal-commit contract is recorded in
[`prototypes/pubsub-worker-seam/REPORT.md`](../../prototypes/pubsub-worker-seam/REPORT.md).

The isolated seam demonstrated that Pub/Sub can wake the worker fleet:

| Offered AgentRun envelopes | Push claim p95 | Completion p95 | Result |
| ---: | ---: | ---: | --- |
| 232/s | 59.9 ms | 80.0 ms | all 13,920 terminal |
| 464/s | 58.2 ms | 78.9 ms | all 27,840 terminal |

The product target is 232 incoming messages/s, not 232 AgentRuns/s. The observed
mix creates 1.5 AgentRuns per incoming message, so the target is about 348
delivery obligations/s and the 2x stress lane is about 696/s. The isolated
232/s and 464/s AgentRun lanes bracket the target, but do not prove the full
696/s product stress path.

Ticket #38 asks how a newly committed AgentRun becomes one of those Pub/Sub
envelopes without a dual-write loss window. It does not ask whether Pub/Sub
should send HTTP to the worker.

## Why a publisher is still required

The selected sequence has two different handoffs:

1. PostgreSQL commit to Pub/Sub publication.
2. Pub/Sub delivery to the Cloud Run worker.

Pub/Sub push implements only the second handoff. The [publisher
contract](https://docs.cloud.google.com/pubsub/docs/publisher) requires an
application, API call, client library, or supported ingestion source to send
the message.

The built-in Pub/Sub ingestion sources currently include Amazon Kinesis, Cloud
Storage, Azure Event Hubs, Amazon MSK, and Confluent Cloud. They do not include
Cloud SQL or PostgreSQL. Google states that sources without an import-topic
integration require an additional service that reads the source and publishes
to Pub/Sub, and that the customer must run, scale, and monitor that service.
[Pub/Sub import topics](https://docs.cloud.google.com/pubsub/docs/publish-message-overview#about_import_topics)

Publishing directly after the SQL commit leaves this loss window:

```text
COMMIT AgentRun
      |
      X process exits before Publish
      |
      ` AgentRun remains durable, but no Pub/Sub wakeup exists
```

The B2 failure campaign proved this is not theoretical for Osfo. The outbox
closes the gap by committing the AgentRun and publication obligation in the
same database transaction. A later relay crash can delay or duplicate a
publish, but cannot erase the obligation.

## What the publisher process is

`Publisher` is an application role, not a Google Cloud compute product and not
a special kind of Pub/Sub server. It is ordinary code using the Pub/Sub client
library or API. Several compute products can run it:

| Compute shape | Fit for an outbox relay | Scaling behavior |
| --- | --- | --- |
| Cloud Run worker pool | Direct fit for continuous, non-HTTP background work | Fixed instance count unless an external autoscaler changes it |
| Cloud Run service with instance-based CPU and min instances | Can run a background loop and can expose health/admin HTTP | Native scaling is request and CPU based, not directly based on outbox depth |
| GKE Deployment or VM service | Direct fit with full control | Customer-configured replicas and autoscaling |
| Custom Dataflow streaming pipeline | Managed stream processing, useful when transforms and CDC already justify Dataflow | Dataflow workers can autoscale, but this is a larger pipeline than a small relay |
| Cloud Run Job | Poor fit for continuous low-latency publication | Runs tasks to completion and must be invoked or scheduled |

Google defines Cloud Run worker pools as continuous background compute with no
load-balanced URL. They currently require manual scaling, although Google
documents an external Pub/Sub-metric autoscaler pattern.
[Cloud Run worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools),
[external scaling example](https://docs.cloud.google.com/run/docs/tutorials/autoscale-workerpools-pubsub)

A Cloud Run service can run background work with instance-based CPU and minimum
instances. Minimum instances are a best-effort warm floor and can restart at
any time, so progress must remain durable in PostgreSQL.
[Cloud Run billing and background CPU](https://docs.cloud.google.com/run/docs/configuring/billing-settings),
[minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)

The B3 prototype chose one min-one Cloud Run service instance with one vCPU,
512 MiB, always-allocated CPU, a four-connection database pool, and four
logical relay-owner goroutines. Its service maximum was two instances. Four
owners did not mean four servers. They were four logical owners inside the one
running container during the normal lane.

There is no provider-defined default publisher count. At 348 wakeups/s, one
properly batched publisher client should be enough for raw Pub/Sub throughput.
Additional processes are primarily for availability, faster recovery, or more
database-side claim parallelism. A sensible production starting shape is one
active relay for throughput with at least one eligible peer if rapid failover
matters. The exact replica floor remains a product availability and cost
decision, not a Pub/Sub capacity requirement.

## Managed CDC alternatives

Cloud SQL for PostgreSQL supports logical decoding and replication, so a CDC
consumer can observe committed database changes through the WAL rather than
poll an outbox table.
[Cloud SQL logical decoding](https://docs.cloud.google.com/sql/docs/postgres/replication/configure-logical-replication)

Datastream is Google's managed, serverless CDC product. It supports Cloud SQL
for PostgreSQL, uses PostgreSQL logical decoding, and exposes only committed
changes. Its documented destinations are BigQuery and Cloud Storage, with
Dataflow templates for database replication. It does not provide a direct
Cloud SQL row to Pub/Sub wakeup integration.
[Datastream PostgreSQL sources](https://docs.cloud.google.com/datastream/docs/sources-postgresql),
[Datastream integrations](https://docs.cloud.google.com/datastream/docs/faq#integrations)

A custom Dataflow pipeline can write to Pub/Sub using `PubSubIO`, so a managed
CDC-to-storage-to-Dataflow-to-Pub/Sub route is possible. It adds storage,
pipeline, checkpoint, latency, and operational boundaries. There is no listed
Google-provided Datastream-to-Pub/Sub template.
[Dataflow Pub/Sub output](https://docs.cloud.google.com/dataflow/docs/guides/write-to-pubsub),
[provided templates](https://docs.cloud.google.com/dataflow/docs/guides/templates/provided-templates)

A custom logical-decoding subscriber is another valid publisher shape. It must
still remain online, track durable replication progress, wait for Pub/Sub
confirmation before advancing progress, and tolerate duplicate publication
after ambiguous failures. CDC changes how the publisher discovers committed
work. It does not remove the publisher role.

## Capacity comparison

Osfo's traffic units are:

| Lane | Incoming messages/s | AgentRuns and wakeups/s | Sustained daily equivalent |
| --- | ---: | ---: | ---: |
| Monthly average | 23.15 | 34.7 | 2 million incoming/day |
| Frozen target | 232 | 348 | about 20 million incoming/day |
| 2x stress | 464 | 696 | about 40 million incoming/day |

Pub/Sub throughput accounting rounds each request to at least 1 KB. Default
regional quotas are:

| Region class | Publisher quota | Push subscriber quota |
| --- | ---: | ---: |
| Small | 200 MB/s | 40 MB/s |
| Medium | 800 MB/s | 140 MB/s |
| Large | 4 GB/s | 440 MB/s |

[Pub/Sub quotas](https://docs.cloud.google.com/pubsub/quotas)

At the 1 KB accounting minimum, the small-region push quota is about 40,000
wakeups/s. Osfo consumes approximately:

| Lane | Minimum accounted push rate | Share of small-region push quota | Headroom |
| --- | ---: | ---: | ---: |
| Target | 348 KB/s | 0.87% | about 115x |
| Stress | 696 KB/s | 1.74% | about 57x |

Publisher quota headroom is larger, about 575x at target and 287x at stress.
Payloads larger than 1 KB reduce that ratio, but the wake envelope should carry
an AgentRun identity and compact metadata, not the full execution payload.

For perspective, Google reports that the underlying messaging infrastructure
used by Ads, Search, and Gmail carries more than 500 million messages/s and
more than 1 TB/s. This is not an Osfo sizing promise, but it shows that standard
Pub/Sub is not a fleet that customers shard into publisher servers.
[Pub/Sub architecture](https://docs.cloud.google.com/pubsub/architecture)

On the receiving side, Cloud Run supports a configurable maximum concurrency
up to 1,000 and documents an HTTP/1 limit of 800 inbound requests/s per
instance. The default service concurrency is 80 for common deployments.
[Cloud Run concurrency](https://docs.cloud.google.com/run/docs/about-concurrency),
[Cloud Run limits](https://docs.cloud.google.com/run/quotas)

These are platform ceilings, not application throughput promises. At 348
requests/s with 100 ms average handler occupancy, Little's Law implies roughly
35 concurrent requests. At 696/s it implies roughly 70. Both fit within
concurrency 80 in arithmetic, but PostgreSQL pool size, claim latency, model or
tool execution, memory, and the application semaphore determine the actual
number of worker instances.

## Push delivery behavior that matters

Pub/Sub push sends one HTTPS request for each message. A successful HTTP
response acknowledges it. The push window begins small, grows with successful
responses, and should expand to match publish throughput when more than 99
percent of requests succeed and average response latency remains below one
second. Failures and expired requests reduce the window. Push backoff applies
across the subscription.
[Pub/Sub push delivery](https://docs.cloud.google.com/pubsub/docs/push)

For push, the subscription acknowledgement deadline is also the HTTP request
timeout. The configurable range is 10 to 600 seconds. The push endpoint cannot
extend an individual message deadline as a pull client can.
[Pub/Sub subscription RPC contract](https://docs.cloud.google.com/pubsub/docs/reference/rpc/google.pubsub.v1#subscription)

Default delivery is at least once. Push does not support Pub/Sub exactly-once
delivery, so duplicate-safe AgentRun claim and terminal fencing remain required.
[Pub/Sub exactly-once limits](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery)

Ordering has a latency consequence. Push allows only one outstanding message
per ordering key, and redelivery of one ordered message can cause later
messages for the same key to be redelivered. Google cautions against ordered
push when a key is busy or latency is critical.
[Pub/Sub ordering](https://docs.cloud.google.com/pubsub/docs/ordering)

## What the B3 stripe study actually found

The B3 prototype did not find a Pub/Sub throughput ceiling. It found a capacity
transfer in Osfo's topology:

```text
more admission stripes
  -> more committed outbox obligations
  -> same four logical relay owners and four DB connections
  -> more point claims and terminal writes on the shared Cloud SQL primary
  -> worker responses exceed the push deadline
  -> Pub/Sub reduces its push window and retries
  -> duplicate-safe, but very long latency tails
```

The 16-stripe and 64-stripe lanes were orders of magnitude below even the
small-region Pub/Sub quota. The 64-stripe stress lane recorded 516 push
timeouts, followed by 408 harmless duplicate deliveries. The later stable-IAM
target still recorded 80 timeout signals and 86 duplicates. Those are the
documented symptoms of an endpoint that did not acknowledge within its
deadline, not evidence that Pub/Sub lacked topic or push bandwidth.

Pub/Sub's own guidance says subscriber overload and missed acknowledgement
deadlines cause redelivery, and recommends subscriber flow control or more
subscriber capacity.
[Pub/Sub subscriber best practices](https://docs.cloud.google.com/pubsub/docs/subscribe-best-practices),
[acknowledgement monitoring](https://docs.cloud.google.com/pubsub/docs/monitoring#monitor_acknowledgment_deadline_expiration)

## Answer for ticket #38

Keep the decisions separate:

1. **Worker delivery:** already selected. Pub/Sub sends authenticated HTTP push
   requests to an autoscaling Cloud Run service.
2. **Publication safety:** still required. PostgreSQL does not automatically
   publish a committed AgentRun, so retain either an outbox relay or a CDC
   publisher with equivalent durable progress and duplicate handling.
3. **Publisher count:** Pub/Sub requires no customer-managed publisher fleet.
   One application relay is enough for the target's raw publish throughput.
   Add an eligible peer for availability or measured database parallelism, not
   because 348 messages/s challenges Pub/Sub.
4. **Current prototype verdict:** the outbox correctness pattern works, but the
   four-owner sequencing and shared-resource implementation should not be
   mistaken for a Pub/Sub requirement. The next experiment, if authorized,
   should simplify or isolate that relay and protect the worker/database path
   from push deadline expiry.

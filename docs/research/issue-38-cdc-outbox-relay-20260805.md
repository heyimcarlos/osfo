# CDC does not remove Osfo's publisher boundary

Date: 2026-08-05
Status: research note for Wayfinder #38, no decision change
Scope: whether PostgreSQL change data capture can replace the B3 append-only
outbox relay before the warm-worker experiment.

## Executive conclusion

CDC can replace the way a publisher discovers committed work. It does not
remove the publisher boundary between PostgreSQL and Pub/Sub.

Google Cloud has no direct managed Cloud SQL PostgreSQL to Pub/Sub row-event
path. Datastream's supported destinations are BigQuery, Cloud Storage, and
Apache Iceberg, not Pub/Sub. Pub/Sub import topics do not support PostgreSQL as
a source. Google states that an unsupported source requires an additional
service that reads the source and publishes messages.
[Datastream destinations](https://docs.cloud.google.com/datastream/docs/destinations),
[Pub/Sub import topics](https://docs.cloud.google.com/pubsub/docs/publish-message-overview#about_import_topics)

Four CDC shapes are technically possible:

1. Datastream can write CDC files to Cloud Storage. A Pub/Sub Cloud Storage
   import topic can then ingest new text or Avro objects without
   customer-managed compute, or Cloud Storage can publish object-finalization
   notifications to a consumer. This is an indirect managed storage route,
   not direct database publication. Datastream's Cloud Storage file-rotation
   interval is limited to 15 through 60 seconds. It therefore cannot satisfy
   Osfo's 100 ms handoff objective. Generic Avro ingestion also does not define
   Osfo's stable, minimal `AgentRunId` message contract, so its output contract
   would still need validation or transformation.
   [Datastream Cloud Storage destination](https://docs.cloud.google.com/datastream/docs/destination-gcs),
   [file-rotation range](https://docs.cloud.google.com/php/docs/reference/cloud-datastream/latest/V1.GcsDestinationConfig),
   [Cloud Storage import topics](https://docs.cloud.google.com/pubsub/docs/create-cloud-storage-import-topic),
   [Cloud Storage notifications](https://docs.cloud.google.com/storage/docs/pubsub-notifications)
2. Datastream plus a custom streaming Dataflow pipeline can transform CDC
   files into AgentRun Pub/Sub messages. Dataflow supports Pub/Sub output, but
   this is a custom pipeline and a continuously allocated compute layer.
   Streaming Engine jobs have a minimum of one worker.
   [Dataflow Pub/Sub output](https://docs.cloud.google.com/dataflow/docs/guides/write-to-pubsub),
   [Dataflow streaming worker floor](https://docs.cloud.google.com/dataflow/docs/guides/tune-horizontal-autoscaling#set-the-autoscaling-range)
3. Google now offers managed Kafka Connect connectors for Cloud SQL PostgreSQL
   as a Debezium source and Pub/Sub as a sink. The route is Cloud SQL to a
   Managed Service for Apache Kafka cluster to a Connect cluster to Pub/Sub.
   It removes application-owned relay code, but adds an intermediate broker
   and two provisioned clusters. Both clusters have a three-vCPU minimum and
   do not scale to zero.
   [managed Cloud SQL PostgreSQL source](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/connect-cluster/create-cloud-sql-postgres-source-connector),
   [managed Pub/Sub sink](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/connect-cluster/create-pubsub-sink-connector),
   [Kafka cluster minimum](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/plan-cluster-size),
   [Connect cluster minimum](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/connect-cluster/create-connect-cluster#capacity_configuration)
4. Debezium Server has PostgreSQL logical-decoding support and a direct Google
   Cloud Pub/Sub sink. This is the most credible low-latency CDC challenger
   found, but Debezium Server is itself a continuously running publisher
   process. It also needs durable offset storage and a PostgreSQL replication
   slot. Its Pub/Sub sink waits for every publish future in a batch, then marks
   the records committed, which matches B3's confirmation-before-progress
   safety rule.
   [Debezium Server Pub/Sub sink](https://debezium.io/documentation/reference/operations/debezium-server.html#_google_cloud_pubsub),
   [Debezium PostgreSQL connector](https://debezium.io/documentation/reference/stable/connectors/postgresql.html),
   [Pub/Sub sink source](https://github.com/debezium/debezium-server/blob/main/debezium-server-pubsub/src/main/java/io/debezium/server/pubsub/PubSubChangeConsumer.java#L229-L270)

The evidence therefore supports running the already-approved warm Pub/Sub push
worker experiment first. CDC cannot repair its failed metric. The measured
134.0 ms gate is publish-to-point-claim, whose clock starts only after the
outbox relay has already published. Replacing the relay cannot reduce that
interval.

## The actual alternatives

```text
B3 application relay

Cloud SQL transaction
  | AgentRun + explicit OutboxRecord
  v
continuous relay process
  | SQL batch + Pub/Sub confirmation + durable cursor
  v
Pub/Sub AgentRunId message


Managed Google CDC route

Cloud SQL WAL
  v
Datastream
  v
Cloud Storage CDC files
  | Cloud Storage import topic: managed, at least 15-second file floor
  ` object notification -> parser/fan-out compute: custom message contract
                              |
                              v
                    Pub/Sub AgentRunId messages


Direct CDC application

Cloud SQL WAL + replication slot
  v
continuous Debezium Server process
  | Pub/Sub confirmation + durable LSN offset
  v
Pub/Sub change event


Managed Kafka CDC

Cloud SQL WAL + replication slot
  v
managed Debezium source connector
  v
Managed Service for Apache Kafka topic
  v
managed Pub/Sub sink connector
  v
Pub/Sub change event
```

The first and third direct shapes both contain one continuously running
application process. The difference is whether that process reads an application-owned
outbox and cursor or PostgreSQL's WAL and a logical replication offset.

## Can CDC remove the explicit outbox record?

Yes, but there are three different contracts, and they are not equally safe.
PostgreSQL logical decoding emits concurrent transactions in commit order and
never decodes rolled-back transactions. This means a CDC consumer does not
need B3's transaction-held sequence gates merely to reconstruct commit order.
[PostgreSQL output-plugin ordering](https://www.postgresql.org/docs/17/logicaldecoding-output-plugin.html#LOGICALDECODING-OUTPUT-PLUGIN-CALLBACKS)

### Capture the append-only OutboxRecord

This is the strongest CDC variant for Osfo. Admission still commits the
AgentRun and its narrow publication obligation atomically. Debezium captures
only insertions from the outbox table and publishes them to Pub/Sub. Its
official Outbox Event Router is designed for an insert-only outbox and provides
an event ID for deduplication.
[Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

This shape removes custom polling, relay cursors, advisory ownership, and
commit-order sequencing gates. It retains the queryable business obligation,
bounded retention, and easy reconciliation. It does not remove the Debezium
publisher process, replication slot, durable offset, or WAL monitoring.

### Capture AgentRun inserts directly

If every accepted AgentRun is represented by exactly one durable `INSERT`, its
row can act as an implicit publication obligation. This removes the extra
OutboxRecord write and table. It also couples the broker contract to the
physical AgentRun schema. Snapshots and recovery backfills can emit old rows,
updates need filtering, and one database change cannot naturally express
multiple differently shaped broker obligations. Point claims still make old
or duplicate wakeups harmless, but the publication obligation is less explicit
and less independently auditable.
[PostgreSQL logical replication](https://www.postgresql.org/docs/current/logical-replication.html),
[Debezium PostgreSQL snapshots](https://debezium.io/documentation/reference/stable/connectors/postgresql.html#postgresql-snapshots)

### Emit a transactional logical message

PostgreSQL can write a generic message directly into WAL with
`pg_logical_emit_message(true, prefix, content)`. A transactional message is
flushed with its surrounding transaction, and Debezium can capture these
messages through `pgoutput` on PostgreSQL 14 and later. This preserves an
explicit message envelope without an outbox table.
[PostgreSQL logical messages](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-REPLICATION),
[Debezium message events](https://debezium.io/documentation/reference/stable/connectors/postgresql.html#postgresql-message-events)

The tradeoff is recoverability. The obligation exists only in the WAL stream
and connector offset. It cannot be queried or reconciled as an OutboxRecord.
If a PostgreSQL slot position is lost, events between the lost position and a
new slot are lost and recovery requires backfill, but generic logical messages
have no table to backfill. This is the least suitable variant for ticket #38's
visible-recoverability requirement.
[Datastream stream recovery](https://docs.cloud.google.com/datastream/docs/recover-a-stream)

The practical CDC challenger is therefore not raw AgentRun CDC or logical
messages. It is `OutboxRecord -> Debezium Server -> Pub/Sub`: keep the semantic
outbox, remove the custom polling and sequencing implementation.

## Comparison for Osfo

| Property | Append-only outbox relay | Datastream plus GCS/Dataflow | Managed Kafka Connect | Debezium Server to Pub/Sub |
| --- | --- | --- | --- | --- |
| Atomic admission | Explicit AgentRun and OutboxRecord in one transaction | Can infer an obligation from a committed AgentRun insert, or capture the outbox | Can infer an obligation from a committed AgentRun insert, or capture the outbox | Can infer an obligation from a committed AgentRun insert, or capture the outbox |
| Durable progress | Application cursor in Cloud SQL, advanced after Pub/Sub confirmation | Datastream source position, GCS files, then Dataflow checkpoints | PostgreSQL slot plus Kafka Connect state in the primary Kafka cluster | PostgreSQL replication slot plus an external durable offset store |
| Delivery | At least once by retry after ambiguous publish | Datastream is at least once and can duplicate | Debezium and the sink require duplicate-safe consumers | Debezium can duplicate during fault recovery and documents at-least-once behavior |
| Ordering | Explicit commit-order gate per shard | Datastream does not guarantee event order, metadata is supplied for reconstruction | Kafka partition order and optional Pub/Sub ordering keys still require configuration and proof | WAL order is available, but Pub/Sub ordering and cross-topic behavior still require configuration and proof |
| Failover | Eligible peer can acquire durable relay ownership; outbox rows remain queryable | Datastream is multi-zone within a region, but regional recovery can duplicate and PostgreSQL slot loss requires backfill | Managed process failover, but correctness still depends on Kafka state and a surviving or synchronized logical slot | Requires process failover, durable offsets, and a surviving or synchronized logical slot |
| Scale to zero | No, a polling process needs one active instance for low latency | Datastream is serverless, but Dataflow streaming has at least one worker; a GCS-triggered parser can scale to zero only with file-level latency | No, the Kafka cluster and Connect cluster each have a three-vCPU minimum | No, a low-latency WAL consumer must remain connected; an idle slot retains WAL backlog |
| Handoff latency | Measured outbox confirmation p95 71.4 ms | GCS route has at least the 15-second file-rotation floor before notification and parsing | Extra Kafka and buffered sink hop, no Osfo evidence | Potentially low, but no Osfo evidence yet |
| Cloud SQL work | Extra OutboxRecord insert, bounded relay reads, and cursor updates | Logical decoding, WAL sender, replication slot, and potentially an outbox insert | Logical decoding, WAL sender, replication slot, and potentially an outbox insert | Logical decoding, WAL sender, replication slot, and potentially an outbox insert |
| Outage pressure | Visible outbox rows consume ordinary table storage | An inactive slot retains WAL and can grow disk indefinitely | An inactive connector slot retains WAL and can grow disk indefinitely | An inactive slot retains WAL and can grow disk indefinitely |
| Operating surface | One small application relay and Cloud SQL-owned recovery state | Datastream, Cloud Storage, notifications, custom Dataflow, and their independent checkpoints | Kafka cluster, Connect cluster, source connector, sink connector, topics, offsets, and slot lifecycle | One Debezium runtime, offset store, replication slot lifecycle, transformations, and Pub/Sub sink |
| Cost shape | Known prototype relay idle floor, about $59.92/month | Datastream bytes, GCS, Pub/Sub, and at least one Dataflow worker | Provisioned Kafka and Connect compute, Kafka storage, networking, and Pub/Sub | Always-on compute plus offset storage and database logical-decoding overhead |

Datastream documents at-least-once delivery, no ordering guarantee, duplicate
metadata, multi-zone regional operation, and duplicate replay after a regional
outage.
[Datastream behavior](https://docs.cloud.google.com/datastream/docs/behavior-overview),
[Datastream events](https://docs.cloud.google.com/datastream/docs/events-and-streams)

Debezium documents durable LSN offsets and possible duplicates after a process
crash. Debezium Server's default non-Kafka offset store is a local file, with
JDBC and Redis options available. A production deployment therefore needs an
explicit offset durability and failover design rather than an ephemeral
container filesystem.
[Debezium fault behavior](https://debezium.io/documentation/reference/stable/connectors/postgresql.html#postgresql-when-things-go-wrong),
[Debezium Server offset stores](https://debezium.io/documentation/reference/operations/debezium-server.html#_source_configuration)

## Database and recovery consequences

CDC reduces source queries because it reads PostgreSQL's WAL instead of polling
an indexed table. It is not free database work. Cloud SQL runs one WAL sender
per consumer, logical decoding requires a replication slot, and enabling the
logical-decoding flag requires an instance restart. An inactive slot can retain
WAL indefinitely and grow disk until the slot recovers or is removed.
[Cloud SQL logical decoding resources](https://docs.cloud.google.com/sql/docs/postgres/replication/configure-logical-replication#postgresql_resources)

One PostgreSQL Datastream stream uses one logical replication slot. Google
warns that a large transaction or high-volume table can block unrelated tables
behind that slot and recommends separate streams for high-churn tables. More
streams mean more slots and WAL senders, not free horizontal scale.
[Datastream PostgreSQL best practices](https://docs.cloud.google.com/datastream/docs/sources-postgresql#best_practices)

Logical-slot failover is also a separate design concern. Cloud SQL documents
automatic logical subscriber reconnection and synchronized failover slots for
a specific advanced-DR configuration: PostgreSQL 17 or later, Enterprise Plus,
and private services access. Outside a validated configuration, losing a slot
can turn recovery into a backfill operation.
[Cloud SQL logical failover slots](https://docs.cloud.google.com/sql/docs/postgres/advanced-dr-logical-failover-slot),
[Datastream recovery](https://docs.cloud.google.com/datastream/docs/recover-a-stream)

The append-only outbox has the opposite failure shape. A stopped relay grows a
normal, inspectable table partition rather than retaining the database WAL.
Osfo already has bounded retention, replay-window, cursor, and duplicate-fence
logic for that shape.

## Latency and cost

The managed Datastream to Cloud Storage route is disqualified for Osfo's
100 ms path because files rotate no sooner than 15 seconds. Cloud Storage says
notifications are normally delivered within seconds, gives no delivery-time
SLA, guarantees at-least-once delivery, and does not guarantee ordering.
[Datastream file rotation](https://docs.cloud.google.com/php/docs/reference/cloud-datastream/latest/V1.GcsDestinationConfig),
[Cloud Storage notification guarantees](https://docs.cloud.google.com/storage/docs/pubsub-notifications#delivery_guarantees)

A custom Dataflow stream removes the file consumer from Osfo's application
code, not from the system. Dataflow still executes the transformation on worker
VMs, and each streaming job uses at least one worker. Google bills Dataflow
worker vCPU and memory, plus associated services.
[Dataflow pricing](https://cloud.google.com/dataflow/pricing),
[Dataflow worker floor](https://docs.cloud.google.com/dataflow/docs/guides/troubleshoot-autoscaling#scaling-range)

Datastream itself charges by processed GiB. Google says its internal processed
representation is commonly two to five times the source data, idle streams are
free, and Cloud SQL sources are not included in the currently documented
AlloyDB and Spanner free tier. GCS, Dataflow, Pub/Sub, and networking are billed
separately.
[Datastream pricing](https://cloud.google.com/datastream/pricing)

The direct Debezium route could plausibly beat SQL polling latency while
retaining the outbox, because WAL commit order removes B3's polling cursor and
commit-order gates. Watching AgentRun inserts could additionally remove the
outbox write, but weakens visible reconciliation. Both are hypotheses, not
provider evidence, and must be compared under Osfo's exact load and crash
boundaries. Neither addresses the current 134.0 ms publish-to-claim failure
because that interval begins after either publisher has completed.

The managed Kafka Connect route is operationally managed, but materially
larger. A source connector writes Cloud SQL changes to Kafka topics and a sink
connector consumes those topics and publishes to Pub/Sub. The sink buffers
messages before publishing, so its latency depends on buffer configuration and
must be measured.
[Cloud SQL source connector](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/connect-cluster/create-cloud-sql-postgres-source-connector),
[Pub/Sub sink buffering](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/connect-cluster/create-pubsub-sink-connector#how_a_pubsub_sink_connector_works)

At the documented us-central1 on-demand prices and minimum three-vCPU,
three-GiB configurations, one Kafka cluster plus one Connect cluster is about
$373/month before Pub/Sub, networking, and long-term storage. This is an
inference from Google's published capacity minima, DCU conversion, hourly
prices, and 100 GiB local storage per Kafka vCPU. It is already more than six
times B3's measured relay idle floor.
[Managed Kafka capacity](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/plan-cluster-size),
[Connect capacity](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/connect-cluster/create-connect-cluster#capacity_configuration),
[Managed Kafka pricing](https://cloud.google.com/managed-service-for-apache-kafka/pricing)

## Recommendation for ticket #38

Keep the approved next experiment unchanged:

1. Retain the proven append-only outbox and publisher-confirmation contract.
2. Add the small warm Cloud Run push-worker floor.
3. Repeat the frozen target lane and decide whether 100 ms publish-to-claim is
   attainable at an acceptable idle cost.

Do not insert Datastream into this path. Its only managed route toward Pub/Sub
uses Cloud Storage files and cannot meet the latency objective. Datastream plus
Dataflow adds more durable boundaries and continuous compute than the current
relay.

Do not insert Managed Kafka solely to transport Osfo's current 348 wakeups/s.
It can remove custom relay code, but it introduces two always-on clusters, an
intermediate broker, configurable buffering, and logical-slot failure modes.
There is no primary-source or Osfo evidence that this longer path improves
latency or cost. Reconsider it if Kafka becomes shared platform infrastructure.

Keep CDC-driven outbox through direct Debezium Server to Pub/Sub as the
strongest later B4 candidate. Prototype it only if one of these becomes true:

- the outbox insert, relay reads, or cursor writes become measured Cloud SQL
  bottlenecks;
- the relay's application ownership cost becomes materially higher than
  operating replication slots and Debezium offsets;
- a broader CDC platform is already required for other products, allowing Osfo
  to share its operational cost.

Any B4 comparison must retain a durable offset store, wait for Pub/Sub publish
results before accepting progress, prove crash recovery around publish and
offset persistence, monitor slot lag and retained WAL bytes, test Cloud SQL
failover, and preserve the same point-claim and terminal fences. Otherwise it
would only relocate B2's ambiguous handoff.

## Decision in one sentence

CDC is a viable alternative implementation of the publisher, not an automatic
publisher supplied by Cloud SQL, and it does not improve the downstream metric
that the next warm-worker experiment is designed to qualify.

## Appendix: push-versus-pull article validation

The linked [push-versus-pull overview](https://medium.com/@milhamsuryapratama/pub-sub-model-pattern-push-vs-pull-method-896ca4e03bf8)
is a useful conceptual introduction, but its recommendation that pull is
generally preferable for production throughput is not enough to select Osfo's
runtime. Google's current guidance is more specific: pull is the efficient,
high-throughput choice with subscriber-controlled flow and renewable message
leases, while push integrates directly with serverless request autoscaling.
Google explicitly recommends push when consuming Pub/Sub messages with Cloud
Run services.
[subscription-type comparison](https://docs.cloud.google.com/pubsub/docs/subscriber),
[Cloud Run autoscaling with Pub/Sub](https://docs.cloud.google.com/run/docs/about-instance-autoscaling#pubsub)

The article supports these parts of the current design:

- Push delivers each message as an HTTPS request and acknowledges through a
  successful response. Authenticated push can attach a Google-signed OIDC JWT,
  and the selected push identity needs `roles/run.invoker` on the Cloud Run
  service. The endpoint is externally addressable, but it does not need to
  allow unauthenticated callers.
  [push authentication](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
- Pull gives the client explicit flow control and allows it to renew message
  leases. The high-level client and StreamingPull are therefore better suited
  to execution whose duration is long or unpredictable.
  [subscription-type comparison](https://docs.cloud.google.com/pubsub/docs/subscriber),
  [pull subscriptions](https://docs.cloud.google.com/pubsub/docs/pull)
- Both delivery types require duplicate-safe processing. Exactly-once delivery
  is available only for pull, only within a region, adds latency, and still
  cannot remove publish-side duplicates with distinct message IDs. Osfo's
  point claim, lease epoch, and terminal fences remain necessary.
  [exactly-once delivery](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery)

Several statements need Google-specific correction:

- A push response does not have to be exactly HTTP 200. Pub/Sub accepts 102,
  200, 201, 202, or 204. Other responses and expired deadlines cause
  redelivery.
  [push acknowledgement responses](https://docs.cloud.google.com/pubsub/docs/push#receive_push)
- Push is not an uncontrolled fire hose. Pub/Sub starts with a small push
  window, expands it after successful low-latency acknowledgements, and reduces
  it after failures. Negative acknowledgements and deadline expiry can also
  trigger a global push backoff of 100 milliseconds through 60 seconds.
  [push delivery rate and backoff](https://docs.cloud.google.com/pubsub/docs/push#push_backoff)
- The 10 through 600 second range is not a total pull processing limit. Pull
  clients can repeatedly renew leases. For push, the configured acknowledgement
  deadline is also the HTTP request timeout and an individual delivery cannot
  extend it, so ack-after-terminal push cannot support an AgentRun that may
  exceed 600 seconds.
  [subscription acknowledgement deadline](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions#Subscription.FIELDS.ack_deadline_seconds),
  [push deadline restriction](https://docs.cloud.google.com/pubsub/docs/push#receive_push)
- Dead lettering is not a strict maximum-attempt boundary. Forwarding occurs
  only when a dead-letter policy and IAM are configured, and the attempt limit
  and counter are best effort. A dead-letter topic is diagnostic containment,
  not authoritative AgentRun state.
  [dead-letter behavior](https://docs.cloud.google.com/pubsub/docs/dead-letter-topics#how_dead-letter_topics_work)
- Pub/Sub does not provide Kafka-style strict partition ordering by default.
  Ordering must be enabled and applies only within an ordering key. Push permits
  only one outstanding message per key, which can increase latency and create a
  hot-key bottleneck. Osfo's point-addressed AgentRun wakeups do not require
  broker ordering because the database claim contract resolves current state.
  [Pub/Sub ordering](https://docs.cloud.google.com/pubsub/docs/ordering)

This validation strengthens, rather than changes, the next experiment. A
min-zero Cloud Run service pays cold-start latency on the first request. Google
documents minimum instances as the mechanism for keeping containers warm and
reducing that latency. The B3 flow-control lane already isolated the remaining
failure to publish-to-point-claim p95, so a warm push-worker floor directly
tests the relevant provider behavior.
[Cloud Run minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)

Keep the warm-worker experiment unchanged. If it passes the frozen 100 ms gate
at acceptable idle cost, authenticated push remains the simplest bounded-run
topology. If it fails, or if the product contract admits runs longer than 600
seconds, compare it with a warm StreamingPull pool or a durable step-based
workflow. Nothing in the article changes the CDC conclusion: push versus pull
is downstream of publication, while CDC changes only how committed work reaches
Pub/Sub.

## Appendix: separate outbox table and locking

The linked [transactional-outbox overview](https://java-jedi.medium.com/transactional-outbox-pattern-or-how-to-achieve-data-consistency-across-multiple-services-in-a0081f04d44d)
supports storing an outbox message in a dedicated table and inserting it in the
same database transaction as the business record. That is the correct boundary
for Osfo: `AgentRun` and `OutboxRecord` are separate records in the same Cloud
SQL database and transaction.

The separate table is useful for workload isolation, not for taking an
exclusive table lock. It keeps relay indexes, retention, replay queries, and
publisher maintenance away from `AgentRun` lifecycle rows. PostgreSQL
`SELECT ... FOR UPDATE SKIP LOCKED` locks the selected rows and takes the normal
`ROW SHARE` table lock. It does not block ordinary inserts, whose
`ROW EXCLUSIVE` lock is compatible. PostgreSQL describes `SKIP LOCKED` as an
intentionally inconsistent view suitable for multiple consumers of a
queue-like table.
[PostgreSQL locking clauses](https://www.postgresql.org/docs/current/sql-select.html),
[PostgreSQL lock compatibility](https://www.postgresql.org/docs/current/explicit-locking.html)

However, a relay should not hold those row locks and its database transaction
open while waiting for a Pub/Sub network call. A multi-poller implementation
would need a short transaction to claim a bounded batch, then publish outside
the transaction, then record confirmation. That adds lease or status updates,
expiry and reclaim behavior, and the same duplicate-on-ambiguous-confirmation
case that every transactional outbox must tolerate.

Osfo's measured B3 candidate is cleaner for the current load. One logical relay
owner per stripe uses session advisory ownership, reads append-only outbox rows
after a durable cursor, publishes without per-row locks, and advances the cursor
only after all relevant publish confirmations. It therefore avoids updating or
deleting every event row. This matters at the target rate of 348 AgentRuns per
second, which is about 30 million outbox obligations per sustained day.
PostgreSQL updates and deletes leave old row versions that `VACUUM` must later
reclaim, while retiring a time partition avoids a bulk delete and its vacuum
overhead.
[PostgreSQL vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html),
[PostgreSQL partition maintenance](https://www.postgresql.org/docs/current/ddl-partitioning.html)

The current cursor design still needs its proven commit-order gates. PostgreSQL
sequences are not transactional, so sequence allocation order alone is not
commit order. A later Debezium design could consume insert-only outbox changes
from committed WAL and remove polling row claims, custom cursors, advisory
ownership, and those gates, while retaining the separate outbox as an explicit
reconciliation record.
[PostgreSQL sequence semantics](https://www.postgresql.org/docs/current/functions-sequence.html),
[Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

The article's earlier synchronous dual-write discussion has one material error.
A successful or ambiguously successful broker publish cannot be rolled back by
a normal PostgreSQL transaction. This is exactly the atomic boundary the
transactional outbox is intended to repair. The article correctly identifies
the later outbox relay as at-least-once and requires duplicate-safe consumers.

Decision: keep the dedicated, append-only, partitioned OutboxRecord table in the
same database transaction as AgentRun. Do not put an outbox status column on
AgentRun, do not use an exclusive outbox table lock, and do not replace the
current cursor relay with a per-row mark-or-delete poller. `SKIP LOCKED` remains
a valid alternative if Osfo later needs independently scaling SQL pollers. CDC
remains the stronger later alternative if relay mechanics become the measured
bottleneck.

## Appendix: outbox-table and locking validation

The linked [transactional-outbox article](https://java-jedi.medium.com/transactional-outbox-pattern-or-how-to-achieve-data-consistency-across-multiple-services-in-a0081f04d44d)
gets the core boundary right: write business state and a message into a separate
outbox table in one database transaction, then let another process publish the
committed message. AWS documents the same relational shape, with the business
entity and outbox event saved in their respective tables inside one
transaction.
[AWS transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

The article does not define concurrency control for multiple pollers. Its
suggestion to mark a message processed or delete it after publication also
leaves PostgreSQL maintenance costs unstated. Its no-message-loss claim is
conditional on indefinite retry, durable progress, safe retention, and
reconciliation. It correctly identifies the publish-success plus
database-update-failure window as a source of duplicates.

### Decision for ticket 38

Keep `OutboxRecord` in its own append-only table. Do not explicitly lock the
whole table, and do not replace the proven monotonic-cursor relay with
`FOR UPDATE SKIP LOCKED` without evidence of a bottleneck.

A separate table provides useful isolation:

- Admission can atomically insert `ThreadEvent`, `AgentRun`, and
  `OutboxRecord` because they share one PostgreSQL transaction.
- Relay access, indexes, privileges, vacuum settings, and retention stay
  separate from authoritative `AgentRun` rows.
- The table contains narrow, independently reconcilable publication
  obligations instead of overloading an `AgentRun` status column.
- A later CDC implementation can capture only the outbox relation. Debezium's
  Outbox Event Router expects a dedicated outbox table and insert-only records;
  it treats updates as invalid and filters deletes.
  [Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

The phrase "lock the table and rows" should not become the design. PostgreSQL
states that `SELECT ... FOR UPDATE` locks selected rows until transaction end,
blocks writers and other lockers of those rows, and can cause disk writes. It
also takes a compatible `ROW SHARE` table-level lock, but `SKIP LOCKED` skips
only row locks. An explicit stronger `LOCK TABLE` would unnecessarily widen
contention.
[PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html),
[PostgreSQL locking clause](https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE)

`SKIP LOCKED` is legitimate for a different design in which several consumers
compete to claim queue rows. PostgreSQL describes its result as an inconsistent
view suitable for queue-like tables. It does not close the broker ambiguity
window:

```text
claim rows -> publish -> mark processed
                   |
                   ` crash here still causes a later duplicate
```

Holding the row locks while waiting for Pub/Sub confirmation puts a network
call inside a database transaction and occupies a connection. Committing a
lease before publishing shortens the transaction, but adds status updates,
lease expiry, reclaim logic, and a reaper. Both forms still need duplicate-safe
consumers.

Osfo's current shape deliberately avoids those costs:

```text
one active owner per shard
  -> read immutable rows after durable cursor
  -> publish bounded batch
  -> wait for all confirmations
  -> advance one shard progress row
```

The relay never locks, updates, or deletes an outbox row. A crash before the
cursor commit can replay a batch but cannot skip it. This requires one active
owner and a genuinely commit-ordered per-shard key. Ticket 38 already found
that ordinary PostgreSQL sequence allocation is not commit ordered, so
admission uses transaction-held sequence-gate rows. Mutation is concentrated
in bounded gate and progress tables instead of every retained outbox record.

PostgreSQL's HOT optimization can reduce this bounded update cost when updated
columns are not referenced by indexes and the heap page has space. The current
gate table's low fill factor and non-indexed counter follow those conditions.
[PostgreSQL HOT updates](https://www.postgresql.org/docs/17/storage-hot.html)

Keep production outbox indexes minimal: a stable unique event identity and the
relay access path `(sequence_stripe, stripe_sequence)` are sufficient for the
current model. A competing-poller model would normally use a small partial
index such as `(ready_at, id) WHERE published_at IS NULL`, but changing
`published_at` removes rows from that index and creates obsolete heap and index
versions. PostgreSQL retains rows made obsolete by `UPDATE` or `DELETE` until
`VACUUM` reclaims them. A partial pending index can make lookup efficient, but
it does not make status mutation free.
[PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html),
[PostgreSQL VACUUM](https://www.postgresql.org/docs/current/sql-vacuum.html)

Daily range partitions remain the preferred retention mechanism. Detaching or
dropping a completed partition is much faster than bulk deletion and avoids
the vacuum work caused by per-row deletes. A partition is eligible only after
the replay window and after every relevant durable relay cursor has passed its
maximum sequence. Prefer `DETACH PARTITION CONCURRENTLY`, followed by dropping
the detached table, when its restrictions are acceptable: direct drop takes
`ACCESS EXCLUSIVE` on the parent, while concurrent detach uses
`SHARE UPDATE EXCLUSIVE`.
[PostgreSQL partition maintenance](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-MAINTENANCE)

CDC strengthens the case for a separate insert-only outbox. It removes SQL
polling and outbox row locks, but replaces the relay cursor with a replication
slot and durable connector offset. Retention must then wait until the CDC
publisher has durably advanced beyond the partition's events. For a partitioned
outbox, `publish.via.partition.root=true` emits every partition through the
logical base-table identity, while the default exposes each physical partition
as its own source table.
[Debezium PostgreSQL partition handling](https://debezium.io/documentation/reference/stable/connectors/postgresql.html#postgresql-property-publish-via-partition-root)

The direct answer is: **yes to a separate `OutboxRecord` table, no to
whole-table locking, and no row locking in the selected cursor design**.
`SKIP LOCKED` remains a valid fallback for independently competing pollers, but
it is not an improvement over the proven append-only outbox plus monotonic
progress contract.

## Appendix: final GCP deployment-topology validation

The proposed topology is directionally right about using Cloud Run, Cloud SQL,
and Pub/Sub, but several central details conflict with Google Cloud's current
contracts and with Osfo's measured design. The corrected topology for the next
experiment is:

```text
authenticated client
  -> Cloud Run ingress service
  -> Cloud SQL: ThreadEvent + AgentRun + OutboxRecord in one transaction
  -> Cloud Run relay service: min 1, instance-based billing
       one logical owner per shard through PostgreSQL advisory locks
  -> Pub/Sub topic
  -> authenticated push subscription
  -> Cloud Run worker service: warm-floor experiment, bounded concurrency
  -> point claim, execute, terminal commit, then HTTP success
```

This keeps the already-selected direct Pub/Sub push path. It does not place a
pull subscription in front of an Eventarc trigger, and it does not create one
Cloud Run Job execution per AgentRun.

### Services, Jobs, and worker pools are different compute contracts

A Cloud Run service is the correct immediate worker candidate because Pub/Sub
push creates one authenticated HTTP request per message and Cloud Run
autoscales on those requests. Google recommends push subscriptions for Cloud
Run services. A Cloud Run Job is a run-to-completion batch resource, not an
HTTP subscriber or an autoscaling worker pool.
[Cloud Run resource types](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run),
[Cloud Run Pub/Sub autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling#pubsub)

Eventarc Advanced can now invoke the Cloud Run Jobs `:run` Admin API for an
event, so event-to-Job is technically possible. It is not viable for Osfo's
one-execution-per-wakeup path. Cloud Run's default Job Run quota is 180 job
executions per minute per region, while the frozen target produces 20,880
AgentRuns per minute. Eventarc Advanced also has a fixed, non-increasable limit
of 100 one-kilobyte queries per second per pipeline, below the frozen target of
348 AgentRuns per second. Jobs are also billed for each started instance with
a one-minute minimum. Use Jobs for bounded batch or offline work, not as the
AgentRun dispatch primitive.
[Eventarc Advanced Cloud Run Job destination](https://docs.cloud.google.com/eventarc/advanced/docs/quickstarts/publish-events-cloud-run-job),
[Eventarc quotas and limits](https://docs.cloud.google.com/eventarc/docs/quotas),
[Cloud Run quotas](https://docs.cloud.google.com/run/quotas),
[Cloud Run pricing](https://cloud.google.com/run/pricing)

For long and unpredictable AgentRuns, the coherent pull alternative is a Cloud
Run worker pool running StreamingPull. Google defines worker pools for
continuous non-HTTP pull workloads and now documents a Pub/Sub queue-depth
autoscaler using CREMA. Native worker-pool scaling remains manual unless that
external autoscaler is deployed. This is a later fallback, not part of the
warm-push experiment.
[Cloud Run worker pools](https://docs.cloud.google.com/run/docs/resource-model#worker_pools),
[Pub/Sub worker-pool autoscaling](https://docs.cloud.google.com/run/docs/tutorials/autoscale-workerpools-pubsub)

An Eventarc Standard Pub/Sub trigger targets a Cloud Run service by sending
HTTP requests. A normal pull subscription is instead consumed by a subscriber
client. They are alternative delivery shapes, not adjacent boxes in one path.
[Eventarc Pub/Sub to Cloud Run](https://docs.cloud.google.com/eventarc/standard/docs/run/route-trigger-cloud-pubsub),
[Pub/Sub pull](https://docs.cloud.google.com/pubsub/docs/pull)

### The effective push runtime is ten minutes, not sixty

Cloud Run service requests can run for up to 60 minutes, but a Pub/Sub push
subscription's acknowledgement deadline also controls the push HTTP request
timeout and is capped at 600 seconds. Push does not allow per-message deadline
extension. Because Osfo acknowledges only after the terminal database commit,
the selected push contract is limited to AgentRuns that reliably finish within
ten minutes, including shutdown margin.
[Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout),
[Pub/Sub subscription deadline](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions#Subscription.FIELDS.ack_deadline_seconds),
[push acknowledgement behavior](https://docs.cloud.google.com/pubsub/docs/push#receive_push)

Pull subscribers can repeatedly renew message leases. Google's high-level
libraries do this automatically, with a one-hour default maximum extension
period that can be configured. Cloud Run Job task timeout is currently up to
168 hours, not 24 hours, except GPU tasks are limited to one hour. Those facts
make pull worker pools or Jobs useful for different long-running regimes, but
do not make one Job per Pub/Sub message a scalable topology.
[Pub/Sub lease management](https://docs.cloud.google.com/pubsub/docs/lease-management),
[Cloud Run Job task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)

### CPU and concurrency corrections

The worker does not need instance-based billing merely because an LLM response
streams slowly. Under request-based billing, CPU remains allocated for the
entire active push HTTP request. Instance-based billing is required only for
work that must continue outside requests. Returning success before the durable
terminal commit would violate the selected acknowledgement contract, and idle
Cloud Run service instances can be shut down even when kept warm.
[Cloud Run billing and CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings),
[Cloud Run instance lifecycle](https://docs.cloud.google.com/run/docs/container-contract#instance-lifecycle)

Concurrency one is not a general reliability requirement. Google warns that it
forces more instances to start for a traffic spike and can hurt scaling. Osfo's
measured workers are I/O-heavy, use an application semaphore and bounded
database pool, and have already produced materially better cost and startup
behavior above concurrency one. Keep the current concurrency-eight experiment
fixed rather than adding another topology variable.
[Cloud Run concurrency](https://docs.cloud.google.com/run/docs/about-concurrency)

The relay is different. Its polling loop runs outside HTTP requests, so a Cloud
Run service relay needs instance-based billing and at least one minimum
instance. A service maximum of one is not a correctness mechanism: Cloud Run
can temporarily exceed a configured maximum during spikes, maintenance, or
revision rollout. The PostgreSQL advisory lock remains the single-owner fence.
The prototype already uses min one and max two, allowing an eligible peer. Keep
that shape unless measured cost justifies accepting slower restart failover.
[Cloud Run background CPU](https://docs.cloud.google.com/run/docs/configuring/billing-settings),
[maximum-instance exceptions](https://docs.cloud.google.com/run/docs/configuring/max-instances-limits)

The relay must use the native Pub/Sub client or Publish API. Cloud Tasks is a
different queue whose tasks target explicit HTTP handlers. It does not publish
to Pub/Sub. Replacing Pub/Sub with Cloud Tasks would be a new delivery decision,
not an alternative relay SDK call.
[Cloud Tasks versus Pub/Sub](https://docs.cloud.google.com/tasks/docs/comp-pub-sub),
[Pub/Sub publishing](https://docs.cloud.google.com/pubsub/docs/publisher)

### Networking and database access

Cloud SQL private IP is a sound production policy, but it does not itself grant
database access. Google currently recommends Direct VPC egress over Serverless
VPC Access connectors because it has lower latency and no connector compute
floor. Direct VPC can add connection-establishment delay during instance
startup, so the warm experiment should retain a startup probe that verifies
database connectivity before the worker accepts traffic.
[Direct VPC comparison](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc),
[Direct VPC limitations](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)

The Cloud SQL Auth Proxy and language connectors provide encrypted connections
and IAM authorization. They do not create the private network path. A service
using private IP must also have VPC access. Choose one explicit connection
shape rather than treating a proxy sidecar, built-in Cloud Run integration,
and direct private-IP connection as interchangeable configuration switches.
[Cloud SQL connectors](https://docs.cloud.google.com/sql/docs/postgres/connect-connectors),
[Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)

With Direct VPC egress, use revision network tags and VPC firewall policy where
applicable. A rule tied to a Serverless VPC Access connector's address range is
only relevant if that connector path is selected. Private services access
keeps traffic inside Google's network, but database authentication, PostgreSQL
roles, and application-level least privilege remain necessary.
[Cloud SQL private IP](https://docs.cloud.google.com/sql/docs/postgres/private-ip),
[private services access](https://docs.cloud.google.com/vpc/docs/private-services-access)

### IAM and dead-letter corrections

Use a separate user-managed service account per component and grant roles on
the narrowest practical resources:

- Ingress needs Cloud SQL connectivity and its restricted PostgreSQL role.
- Relay needs Cloud SQL connectivity and `roles/pubsub.publisher` on the topic.
- A pull worker needs `roles/pubsub.subscriber` on the subscription. A push
  worker does not, because Pub/Sub invokes it over HTTP.
- For push, the dedicated push-auth identity needs `roles/run.invoker` on the
  worker service. The Pub/Sub service agent needs permission to mint its OIDC
  token. The worker runtime identity still needs Cloud SQL connectivity.
- If automatic IAM database authentication is selected, the runtime also needs
  Cloud SQL Instance User and a corresponding least-privilege database user.

[Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity),
[Pub/Sub access control](https://docs.cloud.google.com/pubsub/docs/access-control),
[authenticated push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions),
[Cloud SQL IAM authentication](https://docs.cloud.google.com/sql/docs/postgres/iam-authentication)

A dead-letter topic is useful operational containment, but it is not a strict
five-attempt guarantee. Pub/Sub says the forwarding threshold and delivery
attempt counter are approximate and best effort, and correct IAM bindings are
required before attempts are counted reliably. Keep Cloud SQL AgentRun state,
leases, terminal fences, and reconciliation as the authority. Treat the
dead-letter subscription as diagnostic evidence that must be monitored and
drained.
[Pub/Sub dead-letter behavior](https://docs.cloud.google.com/pubsub/docs/dead-letter-topics#how-dead-letter-topics-work)

### Final recommendation

Do not adopt the proposed diagram literally. Keep the Cloud Run-centric
platform, but preserve the already-proven direct path:

1. Cloud Run ingress service to private-IP Cloud SQL using Direct VPC egress.
2. Dedicated append-only outbox table and the existing advisory-owned cursor
   relay on a min-one, max-two, instance-billed Cloud Run service.
3. Native Pub/Sub publish, then an authenticated push subscription directly to
   the Cloud Run worker service.
4. Run the approved warm-worker-floor experiment with the existing bounded
   concurrency, database pool, point claim, and acknowledgement-after-terminal
   contract.
5. If the warm push lane fails, or real AgentRuns can exceed 600 seconds,
   compare a fixed or CREMA-scaled Cloud Run StreamingPull worker pool. Reserve
   Cloud Run Jobs for coarse batch work, not per-AgentRun dispatch.

This research strengthens the next experiment. It does not justify changing
the selected topology before measuring the worker warm floor.

## Appendix: Pub/Sub as a post-commit agent-output distribution layer

The final reading pass supports a narrow version of the proposal:

**Use Pub/Sub to distribute committed agent-output facts to independent
downstream consumers. Do not make Pub/Sub the canonical output store, the
Native Thread Transport, or a tool that the model decides when and where to
invoke.**

The resulting planes are distinct:

```text
Agent Runtime proposes AgentEvents
             |
             v
Cloud SQL transaction
  AgentRun lifecycle
  ThreadEvent at ThreadPosition
  AssistantOutput state
  OutboxRecord for eligible integration facts
             |
             +------------------------------+
             |                              |
             v                              v
Native Thread Transport                outbox relay
cursor-based durable SSE                    |
DB replay after reconnect                   v
                                      Pub/Sub output topic
                                             |
                           +-----------------+-----------------+
                           v                 v                 v
                    Messaging Adapter    analytics       other services
```

Cloud SQL therefore remains the authority for `AgentRun`, `ThreadEvent`, and
`AssistantOutput`. Pub/Sub is an asynchronous fanout and notification plane.
The distinction matters because Pub/Sub is a bounded-retention delivery system,
not Osfo's permanent per-Thread history. Subscription retention defaults to
seven days and is capped at 31 days. Seek changes a subscription's
acknowledgement state in bulk; it is not a replacement for an exact
`ThreadCursor` resume over immutable `ThreadEvent`s.
[Pub/Sub retention properties](https://docs.cloud.google.com/pubsub/docs/subscription-properties),
[Pub/Sub replay and seek](https://docs.cloud.google.com/pubsub/docs/replay-overview)

### What the seven examples establish

| Source | Useful evidence | Boundary or defect |
| --- | --- | --- |
| [Vertex AI Agents and Cloud Pub/Sub](https://medium.com/@kamal.aboulhosn/vertex-ai-agents-cloud-pub-sub-8a11dc949246) | The strongest example of output fanout: an agent publishes fraud-analysis facts to two topics, then independent BigQuery subscriptions consume them. This is a good integration-event use case. | The model is instructed to call a generic Pub/Sub tool. The sample catches a publish failure and returns the same empty result as success, and the publication is not atomic with an Osfo lifecycle or ThreadEvent commit. Pub/Sub publish retries can also create identical messages with different Pub/Sub message IDs. Osfo should adopt the fanout shape, not model-owned publication. [Pub/Sub publish retry ambiguity](https://docs.cloud.google.com/pubsub/docs/retry-requests) |
| [Google asynchronous ADK codelab](https://codelabs.developers.google.com/codelabs/genai/agents/async-invocation-with-adk) and [its source](https://github.com/GoogleCloudPlatform/devrel-demos/tree/main/ai-ml/agent-labs/adk_invoke_with_pubsub) | Official evidence that two topics can implement asynchronous invocation and result delivery with authenticated Eventarc and Cloud Run wiring. | It is a connectivity demo, not a durability reference. The source uses `InMemoryRunner`, creates a random session for every delivery, accumulates only the final text, and publishes the response directly before returning HTTP success. Its request has no stable request ID, so redelivery can run the agent and publish a result again. |
| [Event-driven agents with Pub/Sub and ADK](https://brandonlincolnhendricks.com/research/event-driven-ai-agent-architectures-google-cloud-pubsub-adk) | Correctly emphasizes decoupled producers, external state, stable event contracts, bounded concurrency, and output events for independent consumers. | Several operational claims are not reliable enough for a decision. Pub/Sub can retain messages for up to 31 days, not only seven. An HTTP 400 from a push endpoint is a negative acknowledgement and is retried, not a permanent rejection. The claimed ADK-provided idempotency and the performance and cost percentages are not substantiated by primary evidence. [Pub/Sub push acknowledgement codes](https://docs.cloud.google.com/pubsub/docs/push) |
| [GCP AgentFlow](https://dev.to/raghavachellu/gcp-agentflow-building-agentic-ai-orchestration-on-google-cloud-5a2k) | Separates operational state in Datastore, analytics in BigQuery, and Pub/Sub events for downstream workflow activation. | This is the author's library and design, not a Google Cloud product or reliability contract. Its state-first shape supports Osfo, but it supplies no atomic database-to-Pub/Sub handoff evidence. |
| [Deploying Agentic AI as a Service](https://rajatpandit.com/ai-infrastructure/agentic-aaas/) | Supports external durable state, object references for large outputs, bounded agent loops, and asynchronous execution. | It returns final results through webhooks rather than establishing Pub/Sub as an agent output authority. The claim that all agent systems require asynchronous invocation is broader than the evidence. |
| [LangGraph with Kafka and Pub/Sub](https://www.linkedin.com/pulse/scaling-agentic-ai-integrating-langgraph-kafka-google-srivastava-qnruc) | Supports separating persistent state from asynchronous transport and designing for provider rate limits. | A LangGraph `thread_id` is not a sufficient idempotency key. One Thread contains many accepted messages, AgentRuns, outputs, and committed events. Osfo needs an event or delivery identity for deduplication and an `AgentRunId` for correlation. |
| [Autonomous scalable agentic system, part 3](https://medium.com/google-cloud/how-i-built-an-autonomous-scalable-agentic-system-in-production-in-just-one-week-part-3-831ac4110041) | Shows Pub/Sub usefully decoupling scheduled deployment requests from Cloud Build work. | It is a CI/CD orchestration example, not agent response delivery. It provides no new evidence about Osfo's output path. |

The official codelab's two-topic request and response arrangement is therefore
valid when a machine caller wants asynchronous results. It should not become
Osfo's native conversation protocol. Osfo-owned clients already have the
stronger abstraction: command admission followed by `ThreadCursor`-based live
delivery and durable resume.

### Publication must be runtime-owned and post-commit

The agent model must not receive a generic `publish(topic, payload)` capability
as its infrastructure output mechanism. A model can omit the call, repeat it,
choose the wrong destination, or produce a malformed integration envelope. It
also cannot atomically couple that external effect to Osfo's database commit.
If publishing is itself a requested business action, it remains a normal
durable `ToolCall` with the usual intent, retry, and terminal-outcome contract.

Normal assistant output takes this path instead:

1. The Agent Runtime proposes an `AgentEvent`.
2. Osfo decides whether it is a durable conversational fact.
3. In one transaction, Osfo appends the `ThreadEvent`, advances the
   `AssistantOutput` or `AgentRun`, and inserts an `OutboxRecord` for every
   selected integration fact.
4. Only after commit does the relay publish the outbox record to a fixed,
   code-selected Pub/Sub topic.
5. Consumers deduplicate by Osfo's stable event identity and perform their own
   durable effect before acknowledgement.

This reuses the selected transactional outbox and does not require another
publisher service. The same relay service can host independently fenced
publisher lanes for the dispatch topic and output topic. Each lane needs its
own cursor, backlog metric, and failure policy so an output publication failure
cannot hold the AgentRun-dispatch cursor behind it.

### Envelope, correlation, and idempotency

A versioned output envelope should carry identifiers rather than using the
Pub/Sub-assigned `messageId` as domain identity:

```text
event_id             stable Osfo integration-event identity
event_type           typed fact such as assistant_output_completed
schema_version       payload contract version
thread_id
thread_position      canonical per-Thread order
agent_run_id         correlation to the bounded unit of work
assistant_output_id  correlation to the response attempt
causation_id         accepted input or prior event that caused this fact
occurred_at
payload | artifact_ref
```

Pub/Sub assigns `messageId` only after publication. An ambiguous publisher
retry can create two messages with identical content and different message
IDs. Even Pub/Sub exactly-once delivery is pull-only and does not remove these
publish-side duplicates. Subscribers must deduplicate by `event_id`; they must
not deduplicate by `thread_id`, because a Thread intentionally contains many
distinct events.
[Pub/Sub message identity](https://cloud.google.com/pubsub/docs/reference/rest/v1/PubsubMessage),
[Pub/Sub exactly-once limits](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery)

Use a fixed topic such as `thread-events-v1` or
`assistant-output-events-v1`, with one subscription per independent consumer.
Do not accept a caller-provided or model-provided reply topic. If consumers need
routing, put bounded `event_type` and `schema_version` values in message
attributes because subscription filters can inspect attributes but not the
message body. An attached Avro or Protocol Buffer schema can reject invalid
published payloads.
[Pub/Sub subscription filters](https://docs.cloud.google.com/pubsub/docs/subscription-message-filter),
[Pub/Sub schemas](https://docs.cloud.google.com/pubsub/docs/schemas)

### Ordering and replay remain Osfo concerns

When a subscriber genuinely benefits from ordered delivery, publish with
`ThreadId` as the ordering key, from one region, and enable ordering on that
subscription. Treat this as a delivery optimization rather than authority:

- Pub/Sub orders only messages sharing a non-empty key, as received by the
  service.
- Push permits only one outstanding message per ordering key.
- Redelivery of one ordered message can redeliver later messages for that key,
  including messages already acknowledged.
- Ordered delivery trades some availability and latency for coordination.

Every consumer must still compare `ThreadPosition`, ignore an already-applied
`event_id`, and repair a gap from Cloud SQL. Consumers that do not require
ordered delivery should leave it disabled.
[Pub/Sub ordered delivery](https://docs.cloud.google.com/pubsub/docs/ordering)

Pub/Sub messages are also capped at 10 MB. Full model payloads, large tool
results, and artifacts therefore stay in their selected durable stores behind
an `ArtifactRef`; the output event carries a compact semantic fact or verified
reference.
[Pub/Sub quotas and limits](https://docs.cloud.google.com/pubsub/quotas)

### Live output is not a Pub/Sub subscription in the browser

Do not replace Native Thread Transport SSE with Pub/Sub. Pub/Sub is not a
browser-facing token stream, has no per-client `ThreadCursor`, can redeliver,
and adds a broker hop. Continue persisting permitted coalesced
`AssistantOutputAppended` fragments before delivering them through durable
SSE. On reconnect, the client resumes from Cloud SQL using its cursor.

A later stream fleet may consume a compact Pub/Sub `thread_advanced` wake
notification if database polling becomes a measured bottleneck. The
notification only prompts a cursor read. Missing or duplicate notifications
cannot change the resulting client-visible history.

### Decision and experiment sequence

Adopt Pub/Sub as an **optional post-commit integration output layer** for:

- Messaging Adapter delivery obligations,
- downstream service notifications,
- search and analytics projections,
- asynchronous machine callers that explicitly choose a result subscription,
- other agents only when the event contract represents a legitimate new
  admission or wake condition.

Do not use it as:

- `ThreadEvent` or `AssistantOutput` authority,
- the Native Thread Transport or durable client replay log,
- a generic LLM-controlled output tool,
- an implicit agent-to-agent control plane,
- a replacement for the transactional outbox.

This decision does not change the approved warm Cloud Run push-worker
experiment. Adding output publication now would change relay load, database
write amplification, message volume, and user-visible delivery in the same
run. After the worker experiment, test output fanout separately, starting with
one compact terminal output event per `AssistantOutput`. Measure commit p95,
outbox confirmation p95, subscriber receipt p95, relay backlog, database CPU,
duplicate event IDs, detected sequence gaps, and SSE latency. Only then test
fanout of coalesced `AssistantOutputAppended` fragments.

# Broker dispatch concurrency

## Question

Does the PostgreSQL runnable-work queue limit how many AgentRuns can execute in
parallel, and would RabbitMQ materially increase horizontal concurrency?

## Short answer

PostgreSQL currently limits how quickly Osfo can admit, claim, and complete
AgentRuns. It does not impose a one-connection-per-executing-run limit. The
prototype releases its database connection before 20 seconds of synthetic
remote work, so a 64-connection pool supported almost 14,000 running AgentRuns.
The approximate relationship is:

```text
executing concurrency = sustained dispatch rate x average execution duration
                      = 700 runs/s x 20 s
                      = about 14,000 running AgentRuns
```

Adding more workers cannot help after PostgreSQL's short admission, claim, and
completion transactions saturate. It only creates more contenders. A broker can
offload runnable discovery, polling, pending-work buffering, and delivery to
workers. It can therefore raise dispatch throughput when those operations are
the measured bottleneck. It does not remove PostgreSQL admission, lifecycle,
Thread ordering, fencing, or completion work.

The current prototype's first bottleneck is the exact global obligation row,
not candidate discovery. It had up to 60 lock waiters, about four PostgreSQL CPU
cores in use, a 64-client pool, and a 100-connection server limit. The 700
AgentRun/s target was borderline, even though connections were released before
remote execution. RabbitMQ would not fix that global row unless the admission
accounting design also changes.

## What PostgreSQL constrains

PostgreSQL documents `SKIP LOCKED` as appropriate for multiple consumers of a
queue-like table because it avoids waiting for rows already locked by another
consumer. It still takes the normal table lock, and row locks remain until the
transaction ends. This is why short claim transactions scale better than
holding transactions open across remote work. [PostgreSQL locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE),
[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)

`max_connections` limits concurrent database sessions, and PostgreSQL allocates
shared resources based on that setting. Increasing the connection count is not
free. [PostgreSQL connection settings](https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-MAX-CONNECTIONS)

Consequently, PostgreSQL constrains these rates and latencies:

- atomic admission and idempotency receipt creation;
- lifecycle and ThreadEvent persistence;
- runnable selection and claim fencing;
- lease reconciliation;
- fenced completion and capacity release.

It does not directly constrain how many already-claimed AgentRuns perform
remote work, as long as those runs do not retain transactions or connections.
Execution concurrency is constrained by dispatch throughput, execution time,
worker CPU and memory, provider quotas, and configured global and per-Principal
limits.

## What RabbitMQ would offload

A RabbitMQ consumer subscription receives pushed deliveries, so PostgreSQL no
longer needs to poll and scan pending rows for every dispatch. Manual
acknowledgements and per-consumer prefetch provide a bounded window of delivered
but unfinished work. When the prefetch window is full, RabbitMQ stops delivering
to that consumer until it acknowledges work. [RabbitMQ acknowledgements and
prefetch](https://www.rabbitmq.com/docs/confirms#channel-qos-prefetch)

This can offload:

- pending-work buffering;
- wakeups and bounded delivery;
- repeated runnable-candidate scans;
- most claim competition among PostgreSQL dispatchers;
- distribution across many worker consumers.

It cannot offload the current authoritative contracts without redesigning them:

- atomic acceptance and immutable idempotency receipts;
- exact global and per-Principal admission limits;
- authoritative per-Thread ordering;
- monotonic `claim_epoch` fencing;
- durable completion and ThreadEvent writes;
- principal-first fairness, unless the broker topology explicitly implements it.

This distinction matters. A broker can increase the rate at which workers
receive work, but the system still fails to sustain that rate if authoritative
PostgreSQL mutations cannot admit or complete it.

## RabbitMQ is bounded too

RabbitMQ does not make dispatch unbounded. Its flow control slows publishing
connections when queues cannot keep up and propagates pressure back to
publishers. Memory and disk alarms can block publishing. [RabbitMQ flow
control](https://www.rabbitmq.com/docs/flow-control), [RabbitMQ memory
limits](https://www.rabbitmq.com/docs/memory)

A single RabbitMQ queue replica has a single-core hot path. RabbitMQ calls a
single-queue topology an anti-pattern and recommends multiple queues, or streams
and partitioned streams for workloads that reach queue throughput limits.
[RabbitMQ queue parallelism](https://www.rabbitmq.com/docs/queues#cpu-utilisation-and-parallelism-considerations),
[RabbitMQ super streams](https://www.rabbitmq.com/docs/streams#super-streams)

Quorum queues are the appropriate RabbitMQ queue type when replicated durability
is required. They use Raft and send state changes through the queue leader, which
replicates them to followers. More replicas add consensus work and generally
reduce throughput. Fast disks and measured prefetch settings matter.
[RabbitMQ quorum queues](https://www.rabbitmq.com/docs/quorum-queues#performance-characteristics),
[quorum queue leaders](https://www.rabbitmq.com/docs/quorum-queues#queue-leader-location)

For Osfo, one quorum queue would replace one PostgreSQL contention point with a
different single hot path. A broker-backed design should use multiple queues
with leaders distributed across nodes. A stable routing key can preserve an
entity's locality. RabbitMQ's modulus-hash exchange routes the same key to the
same queue and supports concurrent processing across queues. Changing the shard
count reshuffles most keys. [RabbitMQ modulus-hash exchange](https://www.rabbitmq.com/docs/modulus-hash-exchange)

## Ordering, fairness, and redelivery

RabbitMQ preserves enqueue and dequeue order under its documented conditions,
but multiple consumers and redelivery can change effective processing order.
Single Active Consumer preserves sequential processing, but it also reduces one
queue to one active delivery stream. RabbitMQ recommends multiple queues with a
stable entity key when order is required per entity but concurrency is required
across entities. [RabbitMQ message ordering](https://www.rabbitmq.com/docs/queues#message-ordering)

For Osfo, use `ThreadId` as the ordering key if broker partitioning is later
tested. PostgreSQL must still reject a second authoritative mutation when the
prior Thread position has not completed. Routing by `PrincipalId` alone can put
all work from a noisy Principal on one shard, but routing by `ThreadId` alone
does not implement principal-first fairness. Fairness therefore remains an
explicit scheduler or admission policy, not a property obtained from
round-robin broker consumers.

With manual acknowledgements, RabbitMQ automatically requeues unacknowledged
deliveries when a process, channel, connection, or TCP link fails. The next
consumer sees a redelivery indicator and may receive work another consumer
already started. Workers must remain idempotent. [RabbitMQ automatic
requeueing](https://www.rabbitmq.com/docs/confirms#automatic-requeueing)

The safe completion order is:

```text
receive broker delivery
        |
        v
acquire or validate PostgreSQL claim_epoch
        |
        v
perform remote work without a database connection
        |
        v
commit fenced PostgreSQL completion and ThreadEvents
        |
        v
acknowledge the RabbitMQ delivery
```

If a worker dies before acknowledgement, RabbitMQ redelivers. If PostgreSQL
committed but the acknowledgement was lost, the duplicate delivery is harmless
only because PostgreSQL completion is idempotent and fenced.

## Publication requires an outbox

PostgreSQL acceptance and RabbitMQ publishing are two independent durability
domains. RabbitMQ publisher confirms establish that the broker accepted
responsibility for a publication. They do not say that PostgreSQL committed the
AgentRun, or that a consumer completed it. Consumer acknowledgements are a
separate mechanism. [RabbitMQ publisher confirms](https://www.rabbitmq.com/docs/confirms#publisher-confirms)

Publishing directly after a PostgreSQL commit creates a lost-publication window.
Publishing before the commit creates a phantom-work window. If PostgreSQL
remains lifecycle authority, acceptance must insert an outbox row in the same
transaction as the AgentRun. A relay publishes committed outbox rows, waits for
publisher confirms, and records progress. Duplicate publications remain
possible, so stable message identity and idempotent consumers are required.
[AWS transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html),
[Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

```text
admission transaction
  AgentRun + receipt + outbox row
                 |
                 v
          outbox relay
                 |
          publisher confirm
                 |
                 v
       sharded quorum queues
                 |
          worker delivery
                 |
     fenced PostgreSQL completion
                 |
           consumer ack
```

## Recommendation

Keep PostgreSQL as both lifecycle authority and the initial runnable queue for
Osfo v1. First test changes to the exact global obligation counter, then validate
the topology on managed Cloud SQL. Adding RabbitMQ now would not address the
measured admission hotspot and would introduce a second replicated system,
outbox relay, acknowledgement state, redelivery policy, shard topology, and new
failure modes.

Open a broker migration experiment only when measurements isolate pending-row
discovery or claim traffic as the remaining bottleneck after admission
accounting is addressed. That experiment should compare:

1. PostgreSQL-only dispatch.
2. PostgreSQL acceptance plus transactional outbox.
3. Sharded RabbitMQ quorum queues with stable Thread routing.
4. Manual acknowledgement after fenced PostgreSQL completion.

Measure broker publish and confirm latency, ready and unacknowledged messages,
redelivery count, consumer capacity, shard skew, PostgreSQL admission and
completion latency, lock waits, end-to-end claim latency, fairness, and lost
authoritative acceptances. RabbitMQ exposes queue length, ingress and egress
rates, ready and unacknowledged states, and consumer counts for this purpose.
[RabbitMQ queue metrics](https://www.rabbitmq.com/docs/queues#metrics-and-monitoring)

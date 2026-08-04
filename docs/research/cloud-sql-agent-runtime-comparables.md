# Cloud SQL and agent-runtime comparables

Research date and source access date: 2026-08-04.

## Executive verdict

The evidence does not support the premise that two million logical messages per
day should, by itself, saturate PostgreSQL. Two million per day is 23.15 per
second on average. Fifty million per day is 578.70 per second on average. Google
documents no general Cloud SQL QPS ceiling. The missing quantity is the physical
work produced by each logical message.

```text
database work
  = logical messages
  x state transitions per message
  x SQL statements per transition
  x rows scanned or rewritten per statement
  x heap, index, JSON, WAL, vacuum, replica, and projection work
  x retry, polling, and burst-concurrency amplification
```

The strongest common pattern across Restate, Temporal, LangGraph, Deep Agents,
Inngest, DBOS, Hatchet, Trigger.dev, Prefect, and Discord is not a particular
database. It is separation of
workloads with different access and scaling behavior:

```text
small mutable current state
  + immutable ordered history
  + narrow dispatch records
  + bounded concurrency
  + payload or artifact offload
  + asynchronous search and visibility projections
  + explicit retention
```

That pattern points to a probable design correction, subject to local query
evidence:

- Keep `AgentRun` as the durable product and lifecycle identity.
- Stop treating one growing `AgentRun` row or cumulative checkpoint as the
  physical container for the transcript, task queue, recovery state, search
  model, and large tool outputs.
- Persist messages and events as immutable, ordered records.
- Persist a compact, bounded recovery snapshot separately, only as often as
  recovery needs require.
- Persist dispatch as a narrow task or outbox record with indexes limited to the
  claim path.
- Put large prompts, responses, tool output, files, and model payloads in object
  storage when they are not needed for transactional filtering. Keep an
  integrity-checked reference in PostgreSQL.
- Build dashboard, search, analytics, and observability views asynchronously.
- Bound producer and worker concurrency to measured database capacity.

This is a physical persistence split, not necessarily a domain split. Creating
more public concepts called `AgentRun` will not help. Moving messages to another
store while continuing to rewrite or checkpoint the same accumulated transcript
will add work, not remove it.

The immediate conclusion is therefore:

> Osfo is probably scaling the amount of work done per run transition, not the
> raw message primitive. Prove the exact multiplier before replacing Cloud SQL.

## Facts, inferences, and myths

### Proven by primary sources

1. Effective AI's multi-agent runtime article does not claim millions of
   messages or runs per day. Its only numerical production statement is that a
   request routinely spawns 10 to 20 agents. It describes bounded concurrency,
   cooperative yielding, notification coalescing, and durable completion
   delivery, but does not disclose its database, schema, throughput, retention,
   or partitioning.
2. LangChain's greater-than-one-billion-events-per-day claim is about LangSmith
   observability events. Self-hosted LangSmith separates trace data into
   ClickHouse, operational data into PostgreSQL, Redis into queues and cache, and
   large files into object storage. It is not a PostgreSQL agent-message claim.
3. Deep Agents deliberately changed message checkpointing from repeated full
   accumulated state to delta persistence because full snapshots grow from
   linear logical history into quadratic persisted bytes.
4. Discord does not store its authoritative message history in PostgreSQL. It
   moved from MongoDB to Cassandra, then to ScyllaDB. PostgreSQL is used for
   other Discord workloads.
5. Temporal separates event history, mutable execution state, dispatch,
   visibility, worker capacity, payload storage, and archival. Its PostgreSQL
   schema is not one ever-growing, richly indexed execution row.
6. Inngest moved its queue and live run state away from PostgreSQL. PostgreSQL
   holds configuration and historical read models. Redis also reached its own
   CPU and single-thread limits, proving that changing databases does not remove
   poor workload shape.
7. DBOS demonstrates that PostgreSQL can implement durable workflows and queues,
   but it uses separate tables, exact partial indexes for active work, bounded
   claims, `SKIP LOCKED`, adaptive polling, retention, and payload references.
8. Cloud SQL HA improves availability, not write throughput. Read replicas are
   read-only. Native PostgreSQL partitioning remains on one primary and one WAL
   stream.

### Local-applicable inferences that still need measurement

1. If Osfo serializes an accumulated transcript into every checkpoint or run
   update, persistence bytes can rise with cumulative thread length rather than
   message arrival rate.
2. If a frequently updated run or checkpoint row has several indexes and a low
   HOT-update ratio, one logical update can create a successor entry in every
   index, followed by WAL and vacuum work.
3. If a broad JSONB GIN index covers a growing state document, key extraction,
   pending-list maintenance, cleanup, and later reads can consume significant
   CPU.
4. If API replicas, workers, or pollers were scaled without a persistence
   admission limit, more application compute can worsen Cloud SQL saturation.
5. If queue polling returns empty often, or scans dead terminal work before
   finding claimable rows, statement count and rows examined can dominate at a
   modest logical event rate.
6. If search, UI listing, tracing, and execution all query the same hot tables,
   the product is forcing incompatible workloads through one primary.

### Myths and mismatches rejected

- **"Two million messages per day is inherently too much for PostgreSQL."** No.
  It is only 23.15 messages per second on average. Message size, burst ratio,
  statement count, row width, indexes, updates, scans, retries, and retention
  determine the work.
- **"Discord proves billions of messages fit in PostgreSQL."** No. Discord's
  authoritative message database is ScyllaDB, previously Cassandra.
- **"Effective AI handles millions of agent messages per day."** The cited
  article makes no such claim.
- **"LangSmith's one billion events per day means PostgreSQL handles one billion
  conversation rows."** No. They are observability events, and the trace plane is
  ClickHouse-backed.
- **"A read replica or HA standby scales the write path."** No.
- **"Partitioning gives Cloud SQL more writer CPU."** No. It can improve pruning,
  index locality, and retention operations inside the same primary.
- **"More connections increase throughput."** Not necessarily. They can increase
  runnable backend count, memory use, scheduler contention, and database load.
- **"More indexes are always faster."** Every index has write, WAL, cache, and
  cleanup cost.
- **"Every status update rewrites an unchanged large TOAST value."** PostgreSQL
  normally preserves an unchanged out-of-line value. Changing the transcript
  JSONB itself is different.
- **"100 percent CPU proves JSONB is the cause."** CPU saturation identifies a
  resource boundary, not the responsible query or background task.

## Decision frame

- **Target project:** Osfo v1 agent platform.
- **Current relevant stack:** Rust services, Cloud SQL for PostgreSQL 17,
  direct database-backed `AgentRun` admission and claim, and Temporal Cloud for
  workflow execution.
- **Domain:** durable conversational agents, child runs, tool calls, retries,
  resumable client delivery, and product-visible run history.
- **Scale question:** why Cloud SQL can reach 100 percent CPU at a modeled two
  million messages per day when other systems publish much larger-looking
  numbers.
- **Hard constraints:** correctness under retry and ambiguous commit, bounded
  overload, per-tenant fairness, durable ordering, recoverability, operational
  evidence, and a v1 scope appropriate for an interview exercise.
- **Key decision:** retain PostgreSQL while correcting amplification, or move a
  workload to a specialized store because measurements show a real single-primary
  limit.

## Ranked comparables

Scores use the seven criteria required by the comparables method. "Target fit"
means fit with Rust, PostgreSQL, Cloud SQL, and Temporal-adjacent deployment.

| Rank | Comparable | Domain fit | Target fit | Production maturity | Architecture clarity | Infrastructure and operations | Testing quality | Documentation signal | Total |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Restate | 5 | 5 | 3 | 5 | 5 | 5 | 5 | **33/35** |
| 2 | Temporal | 4 | 3 | 5 | 5 | 5 | 5 | 5 | **32/35** |
| 3 | Inngest | 5 | 1 | 5 | 4 | 5 | 5 | 5 | **30/35** |
| 4 | DBOS | 5 | 2 | 3 | 5 | 5 | 5 | 5 | **30/35** |
| 5 | LangGraph Agent Server | 5 | 2 | 4 | 5 | 4 | 4 | 5 | **29/35** |
| 6 | Hatchet | 5 | 3 | 3 | 5 | 5 | 4 | 4 | **29/35** |
| 7 | Trigger.dev | 5 | 1 | 4 | 4 | 5 | 4 | 5 | **28/35** |
| 8 | Prefect | 3 | 1 | 5 | 4 | 5 | 5 | 5 | **28/35** |
| 9 | Deep Agents | 5 | 2 | 3 | 4 | 3 | 4 | 5 | **26/35** |
| 10 | Dagster | 2 | 1 | 5 | 4 | 4 | 5 | 5 | **26/35** |
| 11 | Discord message platform | 2 | 3 | 5 | 4 | 5 | 2 | 3 | **24/35** |
| 12 | Effective AI runtime | 5 | 1 | 3 | 4 | 4 | 2 | 4 | **23/35** |

These scores do not rank product quality. They rank usefulness for the specific
Osfo decision. Restate wins as a Rust-native keyed-partition reference, while
Temporal exposes both mature architecture and PostgreSQL persistence. Discord is operationally mature but has
a different product, consistency model, hardware topology, and database.
Effective AI is highly relevant to orchestration semantics but publishes almost
no persistence evidence.

## Scale units must not be mixed

Published scale claims describe different work units.

| Source | Published unit | What it proves | What it does not prove |
|---|---:|---|---|
| Osfo model | 2M logical messages/day | About 23.15/s average before bursts and amplification | Database statements, bytes, or CPU per message |
| Poke | More than 100M bidirectional messages in three months | More than about 1.1M/day average at the product boundary | Runs/message, SQL shape, database technology, or peak load |
| Effective AI | 10 to 20 agents per request | Production multi-agent fan-out exists | Daily messages, QPS, or database capacity |
| Factory Missions | 778.5M tokens in one mission | Extremely large model context and cache use | Messages, database rows, or daily throughput |
| Letta/Bilt | More than 1M personalized agents | Logical agent cardinality | Concurrent runs or messages/day |
| LangSmith | More than 1B observability events/day | Large telemetry ingestion | PostgreSQL conversation storage |
| Discord, 2022 | 4B messages/day | About 46,296 sends/s average at global chat scale | PostgreSQL capability |
| Discord migration | Up to 3.2M messages/s | Bulk Cassandra-to-Scylla migration rate | Online message insert throughput |

The useful normalization is closer to:

```text
external message
  -> product runs created
  -> agent/model turns
  -> workflow transitions
  -> checkpoint writes
  -> queue claims and lease renewals
  -> durable events
  -> derived search and trace events
  -> SQL calls, affected rows, WAL bytes, and object-store bytes
```

Until that chain is measured, a message/day comparison is not a capacity model.

## Cross-system architecture pattern

The most mature comparables converge on this shape:

```text
Client or adapter
      |
      v
Admission and idempotency
      |
      +--> compact run identity and current lifecycle state
      +--> transactional outbox or durable task intent
                         |
                         v
                partitioned dispatch
                  bounded claim
                         |
                         v
                 capacity-aware worker
                         |
          +--------------+----------------+
          |              |                |
          v              v                v
  append event      update bounded    store large body
  or message        recovery state    or artifact
          |              |                |
          +--------------+----------------+
                         |
                         v
               async visibility/search
               retention and archival
```

The point is not service count. The point is that each box has one dominant
access path and bounded state.

## Comparable deep dives

### Temporal

Temporal is the strongest durable-execution comparable. It separates four server
services and several persistence responsibilities:

- History owns ordered workflow transitions and a compact mutable summary.
- Matching owns worker dispatch and task-queue partitions.
- Workers own application execution slots and poll only when they have capacity.
- Visibility owns searchable projections and can use another datastore.
- Object storage can own large payloads.
- Retention and archival bound closed execution history.

Its PostgreSQL schema uses separate tables for current execution identity,
mutable execution state, append-oriented history nodes, history topology,
matching tasks, internal immediate and scheduled tasks, and visibility. Primary
keys begin with routing dimensions such as `shard_id` or `range_hash`.

Concrete repository paths:

- [`schema/postgresql/v12/temporal/schema.sql`](https://github.com/temporalio/temporal/blob/a669256c743238702f29900100ce441f52a1d49f/schema/postgresql/v12/temporal/schema.sql)
- [`schema/postgresql/v12/visibility/schema.sql`](https://github.com/temporalio/temporal/blob/a669256c743238702f29900100ce441f52a1d49f/schema/postgresql/v12/visibility/schema.sql)
- [`docs/architecture/history-service.md`](https://github.com/temporalio/temporal/blob/a669256c743238702f29900100ce441f52a1d49f/docs/architecture/history-service.md)
- [`docs/architecture/matching-service.md`](https://github.com/temporalio/temporal/blob/a669256c743238702f29900100ce441f52a1d49f/docs/architecture/matching-service.md)
- [`common/persistence/sql/history_store.go`](https://github.com/temporalio/temporal/blob/a669256c743238702f29900100ce441f52a1d49f/common/persistence/sql/history_store.go)
- [`common/persistence/sql/execution.go`](https://github.com/temporalio/temporal/blob/a669256c743238702f29900100ce441f52a1d49f/common/persistence/sql/execution.go)
- [`service/history/shard/`](https://github.com/temporalio/temporal/tree/a669256c743238702f29900100ce441f52a1d49f/service/history/shard)
- [`service/history/queues/`](https://github.com/temporalio/temporal/tree/a669256c743238702f29900100ce441f52a1d49f/service/history/queues)
- [`service/matching/`](https://github.com/temporalio/temporal/tree/a669256c743238702f29900100ce441f52a1d49f/service/matching)

One transition can append history, update mutable state, and create internal
tasks. A transfer-task processor later delivers work to Matching, which is a
transactional outbox shape. Temporal therefore measures persistence requests by
service and operation, rather than pretending one workflow event equals one
database write.

Temporal has explicit history bounds: warnings at 10,240 events or 10 MB, hard
limits at 51,200 events or 50 MB, and Continue-As-New for long-lived work. Its
external-storage documentation specifically names long AI agent conversations
as a payload-growth case. The documented inline limit is 2 MB and the default
externalization threshold is 256 KiB. These values are Temporal's limits, not
automatic Osfo defaults, but the boundary is directly relevant.

Practices to emulate:

- Separate current state, immutable history, dispatch, visibility, and blobs.
- Make worker capacity part of dispatch.
- Rate-limit persistence by service or workload.
- Bound one execution segment and roll forward only necessary state.
- Measure event-history bytes and persistence operations, not only workflow
  count.

Practices not to copy for v1:

- An immutable cluster-wide shard count.
- Branching reset history and multi-cluster replication.
- Temporal's entire general-purpose workflow protocol.
- Preview external-storage behavior without an Osfo-owned lifecycle contract.

### Restate

Restate is the strongest Rust-native implementation comparable. It does not use
PostgreSQL as its hot state store. Its value is the shape of its consistency and
scaling boundary:

```text
ingress
  -> replicated Bifrost log
  -> keyed partition leader
       -> journal, invocation state, timers, and durable promises
       -> local RocksDB materialization
       -> bounded in-memory queue with disk spill
  -> object-store snapshot
  -> log trimming after safe materialization
```

Workflow IDs, object keys, and idempotency keys hash deterministically to
partitions. State and invocation lifecycle for one key remain partition-local,
and one active leader serializes that consistency domain. Followers and snapshots
support takeover and bounded reconstruction.

Relevant repository paths:

- [`crates/partition-store/`](https://github.com/restatedev/restate/tree/e80dfe702f256abe9f53711910caf73fba05c2fb/crates/partition-store)
- [`crates/bifrost/`](https://github.com/restatedev/restate/tree/e80dfe702f256abe9f53711910caf73fba05c2fb/crates/bifrost)
- [`crates/ingress-http/src/layers/load_shed.rs`](https://github.com/restatedev/restate/blob/e80dfe702f256abe9f53711910caf73fba05c2fb/crates/ingress-http/src/layers/load_shed.rs)
- [`crates/invoker-impl/src/quota.rs`](https://github.com/restatedev/restate/blob/e80dfe702f256abe9f53711910caf73fba05c2fb/crates/invoker-impl/src/quota.rs)

Restate has node-level token-bucket throttling, per-partition queue limits,
concurrent-invocation quotas, journal retention, snapshotting, and purge
controls. These show that the scalable primitive is a keyed execution partition,
not a database-wide scan over all runnable work.

The direct Osfo lesson is to keep one writer or serialized transition stream per
run while spreading independent runs across partitions or claim ranges. Copying
Restate's replicated log and RocksDB architecture would be excessive for v1.
Its stable-key routing, admission control, bounded journals, and snapshot
discipline are still high-value design references.

### LangGraph Agent Server

LangGraph separates assistant configuration, thread identity, run lifecycle,
checkpoint state, individual checkpoint writes, cross-thread memory, and
ephemeral streaming signals.

```text
Client
  -> API replica
  -> durable pending Run in PostgreSQL
  -> Redis wake signal
  -> worker leases Run
  -> graph super-steps
  -> PostgreSQL checkpoints and writes
  -> Redis PubSub stream
  -> SSE client
```

The official PostgreSQL saver has three important tables:

```text
checkpoints
  key: thread_id, checkpoint namespace, checkpoint_id
  metadata and channel versions in JSONB

checkpoint_blobs
  key: thread_id, namespace, channel, version
  serialized channel value

checkpoint_writes
  key: thread_id, namespace, checkpoint_id, task_id, index
  individual node output
```

Concrete paths:

- [`libs/checkpoint-postgres/langgraph/checkpoint/postgres/base.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-postgres/langgraph/checkpoint/postgres/base.py)
- [`libs/checkpoint-postgres/langgraph/checkpoint/postgres/__init__.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-postgres/langgraph/checkpoint/postgres/__init__.py)
- [`libs/checkpoint-postgres/langgraph/checkpoint/postgres/shallow.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-postgres/langgraph/checkpoint/postgres/shallow.py)

Unchanged channel versions reuse blobs. A conventional accumulated `messages`
list changes each turn, so each version can serialize the full list. A logical
user turn can also produce several graph super-step checkpoints. This makes
checkpoint count and cumulative thread length more informative than external
message count.

LangGraph offers `sync`, `async`, and `exit` durability. The trade is explicit:
persist before continuing, persist concurrently, or persist only the final
state. Agent Server scales API and worker pools independently, uses Redis for
ephemeral signals, and retains PostgreSQL as a shared durability boundary.
Adding workers therefore cannot fix expensive cumulative checkpoints.

The transferable lesson is to make checkpoint frequency and checkpoint shape a
product recovery decision. Persisting every internal super-step "because it is
available" can overwhelm the database without improving user-visible
durability.

### Deep Agents

Deep Agents is a harness on top of LangGraph, not a distinct durable database
runtime. That mismatch matters. Its value is the explicit fix for transcript
amplification.

`DeepAgentState.messages` uses a delta channel with a periodic snapshot, rather
than saving the complete accumulated message channel on every step. The source
states that the purpose is to reduce checkpoint growth from quadratic to linear.
Tests verify individual writes rather than repeated complete channel values.

Concrete paths:

- [`libs/deepagents/deepagents/graph.py`](https://github.com/langchain-ai/deepagents/blob/5f776b5882709b62332183b8cae6a1c71866b43a/libs/deepagents/deepagents/graph.py)
- [`libs/deepagents/tests/unit_tests/test_end_to_end.py`](https://github.com/langchain-ai/deepagents/blob/5f776b5882709b62332183b8cae6a1c71866b43a/libs/deepagents/tests/unit_tests/test_end_to_end.py)
- [`libs/deepagents/deepagents/middleware/filesystem.py`](https://github.com/langchain-ai/deepagents/blob/5f776b5882709b62332183b8cae6a1c71866b43a/libs/deepagents/deepagents/middleware/filesystem.py)
- [`libs/deepagents/deepagents/middleware/subagents.py`](https://github.com/langchain-ai/deepagents/blob/5f776b5882709b62332183b8cae6a1c71866b43a/libs/deepagents/deepagents/middleware/subagents.py)
- [`libs/deepagents/deepagents/middleware/async_subagents.py`](https://github.com/langchain-ai/deepagents/blob/5f776b5882709b62332183b8cae6a1c71866b43a/libs/deepagents/deepagents/middleware/async_subagents.py)

Its child-agent boundary is also useful. A synchronous child gets a focused task
context and returns one final tool result. An asynchronous child is an
independently addressable thread and run, while compact lifecycle metadata lives
in a dedicated task state channel. Child internal transcripts do not
automatically become parent canonical messages.

One critical warning transfers directly:

```text
evicted from model context
  is not the same as
removed from durable checkpoint state
```

Moving a large tool result into another field of the same checkpoint does not
offload database work. It must become an independent artifact or delta record,
with only a bounded reference in the hot state.

### Effective AI

The exact source recalled in prior local evidence is Suman Swaroop's
[How We Built a Multi-Agent Runtime](https://effectiveailabs.com/blog/multi-agent-runtime).
The current checkout no longer contains the reference, but it survives in local
snapshot commit `64e43606` at:

- `docs/research/agentrun-persistence-and-memory-plane-comparables.md`
- `docs/research/e2b-sandbox-persistence-and-agent-run-recovery.md`

The architecture consists of:

- Typed task input and declared output types.
- Parent agents that cooperatively yield instead of polling.
- E2B sandboxes that can pause while the agent waits.
- Completion events that wake the parent.
- Promise-style chain, all, and any composition.
- A bounded-concurrency pool.
- Notification groups that collapse many child completions into one parent wake.
- Shared or isolated compute selected per task.
- Durable completion delivery using an unspecified local store, atomic claims,
  retry, and exponential backoff.

This explains how Effective AI avoids wasted model turns, sandbox CPU, duplicate
work, and notification storms. It does not explain how a particular database
stores millions of messages. The database technology, event schema, QPS,
retention, payload size, and partitioning are not published.

Use this comparable to audit:

- polling amplification,
- wake-up amplification,
- unbounded child fan-out,
- sleeping agents that retain active compute,
- duplicate child work.

Do not use it to justify a database migration or a message-volume claim.

### Inngest

Inngest is the strongest comparable for high-volume event-driven execution. Its
architecture removes the queue and mutable live-run state from PostgreSQL:

```text
Event API -> event stream -> Runner -> Redis queue -> Executor
                                |             |
                                |             +-> incremental live checkpoints
                                v
                     PostgreSQL configuration,
                     history, traces, and API read model
```

Its queue uses logical per-function queues and higher-level sorted indexes to
find accounts and functions with available work. Shared-nothing workers lease
partitions briefly. Concurrency is charged to active steps, not sleeping runs.

Inngest has published hundreds of millions of events per day and more than
50,000 datastore operations per second. Its Redis cluster still reached CPU
limits. The response was to split a State Coordinator boundary, shard live state
by run ID, and separate constraint allocation from queue storage. This is useful
because it disproves the idea that Redis or another store makes access shape
irrelevant.

Pause indexes provide a concrete payload-offload pattern. Object storage holds
blocks of roughly 10,000 pauses, while Redis retains the indexes and leases.
Self-hosted PostgreSQL history requires retention work, and the repository warns
that events, history, traces, and spans otherwise grow without bound and damage
API and dashboard performance.

Concrete paths:

- [`pkg/execution/queue/`](https://github.com/inngest/inngest/tree/059dc2c476dfd23db4ff8df47f4548d510dec8f5/pkg/execution/queue)
- [`pkg/execution/state/redis_state/key_generator.go`](https://github.com/inngest/inngest/blob/059dc2c476dfd23db4ff8df47f4548d510dec8f5/pkg/execution/state/redis_state/key_generator.go)
- [`pkg/execution/driver/driver.go`](https://github.com/inngest/inngest/blob/059dc2c476dfd23db4ff8df47f4548d510dec8f5/pkg/execution/driver/driver.go)
- [`pkg/execution/pauses/block.go`](https://github.com/inngest/inngest/blob/059dc2c476dfd23db4ff8df47f4548d510dec8f5/pkg/execution/pauses/block.go)
- [`pkg/db/postgres/migrations/000001_baseline.sql`](https://github.com/inngest/inngest/blob/059dc2c476dfd23db4ff8df47f4548d510dec8f5/pkg/db/postgres/migrations/000001_baseline.sql)
- [`docs/POSTGRES_RETENTION.md`](https://github.com/inngest/inngest/blob/059dc2c476dfd23db4ff8df47f4548d510dec8f5/docs/POSTGRES_RETENTION.md)

Practices to emulate are active-step concurrency, short partition leases,
incremental checkpoints, explicit retention, and separate constraint allocation.
Do not copy the Redis topology for v1 unless Cloud SQL measurements prove that a
narrow PostgreSQL dispatch table cannot meet the target. Inngest's own evolution
shows that the replacement store becomes another scaling project.

### DBOS

DBOS is the counterexample to "PostgreSQL cannot run workflows." It implements
durable workflows and queues on PostgreSQL, but with carefully bounded
relational primitives:

- `workflow_status` is the compact current aggregate.
- Operation outputs, notifications, workflow events, and streams are separate
  child tables.
- Queue dequeue uses `READ COMMITTED` and `FOR UPDATE SKIP LOCKED`.
- Global concurrency and rate limiting use stronger isolation and `NOWAIT` only
  where required.
- The hot partial index matches active queue selection:

```sql
(queue_name, status, priority, created_at)
WHERE status IN ('ENQUEUED', 'PENDING')
```

- Empty polls are not committed, avoiding unnecessary WAL and transaction-ID
  churn.
- Pollers use jitter and adaptive contention backoff.
- Garbage collection protects active states and cascades through child tables.
- Large step outputs belong in object storage with pointers returned to the
  workflow.

Concrete paths:

- [`dbos/internal/sysdb/migrations/1_initial_dbos_schema.sql`](https://github.com/dbos-inc/dbos-transact-golang/blob/090b7451334e3813de989b2a5f89a91c2a04a92d/dbos/internal/sysdb/migrations/1_initial_dbos_schema.sql)
- [`dbos/queue.go`](https://github.com/dbos-inc/dbos-transact-golang/blob/090b7451334e3813de989b2a5f89a91c2a04a92d/dbos/queue.go)
- [`dbos/internal/sysdb/system_database.go`](https://github.com/dbos-inc/dbos-transact-golang/blob/090b7451334e3813de989b2a5f89a91c2a04a92d/dbos/internal/sysdb/system_database.go)
- [`dbos/_schemas/system_database.py`](https://github.com/dbos-inc/dbos-transact-py/blob/main/dbos/_schemas/system_database.py)
- [`tests/test_queue.py`](https://github.com/dbos-inc/dbos-transact-py/blob/main/tests/test_queue.py)

DBOS also states the boundary honestly: a Redis-backed queue may be more
appropriate when durability is unnecessary or throughput exceeds one PostgreSQL
server. This supports keeping the v1 direct queue only if its real access path is
narrow, bounded, and measured.

DBOS's April 2026 benchmark provides the most relevant first-party PostgreSQL
scale result found in this survey:

- 43,000 simple directly started workflows per second.
- 12,100 queued no-op workflows per second through one queue.
- 30,600 queued workflows per second after partitioning queue contention.
- Four database writes for one queued no-op workflow, with another checkpoint
  write for each additional workflow step.
- A 96-vCPU RDS PostgreSQL instance with 120,000 provisioned IOPS.

The hardware is far larger than an ordinary Cloud SQL v1 shape, and a no-op
workflow is smaller than an agent run. The benchmark still proves two important
points: disciplined PostgreSQL structures can exceed Osfo's modeled logical rate
by orders of magnitude, and queue arbitration can become the bottleneck even
with `SKIP LOCKED`. Queue partitioning changed the result because it reduced
contention, not because the public workflow primitive was renamed.

### Hatchet

Hatchet is a Postgres-first workflow runtime, but its production architecture is
not literally "only PostgreSQL." It uses:

- PostgreSQL as durable task, workflow, queue, and execution authority.
- Daily range partitions for large task and durable-event tables.
- Tenant partitions across controllers, schedulers, and workers.
- RabbitMQ or PostgreSQL for internal durable queues.
- NATS or RabbitMQ for pub/sub.
- PgBouncer and optional read replicas.
- External payload storage after a configurable inline period.
- Retention controllers and bounded offload batches.

Concrete paths:

- [`pkg/repository/sqlcv1/queue.sql`](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/pkg/repository/sqlcv1/queue.sql)
- [`pkg/repository/payloadstore.go`](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/pkg/repository/payloadstore.go)
- [`pkg/repository/sqlcv1/payload-store.sql`](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/pkg/repository/sqlcv1/payload-store.sql)
- [`internal/msgqueue/msgqueue.go`](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/internal/msgqueue/msgqueue.go)
- [`internal/services/partition/partition.go`](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/internal/services/partition/partition.go)
- [`20260313020631_v1_0_85_durable_event_log.sql`](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/cmd/hatchet-migrate/migrate/migrations/20260313020631_v1_0_85_durable_event_log.sql)

Hatchet defaults to keeping payloads inline briefly, then can move them to
external storage in bounded concurrent batches. It also batches broker writes.
The lesson is that Postgres-backed execution does not require every payload,
notification, queue signal, and historical record to live in the same
unpartitioned hot tables.

### Trigger.dev

Trigger.dev publishes one of the clearest workload splits:

```text
PostgreSQL
  run lifecycle and relational metadata

Redis
  queueing, fairness, and concurrency

ClickHouse
  task events, logs, spans, metrics, and high-volume projections

S3-compatible storage
  large payloads and outputs
```

Payloads and outputs larger than 512 KiB are offloaded. Production documentation
recommends ClickHouse for task events because an unbounded PostgreSQL event table
damages operational performance. Release history includes fixes for Redis lock
contention in large child batches, two-level tenant dispatch, queue-depth caps,
fairness across high-cardinality concurrency keys, excess dequeue commits, and
moving high-volume LLM metrics to ClickHouse.

Concrete paths:

- [`apps/webapp/app/runEngine/concerns/payloads.server.ts`](https://github.com/triggerdotdev/trigger.dev/blob/e8398d13be49866bfd9e3f2c2ecf41209dfbd109/apps/webapp/app/runEngine/concerns/payloads.server.ts)
- [`packages/redis-worker/src/fair-queue/`](https://github.com/triggerdotdev/trigger.dev/tree/e8398d13be49866bfd9e3f2c2ecf41209dfbd109/packages/redis-worker/src/fair-queue)
- [`internal-packages/database/prisma/schema.prisma`](https://github.com/triggerdotdev/trigger.dev/blob/e8398d13be49866bfd9e3f2c2ecf41209dfbd109/internal-packages/database/prisma/schema.prisma)
- [`internal-packages/clickhouse/schema/`](https://github.com/triggerdotdev/trigger.dev/tree/e8398d13be49866bfd9e3f2c2ecf41209dfbd109/internal-packages/clickhouse/schema)

Trigger.dev supports offloading large agent payloads and high-volume
observability. It does not prove that Osfo needs Redis or ClickHouse now. Its
architecture shows where those seams belong if PostgreSQL evidence later
justifies moving a workload.

### Prefect

Prefect uses a hybrid architecture:

- PostgreSQL stores orchestration state and scheduled flow runs.
- Redis carries event messaging and background-service coordination.
- API servers and background services scale independently.
- Workers poll work pools and queues.
- PostgreSQL work selection uses capacity calculations and `SKIP LOCKED`.
- Events move through a message bus into a bounded, batched PostgreSQL persister.
- Serialized results belong in S3, GCS, Azure Blob Storage, or shared storage.
- Event retention is short by default and can be reduced for high-volume
  installations.

Concrete paths:

- [`get-runs-from-worker-queues.sql.jinja`](https://github.com/PrefectHQ/prefect/blob/c0e4c1b6c5dc6ffaa91c4f5afc31fa9664b2abcf/src/prefect/server/database/sql/postgres/get-runs-from-worker-queues.sql.jinja)
- [`event_persister.py`](https://github.com/PrefectHQ/prefect/blob/c0e4c1b6c5dc6ffaa91c4f5afc31fa9664b2abcf/src/prefect/server/events/services/event_persister.py)
- [`db_vacuum.py`](https://github.com/PrefectHQ/prefect/blob/c0e4c1b6c5dc6ffaa91c4f5afc31fa9664b2abcf/src/prefect/server/services/db_vacuum.py)

The transferable lesson is that event retention and artifact storage are runtime
design decisions, not deferred database housekeeping.

### Dagster

Dagster separates run coordination, run launch, run workers, and executors.
PostgreSQL stores run, event-log, and scheduling state, while object storage can
hold operation outputs. Its queue is at whole-pipeline-run granularity, and the
open-source deployment has a single daemon replica, so it is a weaker direct
throughput analogue.

Concrete paths:

- [`docs/docs/deployment/oss/oss-deployment-architecture.md`](https://github.com/dagster-io/dagster/blob/ac6519e1090f879cec64f579e27bf6de94ea60c4/docs/docs/deployment/oss/oss-deployment-architecture.md)
- [`queued_run_coordinator_daemon.py`](https://github.com/dagster-io/dagster/blob/ac6519e1090f879cec64f579e27bf6de94ea60c4/python_modules/dagster/dagster/_daemon/run_coordinator/queued_run_coordinator_daemon.py)
- [`python_modules/libraries/dagster-postgres/`](https://github.com/dagster-io/dagster/tree/ac6519e1090f879cec64f579e27bf6de94ea60c4/python_modules/libraries/dagster-postgres)

Its warning that excessive logging overloads event-log storage maps closely to
agent token, progress, and trace persistence. Not every internal runtime signal
should be a forever-retained canonical event.

### Discord

Discord is a valuable extreme-scale message comparable and a poor PostgreSQL
capacity comparable.

```text
MongoDB
  -> data and index stopped fitting RAM at about 100M stored messages
  -> Cassandra
       partition: channel_id + time bucket
       order: Snowflake message_id
  -> hot partitions, compaction backlog, tombstones, GC, repair toil
  -> ScyllaDB
       same query-shaped data model
       plus Rust data service, consistent routing, request coalescing
  -> asynchronous Pub/Sub and Elasticsearch search cells
```

The 2017 Cassandra model bounded a channel partition by time, targeting about ten
days and less than 100 MB per bucket. Snowflake IDs supplied identity, order, and
cursor semantics. They did not solve distribution because a popular channel's
current bucket could still be hot.

The 2023 architecture added a Rust data service between the API and database.
Requests were consistently routed by channel ID. Identical concurrent reads were
coalesced so one database query served many callers. Discord explicitly retained
this protection after moving to ScyllaDB because a better engine does not remove
hot keys.

Search is a derived system. Messages are queued and bulk-indexed. Elasticsearch
holds fields and IDs needed for search, while the authoritative message and
context come from the message database. The 2025 system uses durable Pub/Sub,
cells, query-specific sharding, batching by destination, and special handling
for exceptionally large guilds.

Discord's scale is backed by a radically different footprint: 177 Cassandra
nodes before migration, 72 Scylla nodes after migration, custom storage topology,
and later dozens of Scylla clusters with hundreds of nodes. The public migration
rate of 3.2 million messages per second was bulk migration, not normal sends.

Relevant public paths, with a major caveat that Discord's final Rust migrator
and production data service are private:

- [`discord/scylla-migrator/src/main/scala/com/scylladb/migrator/Migrator.scala`](https://github.com/discord/scylla-migrator/blob/discord/src/main/scala/com/scylladb/migrator/Migrator.scala)
- [`discord/scylla-migrator/src/main/scala/com/scylladb/migrator/Validator.scala`](https://github.com/discord/scylla-migrator/blob/discord/src/main/scala/com/scylladb/migrator/Validator.scala)
- [`discord/scylla-migrator/readers/Cassandra.scala`](https://github.com/discord/scylla-migrator/blob/discord/src/main/scala/com/scylladb/migrator/readers/Cassandra.scala)
- [`discord/scylla-migrator/writers/Scylla.scala`](https://github.com/discord/scylla-migrator/blob/discord/src/main/scala/com/scylladb/migrator/writers/Scylla.scala)

The lesson to copy is the constraint stack, not ScyllaDB:

```text
append-oriented atomic record
+ ordered stable ID
+ query-derived bounded partition
+ narrow range read
+ upstream concurrency control
+ request coalescing
+ asynchronous derived indexes
+ explicit outlier isolation
+ mature retention, compaction, migration, and validation
```

## PostgreSQL and Cloud SQL mechanics

### What Cloud SQL CPU proves

`database/cpu/utilization` is the fraction of reserved CPU in use. It is sampled
every 60 seconds and can appear with delay. A value near 100 percent proves the
reserved cores were saturated during the sample. It does not identify the query
or background operation.

Query Insights' "CPU and CPU Wait" is different. It combines time executing
with time a PostgreSQL backend waits for the Linux scheduler. It can exceed the
core-capacity line. I/O, locks, lightweight locks, and buffer-pin waits are
separate categories. PostgreSQL also treats backend `state` and `wait_event` as
independent. An active query can be blocked.

Interpretation:

| Evidence | Supported diagnosis |
|---|---|
| CPU near 100%, low I/O and lock wait, few dominant statements | Query CPU or scheduler saturation |
| CPU/CPU-wait well above cores, many active backends | Oversubscription and runnable-process pressure |
| High I/O wait and disk demand near limits | Storage, cache misses, scans, or temporary spills |
| High Lock, LWLock, or BufferPin wait | Hot row, long transaction, or shared-structure contention |
| Provider CPU not explained by client queries | Autovacuum, checkpoint, WAL, extension, or other background work |

### MVCC, HOT updates, and index multiplication

Every PostgreSQL update creates a new row version. A HOT update avoids successor
entries in indexes only when no indexed column changes and the old heap page has
space. Lower table `fillfactor` can reserve room and improve HOT eligibility.

When HOT is unavailable, PostgreSQL can create a successor tuple in every index
on the table, including indexes whose logical keys did not change. One status or
lease update can therefore become:

```text
new heap tuple
  + N index successor tuples
  + heap and index WAL
  + possible full-page images
  + dead tuple
  + later heap and index vacuum work
```

The decisive measurements are `n_tup_upd`, `n_tup_hot_upd`,
`n_tup_newpage_upd`, `n_dead_tup`, index count, and WAL per call. A low HOT ratio
on a frequently updated run or task table is direct evidence of avoidable
amplification.

### JSONB and GIN

JSONB is not inherently wrong. It is wrong when its physical costs conflict with
the hot access path.

- JSONB input is decomposed and costs more to ingest than raw JSON.
- Updating a large JSON document locks and updates the containing row.
- A broad GIN index extracts many document keys and values.
- One heap write can cause many GIN inserts.
- GIN's pending list defers maintenance, but a large pending list can slow reads
  and foreground cleanup can create latency and CPU spikes.
- Targeted expression indexes can be smaller, but their expressions are
  recomputed for inserts and non-HOT updates.
- Partial indexes reduce active working-set size only if the query predicate
  matches in a form the planner can prove.

Frequently filtered lifecycle fields should be typed columns. A whole-payload
GIN index should exist only when measured containment queries justify its write
cost.

Important caveat: unchanged out-of-line TOAST values are normally preserved
during unrelated updates. A status change does not automatically rewrite an
unchanged payload. An update that changes the accumulated transcript does change
the value and is a different case.

### WAL and checkpoints

The first modification to a page after a checkpoint normally includes a
full-page image in WAL. Frequent checkpoints can therefore increase WAL and I/O.
WAL compression reduces bytes at the cost of CPU.

`pg_stat_statements` exposes calls, elapsed time, rows, shared and temporary
blocks, WAL records, full-page images, WAL bytes, and WAL-buffer-full counts. It
does not expose CPU time. Its execution time includes waiting and must be aligned
with Query Insights and provider CPU.

Useful normalized measures are:

```text
calls per logical message
transactions per logical message
rows read or affected per call
shared blocks per call
WAL bytes per call
WAL bytes per logical message
checkpoint records per user turn
```

### Autovacuum and retention

Updates and deletes leave dead row versions. Vacuum makes their space reusable,
but normally does not return it to the operating system. Several eligible large
tables can occupy all autovacuum workers, delaying cleanup elsewhere. Adding
workers does not automatically multiply the global cost budget. Long or idle
transactions can retain old snapshots and prevent cleanup.

This is why every strong comparable has retention or execution rollover. An
unbounded event, trace, checkpoint, or terminal-run table is an operational bug,
not merely a future storage-cost issue.

### Connections and admission control

PostgreSQL uses one backend process per connection. Cloud SQL recommends
reusing fewer connections. A pool controls connection churn and active
concurrency, but cannot remove expensive SQL or write amplification.

Cloud SQL managed pooling is Enterprise Plus-only and normally uses transaction
pooling, which is incompatible with session-scoped features such as `LISTEN`,
session advisory locks, ordinary session `SET`, and some temporary-table and
cursor behavior. Application pooling remains the most predictable v1 boundary.

The pool-size invariant must cover the whole fleet:

```text
API replicas x API pool
+ worker replicas x worker pool
+ pollers and maintenance
+ operational reserve
< safe server connection and active-query capacity
```

### Replicas, HA, partitioning, and machine size

- HA is one active primary plus a failover standby. Writes are synchronously
  replicated for availability. HA does not double write capacity.
- Read replicas can offload stale-tolerant reads and analytics. Cloud SQL does
  not automatically load-balance ordinary replicas.
- Read pools can scale eligible reads on Enterprise Plus, but freshness is not
  the routing criterion. Stale and non-monotonic reads must be acceptable.
- Native partitions are ordinary PostgreSQL tables inside one instance. They
  improve pruning, index locality, and bulk retention, but do not add writer
  cores or a WAL stream.
- More vCPUs help genuinely parallel CPU work. They do not remove a hot row,
  serial lock, bad plan, repeated wide-row rewrite, or chatty poller. More
  producers can simply fill the larger machine again.
- More disk or IOPS helps only when I/O wait and provisioned storage limits are
  the real boundary.

## What is most likely failing

External research cannot prove the local cause without the local interval and
schema. It can rank hypotheses.

### Highest-priority hypotheses

1. **Cumulative checkpoint or transcript amplification.** Deep Agents exists in
   its current form partly because full message snapshots create quadratic
   checkpoint growth. Measure persistence bytes and CPU against thread length.
2. **Too many persistence transitions per logical message.** A single external
   message can create root and child runs, joins, tool calls, lease updates,
   heartbeats, history rows, stream events, traces, and projections.
3. **A mutable, over-indexed hot aggregate.** Low HOT ratio and many indexes can
   multiply every run status or lease update.
4. **Database polling and empty claims.** A queue can spend more work discovering
   that nothing is runnable than processing accepted work.
5. **Unbounded worker and connection concurrency.** Scaling API or execution
   replicas without a database admission limit can saturate the primary.
6. **Operational and visibility reads sharing the write primary.** Listing,
   search, traces, and dashboards can evict hot execution pages or demand broad
   indexes.
7. **Vacuum and retention debt.** High update and delete volume creates cleanup
   work even when the live logical row count looks small.

### Lower-priority until evidence appears

- Raw append-only message insert count.
- The absence of a broker by itself.
- Cloud SQL storage size by itself.
- PITR by itself.
- A need for Cassandra or ScyllaDB at 23 average messages per second.
- A need for a read replica to improve authoritative claims.

## Required evidence packet

The database cause is proven only by an aligned saturation interval containing:

1. Cloud SQL CPU utilization and CPU-seconds.
2. Query Insights load split among CPU/CPU-wait, I/O, Lock, LWLock, and
   BufferPin.
3. `pg_stat_statements` interval deltas for calls, elapsed time, rows, shared
   blocks, temporary blocks, WAL records, full-page images, and WAL bytes.
4. Representative `EXPLAIN (ANALYZE, BUFFERS, WAL)` for message append,
   current-state load, run transition, queue claim, lease renewal, and terminal
   completion. Data-changing plans must run in a safe transaction that is rolled
   back.
5. Complete schema and index inventory for run, message, event, task, outbox,
   join, checkpoint, and visibility tables.
6. Table and index sizes, including TOAST.
7. `n_tup_upd`, `n_tup_hot_upd`, `n_tup_newpage_upd`, dead tuples, vacuum times,
   and oldest transaction age.
8. Backend counts by application and state, new-connection rate, and the fleet
   pool-size sum.
9. Logical product counters in the same interval: external messages, runs,
   children, model turns, tool calls, workflow transitions, checkpoints,
   streams, retries, and claimed tasks.
10. Histograms by thread or run length, payload bytes, checkpoint bytes, and SQL
    work. A rising cost with cumulative thread length is the key signal for
    aggregate amplification.

The first diagnostic table should be:

| Normalized quantity | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| AgentRuns per external message | | | | |
| Workflow transitions per AgentRun | | | | |
| SQL statements per transition | | | | |
| Checkpoints per model turn | | | | |
| PostgreSQL bytes written per message | | | | |
| WAL bytes per message | | | | |
| Rows scanned per queue claim | | | | |
| Empty polls per claimed task | | | | |
| Index tuples created per run update | | | | |
| CPU-seconds per 1,000 messages | | | | |

## Recommended local persistence shape

### Primitive ownership

```text
agent
  durable identity and configuration

agent_run
  bounded execution segment
  owner, status, admission, lifecycle timestamps, outcome, pointers

agent_message
  immutable user-visible message metadata
  run_id, monotonic sequence, role/type, bounded inline body or payload_id

agent_event
  immutable domain and recovery transition
  do not retain token-level noise forever by default

execution_task
  narrow dispatchable work item
  active-state partial index, bounded lease and retry metadata

run_snapshot
  compact current recovery state
  periodic or transition-driven, never a full transcript per token

payload
  object reference, size, content type, digest, encryption and retention metadata

outbox
  transactionally-created delivery intent

run_visibility
  asynchronously maintained list/search projection

operational_trace
  sampled or short-retained observability, not canonical history
```

### PostgreSQL remains appropriate for v1 when

- the hot queue and lifecycle rows are narrow,
- writes are append-oriented or HOT-friendly,
- active-state indexes are small and query-specific,
- large bodies do not participate in queue and lifecycle scans,
- polling is adaptive and bounded,
- worker and connection concurrency is capped,
- retention keeps history and traces bounded,
- measured peak transition throughput has headroom.

### Move a workload only when

- object storage removes measured large-payload churn,
- a read/search projection has a stale-tolerant independent scaling need,
- dispatch measurements prove one PostgreSQL primary cannot meet the required
  transition rate after query and amplification fixes,
- a stable partition key and query model justify sharding,
- the team accepts dual-write, replay, reconciliation, migration, and operational
  costs.

Do not introduce ScyllaDB, Cassandra, Redis, or a broker as a substitute for
knowing which operation consumes CPU.

## Options

| Option | Score | When to choose | Main risk | First slice |
|---|---:|---|---|---|
| A. Retain Cloud SQL, split physical primitives, fix amplification | **9/10** | Default for v1 and whenever one primary has measured headroom after correction | Requires careful migration and dual-read validation | Add normalized counters, isolate append-only messages/events, narrow the task claim path |
| B. Retain Cloud SQL for truth, move blobs and derived reads | **8/10** | Large payloads, search, traces, or dashboards dominate | Lifecycle and retention coordination across stores | Object-store claim check plus asynchronous visibility projection |
| C. Introduce a dedicated broker or distributed state store | **5/10 now** | Only after corrected Cloud SQL dispatch still fails the target, or independent scaling is a hard requirement | More failure modes, reconciliation, operations, and cost | Shadow publish and replay validation without changing authority |

## Final recommendation

Choose Option A now, with the payload and visibility portions of Option B where
evidence supports them.

The most defensible sequence is:

1. Capture the aligned evidence packet and compute physical work per message.
2. Verify whether cost rises with accumulated run or thread length.
3. Preserve `AgentRun` as the domain execution identity, but remove transcript,
   dispatch, large payload, and broad visibility responsibilities from its hot
   physical row.
4. Convert messages and durable events to append-only ordered records.
5. Make checkpoints delta-based or periodic bounded snapshots.
6. Make the task claim query narrow, partial-indexed, bounded, and adaptively
   polled.
7. Bound total application connections and active database work across the
   fleet.
8. Apply retention to terminal runs, internal events, checkpoints, and traces.
9. Repeat the production-shaped load test and compare CPU-seconds, WAL bytes,
   SQL calls, and database p95 per 1,000 external messages.
10. Consider a broker or distributed store only if the corrected design still
    misses the required peak with insufficient headroom.

What would invalidate this recommendation:

- Evidence that the hot path is already narrow, append-only, HOT-friendly,
  minimally indexed, non-polling, and bounded, yet genuine parallel query CPU
  still saturates a correctly sized primary.
- A product requirement for multi-region active-active writes.
- A sustained peak beyond one primary's measured write and WAL capacity after
  amplification correction.
- A mandatory query model that cannot be expressed as bounded PostgreSQL access
  without broad scans or prohibitive indexes.

## Sources

All web sources were accessed 2026-08-04.

### Effective AI and scale-unit corrections

- Effective AI, [How We Built a Multi-Agent Runtime](https://effectiveailabs.com/blog/multi-agent-runtime).
- Cognition, [Poke interaction architecture and message figure](https://cognition.com/blog/interaction).
- Factory, [Missions architecture](https://factory.ai/news/missions-architecture).
- LangChain, [Company and LangSmith scale](https://www.langchain.com/about).
- Letta, [Bilt case study](https://www.letta.com/case-studies/bilt/).

### LangGraph and Deep Agents

- LangGraph, [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence).
- LangGraph, [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers).
- LangGraph, [Agent Server](https://docs.langchain.com/langsmith/agent-server).
- LangGraph, [Data plane](https://docs.langchain.com/langsmith/data-plane).
- LangGraph, [Agent Server scaling](https://docs.langchain.com/langsmith/agent-server-scale).
- LangGraph, [Scalability and resilience](https://docs.langchain.com/langsmith/scalability-and-resilience).
- LangGraph, [Configure a checkpointer](https://docs.langchain.com/langsmith/configure-checkpointer).
- LangChain, [Frameworks, runtimes, and harnesses](https://www.langchain.com/blog/agent-frameworks-runtimes-and-harnesses-oh-my).
- Deep Agents, [Async subagents](https://docs.langchain.com/oss/python/deepagents/async-subagents).

### Temporal

- Temporal, [Server concepts](https://docs.temporal.io/temporal-service/temporal-server).
- Temporal, [Persistence](https://docs.temporal.io/temporal-service/persistence).
- Temporal, [History shards](https://docs.temporal.io/temporal-service/temporal-server#history-shard).
- Temporal, [Task Queue ordering and partitions](https://docs.temporal.io/task-queue#task-ordering).
- Temporal, [Worker performance](https://docs.temporal.io/develop/worker-performance).
- Temporal, [Worker tuning](https://docs.temporal.io/develop/worker-tuning-reference).
- Temporal, [Worker production practices](https://docs.temporal.io/best-practices/worker).
- Temporal, [External Storage](https://docs.temporal.io/external-storage).
- Temporal, [Payload limits](https://docs.temporal.io/troubleshooting/blob-size-limit-error).
- Temporal, [Workflow limits](https://docs.temporal.io/workflow-execution/limits).
- Temporal, [Visibility](https://docs.temporal.io/self-hosted-guide/visibility).
- Temporal, [Archival](https://docs.temporal.io/self-hosted-guide/archival).
- Temporal, [Persistence QPS configuration](https://docs.temporal.io/references/dynamic-configuration#qps-limits-for-persistence-store).
- Temporal, [Cluster metrics](https://docs.temporal.io/references/cluster-metrics).

### Production workflow runtimes

- Inngest, [Self-hosting architecture](https://www.inngest.com/docs/self-hosting).
- Inngest, [Queue fairness design](https://www.inngest.com/blog/building-the-inngest-queue-pt-i-fairness-multi-tenancy).
- Inngest, [Sharding](https://www.inngest.com/blog/sharding-at-inngest).
- Inngest, [Constraint API](https://www.inngest.com/blog/announcing-the-constraint-api).
- Inngest, [Concurrency](https://www.inngest.com/docs/guides/concurrency).
- Inngest, [Limits and retention](https://www.inngest.com/docs/usage-limits/inngest).
- DBOS, [Architecture](https://docs.dbos.dev/architecture).
- DBOS, [System database](https://docs.dbos.dev/explanations/system-tables).
- DBOS, [Queues and concurrency](https://docs.dbos.dev/python/tutorials/queue-tutorial).
- DBOS, [Kubernetes deployment](https://docs.dbos.dev/production/hosting-with-kubernetes).
- DBOS, [Benchmarking workflow execution scalability on PostgreSQL](https://www.dbos.dev/blog/benchmarking-workflow-execution-scalability-on-postgres).
- Restate, [Architecture](https://docs.restate.dev/references/architecture).
- Restate, [Server configuration](https://docs.restate.dev/references/server-config).
- Restate, [Snapshots and log trimming](https://docs.restate.dev/server/snapshots).
- Restate, [Retention](https://docs.restate.dev/services/configuration).
- Hatchet, [Self-hosting configuration and retention](https://github.com/hatchet-dev/hatchet/blob/4d8e4d77b746903c0e4068911ad90c25294997e1/frontend/docs/pages/self-hosting/configuration-options.mdx).
- Trigger.dev, [Self-hosted architecture](https://trigger.dev/docs/self-hosting/overview).
- Trigger.dev, [Kubernetes dependencies](https://trigger.dev/docs/self-hosting/kubernetes).
- Trigger.dev, [Queue concurrency](https://trigger.dev/docs/queue-concurrency).
- Trigger.dev, [Payload limits](https://trigger.dev/docs/limits).
- Prefect, [Scaling self-hosted Prefect](https://docs.prefect.io/v3/advanced/self-hosted).
- Prefect, [Result persistence](https://docs.prefect.io/v3/advanced/results).
- Prefect, [Database maintenance](https://docs.prefect.io/v3/advanced/database-maintenance).
- Dagster, [GCP storage topology](https://github.com/dagster-io/dagster/blob/ac6519e1090f879cec64f579e27bf6de94ea60c4/docs/docs/deployment/oss/deployment-options/gcp.md).

### Discord

- Discord, [How Discord Stores Billions of Messages](https://discord.com/blog/how-discord-stores-billions-of-messages).
- Discord, [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages).
- Discord, [How Discord Indexes Billions of Messages](https://discord.com/blog/how-discord-indexes-billions-of-messages).
- Discord, [How Discord Indexes Trillions of Messages](https://discord.com/blog/how-discord-indexes-trillions-of-messages).
- Discord, [How Discord Supercharges Network Disks](https://discord.com/blog/how-discord-supercharges-network-disks-for-extreme-low-latency).
- Discord, [How Discord Automates ScyllaDB Clusters](https://discord.com/blog/how-discord-automates-scylladb-clusters-at-scale).
- Discord API, [Snowflakes](https://docs.discord.com/developers/reference#snowflakes).

### PostgreSQL

- PostgreSQL, [JSON types and JSONB indexing](https://www.postgresql.org/docs/current/datatype-json.html).
- PostgreSQL, [GIN indexes](https://www.postgresql.org/docs/current/gin.html).
- PostgreSQL, [Indexes](https://www.postgresql.org/docs/current/indexes.html).
- PostgreSQL, [Expression indexes](https://www.postgresql.org/docs/current/indexes-expressional.html).
- PostgreSQL, [Partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html).
- PostgreSQL, [Heap-Only Tuples](https://www.postgresql.org/docs/current/storage-hot.html).
- PostgreSQL, [B-tree deletion](https://www.postgresql.org/docs/current/btree.html#BTREE-DELETION).
- PostgreSQL, [TOAST](https://www.postgresql.org/docs/current/storage-toast.html#STORAGE-TOAST-ONDISK).
- PostgreSQL, [WAL configuration](https://www.postgresql.org/docs/current/wal-configuration.html).
- PostgreSQL, [`wal_compression`](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-WAL-COMPRESSION).
- PostgreSQL, [`pg_stat_statements`](https://www.postgresql.org/docs/current/pgstatstatements.html).
- PostgreSQL, [Routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html).
- PostgreSQL, [Cumulative statistics and wait events](https://www.postgresql.org/docs/current/monitoring-stats.html).
- PostgreSQL, [Connection architecture](https://www.postgresql.org/docs/current/tutorial-arch.html).
- PostgreSQL, [`max_connections`](https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-MAX-CONNECTIONS).
- PostgreSQL, [Table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html).
- PostgreSQL, [`EXPLAIN`](https://www.postgresql.org/docs/current/sql-explain.html).

The PostgreSQL deployment under study is version 17. The linked `current`
manual is version 18 on the access date. Fields and behavior used in a production
evidence query must be checked against PostgreSQL 17 before execution.

### Google Cloud SQL for PostgreSQL

- Google Cloud, [Cloud SQL FAQ and QPS limits](https://docs.cloud.google.com/sql/docs/postgres/faq).
- Google Cloud, [Cloud SQL metrics](https://docs.cloud.google.com/sql/docs/postgres/admin-api/metrics).
- Google Cloud, [Query Insights](https://docs.cloud.google.com/sql/docs/postgres/using-query-insights).
- Google Cloud, [Manage database connections](https://docs.cloud.google.com/sql/docs/postgres/manage-connections).
- Google Cloud, [Managed Connection Pooling](https://docs.cloud.google.com/sql/docs/postgres/managed-connection-pooling).
- Google Cloud, [Quotas and limits](https://docs.cloud.google.com/sql/docs/postgres/quotas).
- Google Cloud, [High availability](https://docs.cloud.google.com/sql/docs/postgres/high-availability).
- Google Cloud, [Replication and read replicas](https://docs.cloud.google.com/sql/docs/postgres/replication).
- Google Cloud, [Read pools](https://docs.cloud.google.com/sql/docs/postgres/about-read-pools).
- Google Cloud, [Storage options](https://docs.cloud.google.com/sql/docs/postgres/storage-options-overview).
- Google Cloud, [Supported extensions and `pg_partman`](https://docs.cloud.google.com/sql/docs/postgres/extensions#pg_partman).

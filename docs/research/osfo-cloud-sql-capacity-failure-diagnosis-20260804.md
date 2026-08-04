# Why Osfo saturates Cloud SQL, and what to change

Date: 2026-08-04  
Status: evidence-backed diagnosis and architecture recommendation  
Scope: all Wayfinder issues through #22, both prototypes, committed research and ADRs, the take-home brief and checkpoints, production evidence captured for issues #13, #20, and #21, and external comparable systems.

## Executive conclusion

Osfo has not demonstrated that PostgreSQL cannot support 2 million incoming messages per day. It has demonstrated that one particular topology and one contaminated load test can saturate one Cloud SQL primary.

The final issue #21 target run is not a clean capacity result:

1. The test target was 232 incoming messages per second, not the daily average of 23.15 per second.
2. Cloud SQL was already at approximately 100 percent CPU before the target stage started.
3. A new exact-capacity implementation put global and per-Principal slot allocation on every AgentRun admission and terminal transition.
4. Cloud Run could open at most 448 connections from the configured application pools, but Cloud SQL reported approximately 696 backends. At least 248 sessions were outside the declared pool budget.
5. After the offer interval, the load generator issued per-run evidence queries with concurrency 128 against the same OLTP primary. One correlated evidence query dominated the captured database execution-time signal.
6. The database retained the results of prior test stages. The root-run identifier range was roughly twice that of the earlier clean 232/s confirmation, but the test did not capture enough table, index, vacuum, or query-plan evidence to distinguish corpus growth from the other regressions.

The earlier issue #20 run accepted and completed all 13,920 offered messages at 232/s. It drained in 1.10 seconds, had a 430 ms authoritative completion p95, and recorded 27.9 percent peak Cloud SQL CPU. That result and the issue #21 result use the same broad direct-dispatch architecture. The difference means the architectural primitive alone cannot explain the regression.

The immediate problem is a combination of measurement contamination, admission write and lock amplification, connection amplification, and mixed OLTP and evidence workloads. The longer-term problem is that hot lifecycle state, dispatch, durable history, large payloads, visibility, and test reconciliation do not yet have explicit physical isolation and retention budgets.

## The arithmetic that frames the question

| Rate | Average logical messages per second |
|---|---:|
| 2 million per day | 23.15 |
| Osfo 10x peak target | 231.48, rounded to 232 |
| 50 million per day | 578.70 |
| Discord's published 4 billion per day | 46,296.30 |

Osfo's 232/s test is therefore a peak test equivalent to approximately 20 million messages per day if sustained continuously. It is not a 2 million/day test.

One Osfo message is also not one database insert. The live Luna planning sample measured:

- 1.5 total AgentRuns per incoming message
- 0.357 Temporal workflows per message
- 0.286 quick replies per message
- 0.071 tools and approvals per message
- 0.214 proactive messages per message
- at least two user-visible ThreadEvents for the normal request and response path

At 232 incoming messages/s, the measured mix implies approximately 348 AgentRuns/s before counting every state transition, queue claim, retry, sequence allocation, capacity lease, ChildJoin, model call, tool call, workflow, stream read, and evidence query.

The useful capacity denominator is therefore:

```text
incoming messages/s
  x AgentRuns/message
  x durable transitions/AgentRun
  x SQL operations/transition
  x rows and index entries touched/operation
  x retry, polling, stream, and reporting amplification
```

## What the Wayfinder work decided

The ticket set is internally coherent. The important decisions are:

- [#1](https://github.com/heyimcarlos/osfo/issues/1): ThreadEvent is the durable ordered log. PostgreSQL is lifecycle authority and the initial runnable queue. Temporal owns only independently durable workflows.
- [#2](https://github.com/heyimcarlos/osfo/issues/2): each Thread has a monotonic ThreadPosition, ThreadEvents are immutable, and assistant output is persisted before delivery.
- [#3](https://github.com/heyimcarlos/osfo/issues/3) and [#4](https://github.com/heyimcarlos/osfo/issues/4): durable resume is above transport. Native transport is HTTP commands plus cursor-based SSE.
- [#5](https://github.com/heyimcarlos/osfo/issues/5): admission must be atomic, bounded, Principal-fair, cancellable, fenced, and capable of typed refusal.
- [#6](https://github.com/heyimcarlos/osfo/issues/6): PostgreSQL direct dispatch remains the first candidate. A broker is introduced only after a measured trigger.
- [#7](https://github.com/heyimcarlos/osfo/issues/7): local dispatch hit approximately 663 to 665 AgentRuns/s on 4 vCPU. The first measured hotspot was an exact global obligation counter, not the runnable-row claim query.
- [#12](https://github.com/heyimcarlos/osfo/issues/12): AgentRun is a durable logical execution identity. Attempts, child runs, joins, model calls, tool calls, workflows, checkpoints, sandboxes, and artifacts have distinct identities and recovery rules.
- [#13](https://github.com/heyimcarlos/osfo/issues/13): the first production-shaped run accepted 700 AgentRuns/s but drained very slowly. The measured limit was the local Docker sandbox lane, not Cloud SQL or Temporal.
- [#15](https://github.com/heyimcarlos/osfo/issues/15), [#16](https://github.com/heyimcarlos/osfo/issues/16), [#17](https://github.com/heyimcarlos/osfo/issues/17), and [#18](https://github.com/heyimcarlos/osfo/issues/18): replay, fencing, crash recovery, join, tool, workflow, and idempotency failure cases were exercised.
- [#20](https://github.com/heyimcarlos/osfo/issues/20): the traffic unit was corrected from AgentRuns to incoming messages. Splitting the claim path produced the successful 232/s confirmation.
- [#21](https://github.com/heyimcarlos/osfo/issues/21): early overload controls, independent ingress and stream services, fixed workers, and typed shed were implemented. Safety behavior worked, but the final 232/s capacity gate failed.
- [#22](https://github.com/heyimcarlos/osfo/issues/22): the measured Temporal workflow mix exceeds the current Temporal Cloud Actions/s limit at the peak target.

The primitive vocabulary is not the main error. Thread, ThreadEvent, ThreadPosition, AgentRun, AgentRunAttempt, ChildJoin, WorkflowInstance, ArtifactRef, SandboxRef, and RuntimeCheckpointRef establish useful identity and authority boundaries. The missing boundary is mostly physical: which storage and service plane carries each access pattern, for how long, and with what resource budget.

## The decisive comparison: issue #20 versus issue #21

| Metric | Issue #20 clean 232/s confirmation | Issue #21 final 232/s stage |
|---|---:|---:|
| Offered messages | 13,920 | 13,920 |
| Accepted | 13,920 | 11,067 |
| Typed admission rejections | 0 | 2,853 |
| SSE completions | 13,920 | 11,064 |
| Admission p95 | 224.6 ms | 9.175 s |
| Authoritative completion p95 | 429.8 ms | 9.806 s |
| Authoritative completion p99 | 714.2 ms | 36.438 s |
| Drain after offer window | 1.10 s | 38.19 s |
| Peak Cloud SQL CPU | 27.9 percent | approximately 100 percent |
| Observed Cloud SQL backends | not decisive in retained summary | approximately 696 |
| Root-run identity range | approximately 155k to 169k | approximately 290k to 302k |

Issue #21 still proves valuable things: typed refusal, no accepted-run loss in authoritative reconciliation, bounded nonterminal work, and recovery to zero outstanding capacity. It does not prove that the design's clean 232/s capacity fell because PostgreSQL ran out of raw message throughput.

### Invalid baseline isolation

The issue #21 target stage started around 12:24:29. The Cloud SQL sample for 12:24 was already approximately 99.98 percent CPU. The dominant evidence-query telemetry also accumulated substantial work during the minute before the stage. A valid capacity experiment must begin from a quiescent database or explicitly account for background work. This one did neither.

### Observer effect

The deployed load program uses one completion observation per accepted message. After the message tasks finish, it calls the evidence endpoint once per accepted root with a default concurrency of 128.

The evidence endpoint performs a wide, correlated query across AgentRuns, interactions, ThreadEvents, ChildJoins, workflows, tool calls, approvals, artifacts, and related state. Several counts are repeated to compare planned and actual work. In the issue #21 Query Insights window, this query accumulated more than twenty times the execution-time signal of the next query.

Cloud SQL's execution-time metric is not wall-clock CPU alone. Google defines it as accumulated time across processes, including CPU, I/O wait, lock wait, process switching, and scheduling. It can therefore be much larger than elapsed wall time. The ranking is still decisive: correctness reconciliation was the dominant captured database workload after the offer interval.

Correctness evidence is required by the brief. Running an N+1, 128-concurrent correctness report against the same primary during a capacity experiment is not required.

### New capacity-control amplification

The issue #21 admission path provisions and reserves capacity in the database:

```text
incoming message
  -> per-instance admission semaphore
  -> admission transaction
     -> ensure capacity rows exist
     -> scan and lock a free Principal slot
     -> update Principal slot with run identity
     -> scan and lock a free global slot
     -> update global slot with run identity
     -> allocate thread sequence
     -> insert AgentRun and related durable records
     -> append accepted ThreadEvent
  -> worker claim and execution
     -> possible Child AgentRuns
     -> terminal AgentRun transition
        -> trigger clears Principal and global slots
  -> append assistant ThreadEvent
```

The schema uses partial indexes over rows whose `run_id IS NULL`. Each reservation and release changes whether the row belongs in that partial index. PostgreSQL must maintain those index entries, and those updates cannot benefit from a normal heap-only tuple update for every indexed membership change.

For the observed 1.5 AgentRuns/message, two capacity scopes imply about three slot rows claimed and three slot rows released per incoming message, before retries and provisioning statements. The captured Principal reservation query was the top admission-side query and accumulated a large lock component.

This is the same class of failure already found in issue #7: the exact global coordinator becomes more expensive than the work it protects.

Capacity-row provisioning also belongs in a migration or explicit control-plane operation. Running `INSERT ... generate_series ... ON CONFLICT` style provisioning inside every hot admission transaction adds needless statements and shared-index work.

### Connection amplification

The configured fleet-level pool ceilings were:

| Fleet | Maximum instances | Pool per instance | Maximum sessions |
|---|---:|---:|---:|
| Ingress | 24 | 12 | 288 |
| Stream | 8 | 4 | 32 |
| AgentRun workers | 16 | 8 | 128 |
| Total declared maximum | | | 448 |

Cloud SQL observed approximately 696 backends. The extra 248 sessions are unexplained by the declared topology. Likely categories include stale Cloud Run revisions, old benchmark clients or proxies, administrative and monitoring sessions, or a mismatch between intended and effective pool configuration. The evidence did not capture `pg_stat_activity` or backend count by `application_name`, so no one category is proven.

This topology can create a positive feedback loop:

```text
database latency rises
  -> requests occupy Cloud Run concurrency longer
  -> Cloud Run adds instances
  -> every instance adds a connection pool
  -> database runnable and waiting sessions rise
  -> CPU, scheduling, locks, and latency rise further
```

Low ingress CPU is compatible with this failure. A request waiting on a semaphore, pool, lock, or database uses little application CPU while still occupying request concurrency.

### Corpus growth and MVCC are plausible, but unproven contributors

The retained root corpus roughly doubled between the clean issue #20 target and the issue #21 target. AgentRun state changes also enter and leave partial indexes. PostgreSQL updates create obsolete tuple versions, indexed-state changes create index churn, and autovacuum must reclaim them.

These facts make bloat, stale statistics, vacuum lag, or a changed query plan plausible contributors. They are not yet proven because the experiment omitted:

- table and index size before and after each stage
- live and dead tuple counts
- autovacuum history and lag
- heap-only update ratios
- WAL bytes per accepted message
- `EXPLAIN (ANALYZE, BUFFERS, WAL)` on a cloned corpus
- `pg_stat_statements` deltas around each isolated stage

The correct response is to measure these, not to assert that row count alone caused the failure.

## Direct answers to the architecture questions

### Are we scaling the wrong primitive?

Partly. The logical primitive is sound, but the physical work attached to it is too broad.

`AgentRun` should remain the stable logical identity for idempotency, ownership, cancellation, recovery, joins, and audit. Splitting that identity would move complexity into cross-record coordination without removing the measured hotspots.

What should be split is the physical plane:

```text
AgentRun identity and bounded current state     PostgreSQL hot OLTP
Runnable projection or delivery intent         PostgreSQL initially, broker only on evidence
ThreadEvent and AgentEvent immutable history   partitioned append store
Large model, tool, file, and artifact payloads object storage with immutable references
Visibility, search, dashboards, evidence       asynchronous read model or replica
Closed terminal history                         time partition, archive, retention policy
Long independently durable work                 Temporal WorkflowInstance
```

The current model already names several of these records. It now needs service, connection, retention, and query budgets that enforce the distinction.

### Should AgentRun be split?

Do not split its identity. Narrow its hot row and split its responsibilities.

Keep on the hot `agent_run` record:

- identity and parent identity
- Principal and Thread ownership
- current lifecycle state
- fence or generation
- priority and runnable timing
- compact retry and cancellation metadata
- pointers to current checkpoint, sandbox, and artifacts
- small counters required for admission or recovery

Keep outside that row:

- immutable messages and lifecycle events
- individual attempts
- model calls and tool calls
- child joins
- large payloads
- arbitrary search fields
- reporting aggregates

Osfo is already close to this logical form. The failure is not an ever-growing transcript JSON rewrite in the AgentRun row. No evidence supports that diagnosis for the current prototype.

### Should agent messages be saved somewhere else?

Not as the first fix. Moving ordinary small message text will not remove the capacity-slot locks, excess sessions, evidence queries, or benchmark overlap that dominate the current evidence.

Use a size and access-policy boundary:

- Keep ThreadEvent identity, ThreadPosition, type, actor, timestamps, payload checksum, and small user-visible text in the authoritative relational event log.
- Coalesce assistant streaming fragments before durable append where the product contract permits it.
- Put large model request and response bodies, tool results, files, images, sandbox outputs, and generated artifacts in object storage.
- Store immutable references, content length, content type, checksum, encryption metadata, and lifecycle policy in PostgreSQL.
- Partition ThreadEvents by a retrieval-aligned boundary before the table reaches hundreds of millions of rows. Preserve per-Thread ordered access.
- Send search and analytics to asynchronous projections, not arbitrary indexes on the write primary.

This preserves exact resume and ordering without making the hot database carry every byte and access pattern.

### Should dispatch move to Pub/Sub or another broker?

Not as the immediate CPU fix. The earlier claim split showed that candidate discovery could be made cheap, and the issue #21 dominant work was not the normal claim query. A broker does not remove admission slot updates, lifecycle writes, terminal triggers, evidence reads, or connection multiplication.

A broker becomes justified when one of these remains after the primary hot path is fixed:

- idle polling cost is material
- runnable discovery or lock contention dominates
- dispatch and lifecycle must scale independently
- a transactional outbox can feed the broker without losing the PostgreSQL authority contract
- measured operational cost is better than direct dispatch at the target and breaking point

When tested, hold total worker slots, total database connections, corpus, traffic, and evidence method constant. Otherwise the comparison is not attributable.

### Should every AgentRun become a Temporal workflow?

Not as a shortcut. The Wayfinder authority split is sensible: short AgentRun state stays in PostgreSQL, independently durable timers and external-effect workflows go to Temporal.

The measured Luna mix already requires about 664 Temporal Actions/s at the 232 message/s peak, above the current 500 Actions/s limit recorded by issue #22. Moving every AgentRun to Temporal would increase that demand and would introduce a larger ownership migration. The Rust replay adapter is also pinned to an unstable test-only surface in issue #15.

Temporal is a useful architecture comparable because it separates history, matching, visibility, workers, object payloads, retention, and persistence QPS budgets. It is not free capacity.

## What the comparable systems actually show

### Discord

The statement that Discord stores billions of messages in PostgreSQL is false for its authoritative message store.

Discord moved messages from MongoDB to Cassandra, then to ScyllaDB. Its message key is shaped for one dominant query: `(channel_id, time_bucket)` with a chronological Snowflake message ID. It bounds partitions, consistently routes requests by channel, coalesces identical reads, maintains search asynchronously in Elasticsearch, and treats exceptional large guilds separately. Its published 3.2 million messages/s number was bulk migration throughput, not normal production sends. See [Discord's storage history](https://discord.com/blog/how-discord-stores-trillions-of-messages), [its earlier data model](https://discord.com/blog/how-discord-stores-billions-of-messages), and [the 4 billion/day workload context](https://discord.com/blog/how-discord-supercharges-network-disks-for-extreme-low-latency).

The transferable lesson is not ScyllaDB. It is bounded query-shaped partitions, narrow append paths, stable ordering identifiers, upstream concurrency control, request coalescing, asynchronous derived indexes, and workload-specific isolation.

### Effective AI

[How We Built a Multi-Agent Runtime](https://effectiveailabs.com/blog/multi-agent-runtime) describes typed child tasks, cooperative yielding, paused sandboxes, persistent completion events, atomic claim and retry, bounded concurrency, and coalesced notifications. Its only concrete production scale statement is that one request can spawn 10 to 20 specialized agents.

The article does not publish millions of messages per day, database technology, schema, QPS, retention, or a normalized capacity benchmark. Osfo's Child AgentRun, ChildJoin, and waiting model already resembles its task and Promise model. The useful gap is aggregate wake-up and fan-out control, not a different AgentRun identity.

### LangGraph and DeepAgents

[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) stores checkpoints by thread and superstep. Its PostgreSQL saver separates checkpoints, blobs, and pending writes, and uses batched database operations. It is a recovery model, not published proof that a single PostgreSQL primary sustains a particular message rate. Its DeltaChannel work also acknowledges that full-state checkpointing is inefficient for append-heavy values.

[DeepAgents](https://github.com/langchain-ai/deepagents) exposes pluggable state, store, composite, filesystem, and sandbox backends. This is evidence for routing large or specialized state to fit-for-purpose storage while keeping a coherent logical runtime. It does not publish a comparable million-message PostgreSQL benchmark.

### Temporal

[Temporal](https://docs.temporal.io/temporal-service/temporal-server) separates four major server services and multiple physical data concerns:

- History owns ordered state transitions.
- Matching owns worker dispatch.
- Workers pull only when they have execution slots.
- Visibility is an asynchronous searchable projection and may use a separate datastore.
- Large payloads can use the claim-check pattern with object storage.
- closed histories have retention and archival policies.
- persistence has service-specific QPS limits.

Temporal's PostgreSQL schema separates current execution identity, bounded mutable state, append history nodes, internal tasks, matching queues, and visibility. It also places hard limits on one workflow history and uses Continue-As-New for long-lived executions. See [persistence](https://docs.temporal.io/temporal-service/persistence), [worker performance](https://docs.temporal.io/develop/worker-performance), [workflow history limits](https://docs.temporal.io/workflow-execution/limits), and [external storage](https://docs.temporal.io/external-storage).

The lesson for Osfo is explicit physical planes and bounded histories, not adopting the whole Temporal server.

### PostgreSQL-backed runtimes

Systems such as DBOS use PostgreSQL successfully by keeping queue rows narrow, using exact partial indexes for active states, claiming small batches with `FOR UPDATE SKIP LOCKED`, adding adaptive jitter, avoiding commits for empty polls, collecting terminal records, and offloading large results. Hybrid orchestrators such as Prefect keep orchestration state in PostgreSQL while using a message bus for events and object storage for results.

These systems do not prove unlimited PostgreSQL capacity. They demonstrate that PostgreSQL is viable when the hot path is bounded and historical, payload, and reporting work are controlled.

## Why the team keeps finding a new wall

The sequence of work explains the feeling of repeated failure:

1. The original estimate used AgentRuns as the external traffic unit. Issue #20 corrected it to incoming messages and measured real amplification.
2. The original global obligation counter serialized admissions. Splitting the claim path fixed that hotspot.
3. The first production topology then exposed a local sandbox throughput limit.
4. The next topology added correct overload controls, but implemented exact capacity with another globally shared database mechanism.
5. Cloud Run pool budgets were specified per instance, not enforced as one database-wide budget.
6. The database corpus and old workloads were not reset or proven quiescent between stages.
7. The correctness reporter executed heavyweight N+1 analytical queries on the same primary and in the same evidence window.
8. Therefore each experiment changed several independent variables while preserving less baseline isolation than the decision required.

The team has built many correct contracts. What is missing is an experimental and operational foundation that makes one bottleneck attributable at a time.

## Recommended target architecture

```text
Clients
  |
  +--> command ingress
  |      global request and DB admission gate
  |      atomic message acceptance transaction
  |
  +<-- durable SSE
         cursor over immutable ThreadEvents
         long-lived streams, not one stream per message

PostgreSQL hot OLTP
  Thread current sequence
  compact AgentRun current state
  narrow runnable projection or outbox
  bounded admission counters
  recent partitioned ThreadEvents
  integrity metadata and object references
       |
       +--> workers claim small batches
       |      local capacity-aware pull
       |
       +--> outbox to broker, only if measured trigger fires
       |
       +--> async visibility/evidence projection
       |
       +--> archive and retention pipeline

Object storage
  large model payloads
  tool and sandbox results
  artifacts and files
  cold immutable event payloads

Temporal
  independently durable waits, schedules, and external effects
  not every short AgentRun by default
```

### Admission-control design

For v1, replace per-run free-slot row churn with a smaller exact state:

- one atomic counter row per Principal, updated only when `active + requested <= limit`
- a small number of sharded global counter rows or permit buckets to avoid one global lock
- an explicit release operation with fencing and a repair job that derives leaked counts from authoritative nonterminal AgentRuns
- no hot-path capacity provisioning
- short transactions and bounded retry count
- a database-wide connection and in-flight transaction budget, not only per-instance pools

One serialized counter per Principal is acceptable because same-Principal fairness is intentionally a hot-key policy. A single global counter is not acceptable at this rate because every independent Principal collides on it.

If exact global capacity across many Cloud Run instances remains too costly, evaluate a small dedicated admission service or a leased external counter. Preserve a reconciliation path against authoritative AgentRuns. This is a control-plane decision and should not be mixed into the broker experiment.

### Connection design

- Assign a distinct PostgreSQL `application_name` to ingress, stream, workers, maintenance, evidence, migrations, and load generation.
- Set one total Cloud SQL connection budget, then divide it among fleets.
- Cap maximum instances from that budget.
- Keep application pools small. More sessions are not more throughput once database CPU is saturated.
- Put a semaphore immediately before database acquisition and shed before long request queues form.
- Use managed connection pooling or an external pooler only after session semantics are audited. Pooling does not repair expensive queries.
- Make old Cloud Run revisions scale to zero before every capacity run.

## Required experiment before another architecture migration

### Phase 1: make the test valid

1. Restore the database from a fixed snapshot for every candidate.
2. Run `ANALYZE` consistently and record vacuum state.
3. Enforce a five-minute quiescence gate before traffic: stable CPU, stable backend count, no old load processes, zero old revision traffic, and flat Query Insights deltas.
4. Record raw accepted message IDs and root run IDs during load. Do not run per-root evidence queries in the offer or drain window.
5. Reconcile offline with set-based queries after the capacity window, preferably against a read replica or cloned database.
6. Separate tests for message admission, durable SSE fleet capacity, evidence generation, retention growth, and crash recovery.

### Phase 2: attribute database work

Capture before and after every stage:

- `pg_stat_activity` grouped by `application_name`, state, wait event, and query identity
- `pg_stat_statements` call, total time, rows, block, WAL, and temporary-file deltas
- Cloud SQL CPU, memory, backend count, wait classes, disk IOPS, throughput, WAL, and replication lag
- table and index sizes
- live and dead tuples, vacuum and analyze timestamps
- heap-only and non-heap-only update counts
- exact application instance count and effective pool settings
- query plans on the same corpus using `EXPLAIN (ANALYZE, BUFFERS, WAL)` outside the production run

Publish a per-accepted-message budget for:

- SQL calls
- rows inserted and updated
- index entries changed
- WAL bytes
- ThreadEvent reads
- empty queue polls
- evidence/report reads

### Phase 3: test one change at a time

Run in this order:

1. Current code on a reset, quiescent baseline with offline reconciliation.
2. Move capacity provisioning out of admission.
3. Replace slot rows with bounded counter or sharded-permit admission.
4. Enforce a total connection budget and reduce minimum instances.
5. Tune the top two SQL operations proven by stage 3 evidence.
6. Repeat on small and large retained corpora to expose growth effects.
7. Add a visibility/evidence replica or projection and repeat.
8. Only then compare direct dispatch with transactional outbox plus Pub/Sub.

For the broker comparison, hold offered workload, worker execution slots, total database connections, corpus snapshot, and observation method constant.

## Decision gates

Keep Cloud SQL direct dispatch if the isolated test meets all of these at 232 messages/s:

- all accepted messages reach authoritative terminal state
- no accepted-run loss or ordering violation
- typed refusal occurs only after declared capacity is genuinely exhausted
- admission and terminal latency meet a predeclared SLO
- Cloud SQL has at least 30 percent sustained CPU headroom
- backend count stays within the declared budget
- no query or lock coordinator consumes a dominant fraction of database time
- drain returns to baseline promptly

Introduce a broker if, after the hot path fixes, claim polling or dispatch contention remains a dominant and independently scalable cost.

Move visibility/evidence off the primary if report and dashboard reads materially affect OLTP, which the issue #21 evidence already strongly indicates.

Partition or archive history when latency or maintenance cost changes materially with retained corpus size, or before expected row counts make an emergency migration likely.

## Final verdict

The foundation is not fundamentally broken. The contracts around identity, ordering, durability, recovery, and authority are strong. The topology is missing hard physical boundaries and the capacity process is missing experimental isolation.

Do not replace PostgreSQL, split AgentRun identity, or move all message text as a reaction to this 100 percent CPU graph. First remove the benchmark observer load, replace the exact slot-row coordinator, enforce one total connection budget, and rerun from a fixed quiescent corpus. Then use measured per-message database amplification to decide whether dispatch, visibility, payloads, or terminal history need their own plane.

That sequence can establish a solid foundation. The current evidence cannot justify a larger architectural migration before those controls exist.

## Local evidence map

- [`CONTEXT.md`](../../CONTEXT.md)
- [`ADR-0001: retain Cloud SQL direct dispatch`](../adr/0001-retain-cloud-sql-direct-dispatch.md)
- [`dispatch-topology` prototype](../../prototypes/dispatch-topology/README.md)
- [`AgentRun lifecycle` prototype](../../prototypes/agent-run-lifecycle/README.md)
- [`production-shaped lifecycle research`](production-shaped-lifecycle-prototype-stack.md)
- [`deployed ingress and dispatch research`](deployed-ingress-dispatch-cloud-run-temporal-cloud.md)
- [`broker dispatch comparison`](broker-dispatch-concurrency.md)
- [`Google SRE load confirmation guidance`](google-sre-load-confirmation-guidance.md)
- [`benchmark evidence standard`](grafana-benchmark-evidence-standard.md)
- [`mistake log`](../../MISTAKES.md)

## External operational references

- [Cloud SQL high CPU troubleshooting](https://docs.cloud.google.com/sql/docs/postgres/optimize-cpu-usage)
- [Cloud SQL System Insights metric semantics](https://docs.cloud.google.com/sql/docs/postgres/use-system-insights)
- [Cloud SQL Query Insights](https://docs.cloud.google.com/sql/docs/postgres/using-query-insights)
- [Cloud SQL read replicas](https://docs.cloud.google.com/sql/docs/postgres/replication/create-replica)
- [Cloud SQL managed connection pooling](https://docs.cloud.google.com/sql/docs/postgres/managed-connection-pooling)
- [PostgreSQL routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL heap-only tuple updates](https://www.postgresql.org/docs/current/storage-hot.html)

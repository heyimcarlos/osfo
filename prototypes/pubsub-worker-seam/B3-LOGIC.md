# Issue 38 transactional-outbox handoff

## Question

Does an atomic AgentRun plus append-only outbox commit make every accepted run
durably discoverable while preserving duplicate-safe Pub/Sub delivery,
automatic recovery, bounded retention, and the frozen point-claim worker seam?

## Candidate under test

Admission writes the authoritative AgentRuns and one outbox obligation per run
in the same PostgreSQL transaction. A transaction-held gate assigns commit-
ordered sequence numbers within each of four relay shards. This avoids the
unsafe assumption that ordinary PostgreSQL sequence allocation follows commit
order. Session advisory locks give each shard one active relay owner without
updating or leasing individual outbox rows.

```text
authenticated incoming message
              |
              v
 PostgreSQL admission transaction
    | AgentRun authority
    ` append-only outbox obligation
              |
              v
  sharded monotonic relay cursor
              |
              v
       Pub/Sub confirmation
              |
              v
 unchanged point claim and epoch fence
```

The cursor advances only after every publish in a bounded batch confirms. A
crash or ambiguous response can therefore publish duplicates but cannot skip
an obligation. The worker's PostgreSQL claim and terminal fence absorb the
duplicates.

The four sequencing gate rows use bounded HOT updates. Their WAL, dead tuples,
and vacuum work are candidate cost and are reported separately from the
append-only outbox.

Outbox retention uses daily partitions. A whole partition becomes droppable
only after the replay safety window and after every relevant shard cursor has
passed its maximum sequence. The candidate performs no per-row outbox update
or delete on the hot path.

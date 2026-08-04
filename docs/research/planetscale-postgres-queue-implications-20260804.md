# PlanetScale Postgres queue implications for Wayfinder #25

Date: 2026-08-04  
Status: primary-source review  
Scope: PlanetScale's "Keeping a Postgres queue healthy," PostgreSQL 17 behavior, Osfo's current `agent_runs` implementation, and dispatch-topology Wayfinder #25.

## Conclusion

The article is strong evidence that Wayfinder #25 must test sustained queue churn while other transactions continuously pin PostgreSQL's MVCC cleanup horizon. It is not evidence that every PostgreSQL queue is the wrong design, that Osfo has already reached this failure mode, or that Pub/Sub or Redis will necessarily be cheaper. The article explicitly says PostgreSQL queue capability at high scale is not in question. Its measured failure is the interaction between a high-churn queue and overlapping slower work on the same primary.

The current candidate matrix remains valid. The architectural prior should shift toward B2 and C1, because primary delivery removes claimable-index discovery scans. However, no current candidate removes PostgreSQL churn entirely. PostgreSQL remains lifecycle authority, and B2/C1 still write admission, outbox, point-addressed claim, lease, fence, and terminal state. B1/C2 are only wake hints: they reduce empty polling but retain the authoritative `FOR UPDATE SKIP LOCKED` scan and all lifecycle mutations.

## What the linked article establishes

The linked article is by Simeon Griggs and was published on April 10, 2026. It is not the attributed August 3 post by Chris Munns. The linked article contains no customer-migration percentage, no claim that 90 percent of painful migrations involve queues, and no comparison with RabbitMQ, ActiveMQ, Kafka, Pub/Sub, or Redis. Those separate claims require the direct source post before they should enter a decision record. [PlanetScale article](https://planetscale.com/blog/keeping-a-postgres-queue-healthy)

The article reports two PostgreSQL 18 experiments on a PlanetScale PS-5:

| Lane | Conditions | Reported result |
|---|---|---|
| Modernized queue | 8 workers, 50 jobs/s, 10 ms work, long-running transaction after 45 seconds, 15 minutes | Both the recursive-CTE design and `SKIP LOCKED` with batches of 10 ended near 42,400 dead tuples. Typical claim time rose from about 2 to 3 ms to 9 to 34 ms. The enhanced queue remained mostly empty, and the author says neither design was under real pressure. |
| Mixed-workload failure | 800 jobs/s, three continuously overlapping 120-second analytics queries, 15 minutes | Without workload throttling: 155,000 queued jobs, claim time above 300 ms, and 383,000 dead tuples. With analytics concurrency limited to one: no backlog, about 2 ms claim time, and dead tuples cycling between 0 and 23,000. |

This demonstrates a failure under those conditions. It does not establish a general breakpoint at a few hundred jobs per second. The tested producer rates were 50 and 800 jobs/s. The statement that 500 jobs/s would fail faster is the author's extrapolation. The article also does not publish the rewritten 2026 harness, raw samples, analytics SQL, payload size, PostgreSQL configuration, autovacuum settings, or metric collection method. Treat its numbers as author-reported evidence and its failure mechanism as a hypothesis to reproduce, not as a portable capacity curve.

## Why the mechanism is credible

PostgreSQL 17 documents that `UPDATE` and `DELETE` retain obsolete row versions while they might remain visible to another transaction. `VACUUM` later reclaims dead table and index entries, and vacuuming itself can create substantial I/O. An open transaction can prevent cleanup of recently dead tuples. [Routine vacuuming](https://www.postgresql.org/docs/17/routine-vacuuming.html), [client connection timeouts](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT)

PostgreSQL also documents that B-tree bottom-up deletion and scan-driven cleanup reduce version-churn damage, but do not replace eventual table-and-index vacuum cleanup. Long snapshots can block garbage collection. This supports the article's conclusion that modern PostgreSQL raises the ceiling without removing the MVCC constraint. [B-tree implementation](https://www.postgresql.org/docs/17/btree.html#BTREE-IMPLEMENTATION)

`FOR UPDATE SKIP LOCKED` solves a different problem. It allows multiple queue consumers to skip rows already locked by another consumer. PostgreSQL explicitly describes queue-like tables as a valid use, while warning that the result is not a consistent general-purpose view. It does not make obsolete tuple versions reclaimable and does not clean dead index entries. [PostgreSQL `SELECT`](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)

## Applicability to Osfo

Osfo differs materially from the article's example. The article locks a row, performs simulated work inside that transaction, deletes the row, and commits. Osfo batches claimable rows with `FOR UPDATE SKIP LOCKED`, updates them to `running`, commits the claim, then performs AgentRun work without retaining the transaction. This avoids letting long model or tool execution itself pin the MVCC horizon. [claim implementation](../../prototypes/agent-run-lifecycle/src/ingress.rs#L371-L485)

Osfo nevertheless creates the same class of storage churn. Each `AgentRun` transitions through mutable lifecycle states and can receive lease or epoch updates. The current partial indexes include rows based on `state`, so transitions into and out of `pending`, `retry_ready`, and `running` change index membership. PostgreSQL permits a HOT update only when the update does not modify columns referenced by indexes, including partial-index predicates, so these state transitions require non-HOT index maintenance. [current schema](../../prototypes/agent-run-lifecycle/schema.sql#L5-L39), [heap-only tuple updates](https://www.postgresql.org/docs/17/storage-hot.html)

The article's mixed-workload condition is plausible for Osfo because lifecycle writes, ThreadEvent reads, evidence reconciliation, administrative queries, migrations, and future reporting can share the Cloud SQL primary. Existing Osfo evidence already found a contaminated run where a wide, 128-concurrent evidence query dominated database execution-time signal, the retained corpus had roughly doubled, and vacuum, dead-tuple, HOT-update, index-size, and WAL measurements were absent. That evidence does not prove MVCC horizon pinning, but it shows the exact missing attribution. [Osfo Cloud SQL diagnosis](osfo-cloud-sql-capacity-failure-diagnosis-20260804.md#corpus-growth-and-mvcc-are-plausible-but-unproven-contributors)

At the target 232 incoming messages/s, the observed 1.5 AgentRuns/message implies about 348 AgentRuns/s before child lifecycle transitions and retries. This is not directly comparable to the article's jobs/s, because an Osfo AgentRun creates multiple SQL operations and durable records. The comparison manifest must report both product throughput and physical database work per accepted message.

## What each candidate actually changes

| Candidate | Removes empty polling | Removes claimable-index discovery | Removes lifecycle row churn | Adds PostgreSQL outbox churn |
|---|---:|---:|---:|---:|
| A0 to A3 | No | No | No | No |
| A4 `LISTEN/NOTIFY` | Mostly | No | No | No |
| B1 Pub/Sub wake hint | Mostly | No | No | Yes |
| C2 Memorystore wake hint | Mostly | No | No | Yes, unless a proven safe reconciler avoids a physical outbox |
| B2 Pub/Sub primary delivery | Yes | Yes | No | Yes |
| C1 Memorystore primary delivery | Yes | Yes | No | Yes |

Wake hints do not address the PlanetScale failure mechanism under steady load. When the queue is busy, there are few empty polls to remove, workers still traverse the claimable index, and state transitions still generate dead versions. A4 also keeps the signal on the same PostgreSQL system and therefore provides no resource isolation.

Primary delivery is more relevant. A point-addressed claim by `AgentRunId` avoids walking dead entries at the front of the runnable-order index. It still performs a fenced PostgreSQL mutation, and the transactional outbox itself is a queue-like PostgreSQL workload if rows are repeatedly updated or deleted. Outbox table size, cleanup, relay scans, WAL, and vacuum must therefore be attributed separately. Physical separation or append-oriented outbox rotation may reduce interference, but it must be measured rather than assumed.

## Required changes to the #25 experiment

Keep A0 through C1, but strengthen the frozen manifest in #26:

1. Add a 15-minute-or-longer sustained mixed-workload lane at the 232 messages/s target, plus the existing 464/s boundary. On the same Cloud SQL primary, run staggered read transactions or representative report/evidence queries so at least one snapshot remains active continuously. Also keep an isolated queue-only lane. The delta is the result.
2. Restore the same corpus snapshot for every candidate. Record the oldest active transaction and `backend_xmin`, active autovacuum progress, dead and live tuple estimates, vacuum and analyze timestamps, HOT and non-HOT updates, table and index bytes, WAL bytes, storage I/O, and claim-query buffer work before, during, and after the lane. PostgreSQL exposes the relevant activity, table, index, WAL, and vacuum-progress views. [Statistics collector](https://www.postgresql.org/docs/17/monitoring-stats.html)
3. Make A1 pass under a pinned horizon, not only under queue-only load. More aggressive autovacuum can reduce ordinary lag, but no cost or threshold setting can reclaim a tuple that remains visible to an active snapshot.
4. For A2, measure whether active/history separation keeps the runnable index bounded, while also counting the WAL, row movement, archive lag, and foreign-key costs. A smaller hot structure mitigates scan work but does not remove MVCC.
5. For B1 and C2, report empty polls saved separately from claims and state mutations. Do not count a reduction in idle polling as evidence that the sustained mixed-workload failure is solved.
6. For B2 and C1, report `agent_runs` churn and outbox churn separately. Compare point-claim buffer reads against A-series claimable-index reads. Include relay failure and reconciliation periods, because a broker outage can grow the PostgreSQL outbox backlog even while worker discovery traffic is absent.
7. Add a quiet-period recovery gate after the competing workload stops. A passing candidate must drain accepted work, allow vacuum to catch up, and return claim latency and index growth to a declared steady range without manual table rewrite.

## Decision implication

Do not cancel the A-series and do not declare a broker winner from this article. Reclassify the article as a reason that mixed-workload endurance is a correctness-and-cost gate, not an optional characterization. If winning A passes only the isolated lane while B2 or C1 passes the identical pinned-horizon lane at a lower right-sized monthly cost, that is strong evidence to move primary delivery out of PostgreSQL. If all candidates degrade similarly, the remaining problem is shared lifecycle, outbox, or reporting pressure on the authoritative primary, and merely changing the wake transport has not isolated the workload.

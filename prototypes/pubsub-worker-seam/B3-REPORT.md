# B3 decision: transactional-outbox Pub/Sub delivery

## Proposed verdict for human review

The transactional-outbox topology closes B2's durable acceptance gap in the
exercised boundary cuts, but the B3 prototype ticket is not ready to close.

The corrected candidate made every accepted AgentRun durably discoverable,
recovered automatically after admission and relay cuts, and fenced duplicate
publication. The short 232 messages/s lane reconciled exactly. It still missed
the frozen publish-to-claim p95 threshold, and the short 464/s lane exposed an
admission capacity knee, untyped 429 responses, and incomplete drain. The
required sustained, outage, mixed-workload, fairness, Temporal, retention-
rotation, and full-cost lanes remain `MISSING`.

The human decision is therefore not "select B3" yet. The review question is
whether to continue this candidate by widening the commit-order sequencing
shards and finishing the frozen manifest, or reject this relay design and test
a different durable publication mechanism.

## Corrected topology

```text
authenticated incoming message
              |
              v
 PostgreSQL admission transaction
    | AgentRun authority
    | per-shard commit-order gate
    ` append-only outbox obligation
              |
              v
 four concurrent relay shards
    | session advisory ownership
    | bounded 128-record batches
    ` cursor advances after confirmation
              |
              v
 authenticated Pub/Sub push worker
              |
              v
 point claim, claim epoch, terminal fence, acknowledgement
```

The worker implementation, min-zero scaling, pool limit, lease, semaphore,
message envelope, topic, subscription, and Cloud SQL comparison shape remained
frozen. The relay added one min-one Cloud Run instance with 1 vCPU, 512 MiB,
four database connections, four shard owners, and 128-record batches.

## Prototype findings that changed the candidate

### Ordinary sequence allocation is not commit ordered

The first implementation advanced each shard cursor by a PostgreSQL sequence
allocated while admission transactions were still open. Under concurrency, a
transaction could reserve a lower sequence, commit late, and appear behind an
already-advanced cursor. One short target lane exposed 31 outbox rows with no
publication evidence even though the cursors reported zero backlog.

That implementation is rejected. Commit `1fb90f5` replaced it with four
transaction-held sequence gates. A gate assigns the shard sequence while the
admission transaction holds the row lock, so later shard sequences cannot
commit first. Audit logic now counts confirmed publication evidence directly
and cannot use cursor position as proof of publication.

### Parallel relay ownership must fit the connection budget

The first parallel relay acquired all four configured database connections,
then attempted to open an additional connection per shard for evidence writes.
It self-deadlocked. Commit `16d1c1a` records publication evidence and advances
progress through the shard's already-owned connection. The contaminated lane
was preserved locally and automatically drained after the fixed revision
started, with zero stranded or duplicate terminal outcomes.

### Commit ordering has a measurable write cost

The append-only outbox itself produced no per-row update or delete churn. The
four sequencing gate rows are HOT-updated once per accepted message. Baseline
observed 46 dead tuples before autovacuum; later snapshots showed them reclaimed.
The final database capture records relation bytes, dead tuples, and vacuum
counts. WAL bytes were not isolated from the shared database and remain
`MISSING`.

## Boundary-cut evidence

The corrected three-seed matrix ran 24 lanes with 100 identities each:

- 2,400 accepted messages and 3,600 authoritative AgentRuns
- 3,600 terminal AgentRuns
- zero unpublished outbox obligations at final audit
- zero stranded AgentRuns and zero ghost delivery attempts
- zero duplicate terminal commits
- 150 expected duplicate publications after ambiguous confirmation or a crash
  before cursor commit

All six hard process cuts also recovered after an idempotent caller retry or a
fresh relay process. The two relay hard cuts each published twice and committed
one terminal outcome.

## Short normal-path characterization

These are 60-second characterization lanes, not the three required 30-minute
target repetitions or three required 15-minute stress repetitions.

| Lane | Incoming | AgentRuns | Final state | Receipt p95 / p99 | Outbox-ready p95 / p99 | Publish-to-claim p95 / p99 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| 23/s baseline | 1,380 | 2,070 | exact terminal drain | 13.2 / 16.4 ms | 72.6 / 541.8 ms | 9,807.2 / 11,664.2 ms |
| 232/s target | 13,920 | 20,880 | exact terminal drain | 15.8 / 76.7 ms | 95.8 / 138.3 ms | 147.1 / 465.2 ms |
| 464/s stress | 27,840 offered | 41,363 authoritative | 9,964 nonterminal at audit | 1,789.8 / 2,505.8 ms | 324.8 / 412.6 ms | 1,676.1 / 5,343.5 ms |

The baseline publish-to-claim tail came from initial Pub/Sub push scheduling,
not worker retries. The target missed the frozen 100 ms publish-to-claim p95
gate. At stress, the client needed 68.5 seconds to encode a nominal 60-second
trace. Cloud Run returned 267 untyped 429 responses; 27,573 messages became
authoritative. Every accepted identity still had a confirmed outbox obligation,
but the lane failed overload, latency, throughput, and drain gates.

## Retention design

Outbox rows are daily range partitions. Normal publication updates only four
relay cursors and never updates or deletes an outbox row. A partition can be
dropped only when both conditions hold:

1. its day is older than the seven-day replay safety window;
2. every row's commit-ordered shard sequence is at or below that shard's
   durable relay cursor.

The prototype created current and next-day partitions and produced a retention
plan. It did not wait seven days or execute a production-sized partition drop,
so the retention-rotation gate remains `MISSING`.

## Partial cost lower bound

The target smoke measured 59.7 ingress, 78.2 worker, and 180.089 relay billable
instance-seconds. Applying the August 4, 2026 Montréal list-price capture gives
a measured handoff lower bound of $0.02470:

- $0.001774 per 1,000 incoming messages
- $0.001183 per 1,000 AgentRuns
- about $148.68 for the 60-million-message month, including a $59.92 min-one
  relay idle floor
- about $947.49 for the 600-million-message month, with one relay idle floor

This omits Cloud SQL CPU, memory, storage, I/O, WAL, backup, Temporal, logging,
monitoring, networking, real execution, retry amplification, and full root
responses. The cost gate is `MISSING` and these numbers must not be used as a
production total.

## Gate record

| Gate | Status | Evidence |
| --- | --- | --- |
| Correctness | `MISSING` | exercised cuts and short target pass, required mixed, fairness, ordering, cancellation, database-loss, and Temporal lanes remain |
| Sustained load and capacity | `MISSING` | no required 30-minute repetitions; short stress exposed a gate-row knee and 267 untyped 429s |
| Latency | `FAIL` | short target publish-to-claim p95 was 147.1 ms against 100 ms |
| Backlog and recovery | `MISSING` | cut recovery passes; required 15-minute broker or relay outage and 20-minute continued-load drain were not run |
| Cost | `MISSING` | partial handoff lower bound omits required candidate and product costs |
| Evidence completeness | `MISSING` | no full workload, Temporal, fairness, soak, outage, scale-zero, retention-drop, or three-repetition evidence |

## Proposed next experiment

Keep the corrected append-only outbox and commit-order rule, but widen the
sequence gates independently of the four relay owners. Measure 16 then 64 gate
stripes while the relay maps stripes onto four bounded publishers. Change only
that dimension, rerun the short target and stress lanes, and continue only if
the target p95 and stress typed-overload gates recover. The full frozen manifest
must still run before the topology-selection ticket can resolve.

## Evidence pointers

- Corrected source: commit `1fb90f5`
- Cut matrix: `evidence/b3-transactional-outbox/cut-matrix/`
- Hard cuts: `evidence/b3-transactional-outbox/hard-process-cuts/`
- Short lanes: `evidence/b3-transactional-outbox/load/`
- Final database stats: `evidence/b3-transactional-outbox/database-final-stats.json`
- Retention plan: `evidence/b3-transactional-outbox/retention-plan.json`

The earlier unsafe-sequence evidence remains preserved locally under
`evidence/b3-transactional-outbox-unsafe-sequence/` and is intentionally not
promoted as corrected candidate evidence.

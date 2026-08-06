# B3 retained-tail qualification

## Conclusion

The retained operational corpus did not cause the previously observed
publish-to-claim p99 tail. An identical fresh-database control reproduced a
1,493.1 ms p99. Its 1,359.2 ms publish-to-push-arrival p99 accounts for almost
all of the tail. Handler-slot wait, database-pool wait, and the point claim
were small by comparison. The database was 71 MB and the point and predecessor
plans were sub-millisecond.

The historical 1,467.8 ms retained-corpus p99 is therefore a Pub/Sub delivery
tail characterization, not evidence of retained-table, index, vacuum, or Cloud
SQL saturation. Publish-to-claim has no numeric product SLO in the production
workload contract, so this tail is evidence-only. It does not justify a warm
worker floor, a larger worker pool, a larger Cloud SQL instance, or a different
outbox retention layout.

Integrated production qualification is nevertheless `FAIL`. The selected
32-permit Principal-first publication window cannot sustain the required 348
AgentRuns/s with the current synchronous relay lifecycle. The final controlled
target lane accepted 6,374 of 13,920 offered commands. All 8,282 accepted
AgentRuns completed correctly, but complete target acceptance is mandatory.

The transactional-outbox and Pub/Sub handoff architecture remains selected.
No production execution topology is qualified by this study.

## Evidence reuse

This qualification reused the B3 handoff, stripe, flow-control, warm-worker,
runtime-budget, and Principal-fairness evidence already in this directory. It
did not rerun proven fault matrices, rejected dual-write shapes, or deployment
alternatives.

The historical controls already establish:

- exact transactional-outbox authority and automatic recovery;
- a long-lived authenticated Pub/Sub push subscription;
- 64 outbox sequence stripes and 16 global-budget stripes;
- a durable 1,024-AgentRun global admission bound;
- min-zero workers and a four-connection worker database pool;
- rejection of a larger pool, a warm worker floor, and broker ordering as tail
  controls;
- starvation resistance and failure recovery for the 32-permit Principal-first
  selector.

## Fresh database attribution

The fresh control used the same source, workload trace, region, Cloud Run and
Cloud SQL bounds, long-lived subscription, and 232 incoming-message/s offer
rate as the retained observation.

| Segment or result | Fresh control |
| --- | ---: |
| Offered and accepted incoming messages | 13,920 / 13,920 |
| Completed AgentRuns | 20,880 / 20,880 |
| Publish-to-point-claim p99 | 1,493.1 ms |
| Publish-to-push-arrival p99 | 1,359.2 ms |
| Database-pool wait p99 | 156.4 ms |
| Database size | 71 MB |
| Correctness mismatch | 0 |

The retained observation and fresh control have the same tail magnitude. That
paired result falsifies retained corpus depth as the primary cause. Increasing
the worker pool to eight made the target result worse. Reducing worker
concurrency to eight failed complete acceptance. Increasing idle worker count
did not improve the causal path.

## Missing integrated comparison

The Principal-first challenge proved fairness and recovery but did not prove
the full 232 incoming-message/s target. That was the one material missing
comparison.

The first integrated selector implementation added retained-history coupling
and excessive database round trips. Controlled changes removed those defects:

- selector work became one set-based database function;
- dispatch occupancy moved to a fixed permit table;
- per-Principal budget stripes became lazy rather than eagerly materializing
  sixteen rows per Principal;
- relay evidence inserts became one copy operation;
- publication confirmation became one composite-key update using
  `(BenchmarkId, AgentRunId)`;
- terminal authority commands retained one transaction but used one pipelined
  database exchange;
- normal fair publication evidence and outbox confirmation shared one
  transaction.

Each change retained exact reconciliation and passed fresh PostgreSQL
integration tests. They improved throughput but did not satisfy the target.

| Controlled lane | Accepted / offered | Result |
| --- | ---: | --- |
| Initial fair target | 1,916 / 13,920 | `FAIL` |
| Batched relay writes, 64 permits | 8,993 / 13,920 | `FAIL` |
| Composite-key confirmation, 64 permits | 8,823 / 13,920 | `FAIL` |
| Contract window, worker concurrency 16 | 7,007 / 13,920 | `FAIL` |
| Pipelined terminal transaction | 7,801 / 13,920 | `FAIL` |
| Batched relay transaction, final control | 6,374 / 13,920 | `FAIL` |

The final control recorded zero nonterminal AgentRuns, unpublished outbox
records, stranded accepted work, ghost delivery attempts, duplicate
publications, duplicate terminal commits, global-budget mismatch,
Principal-budget mismatch, or leaked permits.

## Capacity explanation

At the target, the frozen trace requires:

```text
232 incoming messages/s * 1.5 AgentRuns/message = 348 AgentRuns/s
32 permits / 348 AgentRuns/s = 91.95 ms maximum mean permit lifetime
```

The contract releases a fair dispatch permit only in the fenced terminal
authority transaction. The measured mean permit lifetime was 125.8 ms before
terminal pipelining and 98.0 ms after it. The relay still advanced a full
32-record selection cycle about every 193 ms in the pipelined control. Both
bounds are below the required production rate before retained-history growth
is introduced.

This is not a Cloud SQL sizing result. Point queries remained addressed and
correct, while the relay serialized selection, provider confirmation, evidence
persistence, and confirmation progress behind one selector owner. Adding
workers or database connections cannot remove that serialized relay bound.

## Qualification matrix

| Gate | Result | Reason |
| --- | --- | --- |
| Exact authority and reconciliation | `PASS` | Every accepted identity terminalized with zero mismatch |
| Automatic drain | `PASS` | Every controlled lane drained without repair |
| Fresh versus retained attribution | `PASS` | Fresh control reproduced the retained tail |
| 232 incoming-message/s complete acceptance | `FAIL` | Final control accepted 6,374 of 13,920 |
| Three 30-minute target repetitions | `MISSING` | Fail-fast prerequisite did not pass |
| 60-million-message Production Acceptance Corpus | `MISSING` | Fail-fast prerequisite did not pass |
| Integrated production qualification | `FAIL` | Mandatory target acceptance failed |

Running longer target repetitions or seeding 60 million retained messages
cannot reverse a capacity failure already present in the 60-second fresh
control. Those expensive lanes were intentionally not run.

## Decision boundary

Keep the accepted transactional-outbox, Pub/Sub push, point-claim, finite
lease, claim epoch, terminal fence, durable global budget, and Principal-first
fairness contracts.

Do not claim that the current synchronous fair relay is production-qualified.
The next implementation must make fair selection and publication progress
concurrent without weakening the 32-permit terminal bound or replay recovery,
then restart qualification at the 60-second target gate. Deployment placement,
resource names, and IaC remain out of scope and belong to the GCP deployment
contract.

## Corrective continuation

Ticket 47 implemented and measured the missing publication seam. The result
improves the contract but does not change the integrated production verdict.

The selector now holds its advisory lock only for one bounded selection
transaction. Selection atomically creates active publication tasks. Four
publisher workers claim those tasks using an owner, finite lease, and monotonic
publication epoch, then issue asynchronous Pub/Sub publications outside the
selector lock. Provider confirmation records append-only attempt evidence,
marks the outbox record published, deletes only the matching owner and epoch,
and releases the fair dispatch permit.

The corrected module split is:

```text
Principal-first selector
  -> reserve bounded dispatch permit
  -> create durable publication task
  -> release selector lock

publication owner
  -> claim task with lease and epoch
  -> publish asynchronously
  -> record provider outcome
  -> confirm outbox and release dispatch permit

worker
  -> point-claim AgentRun with claim epoch
  -> keep per-Thread gate and durable obligations authoritative
  -> release them only on durable wait or terminal authority
```

The publication permit is not an execution lease. Keeping it until AgentRun
terminal completion incorrectly coupled Principal-first publication capacity
to Pub/Sub delivery and worker latency. PostgreSQL integration tests now prove
that publication confirmation frees the dispatch permit while the per-Thread
gate remains in flight. The benchmark does not model a Waiting AgentRun or its
durable wake condition, so the separate wait-release acceptance lane remains
`MISSING` and must be supplied by the AgentRun and Temporal integration rather
than simulated with the model-call timer.

### Corrective evidence

Provider confirmation recovery passed both controlled loss points. Loss before
publish advanced the task from epoch 1 to epoch 2 with no duplicate
publication. Loss after provider confirmation advanced to epoch 2 and produced
one expected duplicate publication. Both lanes ended with one terminal commit,
zero active publication tasks, zero leaked permits, and zero reconciliation
mismatch.

Raw local evidence includes caller samples, publication samples with owner,
epoch, lease, selection, request, and confirmation timestamps, delivery-tail
samples, runtime and database logs, monitoring time series, query plans,
topology manifests, audits, and checksums.

| Corrected 60-second target control | Accepted / offered | Result |
| --- | ---: | --- |
| Release on confirmation, 32 dispatch permits, worker concurrency 16 | 7,643 / 13,920 | `FAIL` |
| 96 dispatch permits, worker concurrency 16 | 7,335 / 13,920 | `FAIL` |
| 96 permits, worker concurrency 4, max 8 | 8,600 / 13,920 | `FAIL` |
| 96 permits, worker concurrency 4, max 16 | 8,432 / 13,920 | `FAIL` |
| 96 permits, worker concurrency 2, max 16 | 8,833 / 13,920 | `FAIL` |
| Same shape with a 12-worker warm floor | 8,742 / 13,920 | `FAIL` |

The best corrected target control completed all 12,595 AgentRuns created by
8,833 accepted messages. It recorded zero nonterminal AgentRuns, unpublished
outbox records, active publication tasks, duplicate terminal commits, global
budget mismatch, or Principal budget mismatch. Complete target acceptance is
mandatory, so exact reconciliation of partial acceptance does not qualify the
shape.

Concurrent publication removed the selector-lock ambiguity and reduced the
selection-to-publish-request interval to tens of milliseconds. Releasing the
dispatch permit at provider confirmation also removed terminal latency from
publication flow control. The remaining target shortfall is downstream of
provider confirmation. Lower worker concurrency removed database-pool wait,
and worker max 16 was observed, but neither a larger ceiling nor a 12-worker
warm floor produced complete acceptance. Cloud SQL CPU remained below
saturation and every delivered message completed without retry.

### Final qualification

| Gate | Result | Reason |
| --- | --- | --- |
| Durable publication ownership and epoch recovery | `PASS` | Both ambiguous loss points recovered exactly |
| Selector lock limited to selection | `PASS` | Network publication occurs after lock release |
| Bounded asynchronous publication | `PASS` | Four publisher workers, finite tasks, leases, and epochs |
| Exact authority and reconciliation | `PASS` | Zero mismatch in every corrected lane |
| Noisy-Principal starvation challenge | `FAIL` | Quiet progress remained bounded but some quiet commands were rejected when the global admission budget filled |
| 232 incoming-message/s complete acceptance | `FAIL` | Best corrected lane accepted 8,833 of 13,920 |
| Durable-wait release and wake | `MISSING` | The Pub/Sub seam prototype has no Waiting AgentRun lifecycle |
| Three 30-minute target repetitions | `MISSING` | The prerequisite 60-second target gate failed |
| Production Acceptance Corpus | `MISSING` | The prerequisite 60-second target gate failed |
| Integrated production qualification | `FAIL` | Mandatory target acceptance failed |

Keep the corrected publication ownership module. Do not restore the global
selector lock or hold a dispatch permit until terminal completion. Also do not
claim the authenticated Pub/Sub push topology as production-ready from this
evidence. A different delivery and worker activation contract, or another
measured control that passes the short target gate, is required before the
longer qualification lanes can run. Deployment placement and IaC remain with
the GCP deployment contract.

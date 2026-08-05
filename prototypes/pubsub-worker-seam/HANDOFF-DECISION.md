# Pub/Sub handoff decision

## Verdict

Select transactional-outbox publication followed by authenticated Pub/Sub push
and point-addressed PostgreSQL claims. Reject direct PostgreSQL plus Pub/Sub
dual-write under every ordering.

This selects the atomic handoff. It does not claim that every production
deployment gate is complete. Retained-corpus p99, Principal starvation
resistance, integrated Temporal execution, and full lifecycle cost remain
explicit qualification work.

## Decision table

| Gate | B2 direct dual-write | B3 transactional outbox | Decision |
| --- | --- | --- | --- |
| Durable acceptance | `FAIL` | `PASS` in exercised cuts | B2 prohibited |
| Ghost-free authority | `FAIL` | `PASS` | B3 |
| Duplicate safety | `PASS` through fencing | `PASS` through fencing | Same worker contract |
| 232/s target | short characterization only | 139,200 accepted, 208,800 terminal over 10 minutes | B3 target evidence accepted |
| 464/s overload | all accepted in unsafe short control | 15,148 accepted, 12,692 typed rejections, 252.5 Good Root Outcomes/s | B3 bounded overload |
| Target handoff latency | 283.5 ms p95 in short lane | 215.3 ms p95, 1,467.8 ms p99 in retained-corpus lane | p99 follow-up required |
| Automatic recovery | `FAIL` for unobserved database-first gaps | `PASS` for exercised worker and relay cuts | B3 |
| Per-Thread order | same fenced worker side | commit-order sequence plus predecessor gate | B3 contract |
| Principal starvation resistance | `MISSING` | `MISSING` | production gate, no selection claim |
| Integrated Temporal execution | `MISSING` in candidate harness | `MISSING` in candidate harness | consume lifecycle evidence, rerun in production slice |
| Complete monthly cost | `MISSING` | `MISSING` | no total-cost claim |
| Teardown | zero owned residue | zero owned residue | pass |

Correctness decides the handoff. B2's missing performance work cannot repair an
accepted AgentRun that has no durable broker obligation. B3 may miss a latency,
capacity, fairness, or cost gate and still remain the only admissible handoff
candidate. Such a miss blocks production qualification rather than reviving B2.

## Exact call flows

### Admission

```text
1. Authenticate Principal and validate command, payload, and idempotency key.
2. Begin PostgreSQL transaction.
3. Read an existing receipt or reject conflicting idempotency reuse.
4. Check global and per-Principal durable-obligation limits.
5. Allocate canonical Thread order under the Thread commit gate.
6. Append input ThreadEvent and create AgentRun rows with ExecutionProfileRef.
7. Reserve one durable in-flight obligation per AgentRun.
8. Append one immutable outbox record per AgentRun in the same transaction.
9. Commit and return the immutable acceptance receipt.
10. If commit outcome is unknown, retry the same idempotency key and reconcile.
```

No accepted AgentRun exists without an outbox obligation. No outbox obligation
exists without AgentRun authority.

### Relay

```text
1. One relay loop owns each publication shard through a PostgreSQL advisory lock.
2. Read append-only records after that shard's monotonic progress cursor.
3. Publish AgentRunId, DeliveryId, ordering key, and minimal routing metadata.
4. Wait for Pub/Sub publication confirmation.
5. Record confirmation and advance progress only across a confirmed prefix.
6. On ambiguous confirmation, do not guess. Replay the identity.
7. Retain sealed partitions through every cursor and replay-safety window.
8. Drop a partition only after the retention proof passes.
```

Independent shard loops prevent one slow publication confirmation from stopping
unrelated shards. A crash between steps 4 and 5 republishes work but cannot
create a second authoritative completion.

### Delivery and point claim

```text
1. Pub/Sub sends an OIDC-authenticated push request.
2. Validate the envelope and point-read AgentRunId.
3. If terminal or absent, acknowledge the obsolete delivery.
4. If the Thread predecessor is not terminal, return retryable failure.
5. If pending or its lease expired, atomically increment claim epoch, set lease,
   and commit AgentRunAttempt.
6. Execute only from PostgreSQL-authoritative input and pinned configuration.
7. Every authoritative mutation checks AgentRunId and claim epoch.
8. Terminal transaction commits normalized outcome, releases durable capacity,
   and records the current attempt complete.
9. Acknowledge Pub/Sub only after step 8 commits.
```

### Acknowledgement and recovery

```text
worker crash before terminal commit
  -> no acknowledgement
  -> Pub/Sub redelivery
  -> finite lease expiry
  -> new claim epoch
  -> stale attempt cannot commit

relay crash after broker confirmation
  -> progress not advanced
  -> duplicate publication
  -> point claim and epoch fence converge to one terminal result

broker outage
  -> admission continues only within durable-obligation budget
  -> outbox backlog is authoritative and measurable
  -> relay resumes automatically after recovery
  -> excess demand receives typed rejection before acceptance
```

## Identity reconciliation

The raw B2 evidence is preserved at commit
[`bf53d85`](https://github.com/heyimcarlos/osfo/commit/bf53d85). Its hard-cut
audits carry concrete benchmark identities for database-first, publish-first,
and concurrent failure windows. The sealed matrix records 162 lanes, 16,200
faulted primary requests, 8,100 retries, 5,712 stranded AgentRuns, 4,722 ghost
attempts, 8,100 irreconcilable no-retry outcomes, 5,850 duplicate publications,
and zero duplicate terminal commits.

The corrected B3 boundary evidence is preserved at commit
[`d0a41cb`](https://github.com/heyimcarlos/osfo/commit/d0a41cb). Twenty-four
boundary lanes reconciled 2,400 accepted messages to 3,600 terminal AgentRuns
with zero unpublished obligations, stranding, ghosts, or duplicate terminal
commits. The expected 150 ambiguous-confirmation republications were fenced.

Production-shaped Runtime and durable-budget evidence is preserved in commits
[`4c5e9b6`](https://github.com/heyimcarlos/osfo/commit/4c5e9b6) and
[`65f1319`](https://github.com/heyimcarlos/osfo/commit/65f1319). It adds one
ModelCall and accountable ModelCallAttempt per AgentRun, exact durable-budget
release, worker-loss recovery, four hard admission boundaries, two hard relay
boundaries, and a bounded overload control.

Each evidence bundle includes or links its source commit, lane manifest,
topology, IAM, Cloud SQL, Pub/Sub, Cloud Run, audit, raw samples, provider
metrics, checksums, and teardown inventory. Historical bulky bundles remain
addressable by immutable commit even when removed from the current tree.

## Resource and teardown evidence

| Candidate | Resource evidence | Teardown evidence |
| --- | --- | --- |
| B2 | Cloud SQL, ingress, worker, topic, subscription, IAM, source commit in `bf53d85` | zero exact-prefix residue in `bf53d85` |
| B3 corrected control | Cloud SQL, ingress, relay, worker, topic, subscription, IAM, source commit in `d0a41cb` | zero exact-prefix residue in `d0a41cb` |
| B3 selected runtime shape | 64 sequence stripes, 16 budget stripes, 1,024 AgentRun capacity, ingress concurrency 16, four independent relay loops, min-zero push workers | [`teardown-verification.json`](evidence/b3-qualification-runtime-budget/teardown-verification.json) reports zero residue |

Production IaC owns final minimums, maxima, connection budgets, regional fault
domain, backup, restore, observability, and cost allocation. Prototype resource
ceilings are evidence inputs, not production defaults.

## Cost inputs and boundary

At 60 million incoming messages and 90 million pre-retry AgentRun deliveries
per month, dated Montréal list-price inputs give this B3 incremental lower bound:

| Input | Calculation | Monthly USD |
| --- | --- | ---: |
| One 1-vCPU, 1-GiB always-available relay | 730 hours at captured instance rates | 63.07 |
| Pub/Sub publish plus delivery | 180 million minimum 1 KiB operations | 6.71 |
| Authenticated push requests | 90 million at USD 0.40/million | 36.00 |
| Synthetic worker compute | 90 million x 15 ms / concurrency 32 | 1.56 |
| Incremental measured lower bound | sum | **107.34** |

B2's short-lane lower bound was USD 90.30/month at the same incoming-message
and AgentRun units. The figures are not a complete controlled cost comparison.
B3 adds at least the relay floor plus outbox WAL, storage, retention, vacuum, and
backup work. Ingress, Cloud SQL, Temporal Cloud, logging, monitoring, network,
retry amplification, real execution, and canonical retained history are missing
from both totals. Therefore the complete cost gate is `MISSING`, and no claim
that B3 is cheaper or production-affordable is made here.

## Qualification boundary

The architecture decision is final unless a new candidate can preserve atomic
admission and all authority invariants with stronger evidence. Production
approval still requires:

- the retained-corpus Pub/Sub push-to-claim p99 cause and selected control;
- a Principal-first starvation-resistance challenge lane;
- the selected handoff integrated with real Temporal execution and the Native
  Thread Transport reference journey;
- the full target, stress, outage, recovery, retained-corpus, and cost contract
  under the final GCP deployment manifest.

These gates can reject a deployment shape. They do not make direct dual-write
safe.

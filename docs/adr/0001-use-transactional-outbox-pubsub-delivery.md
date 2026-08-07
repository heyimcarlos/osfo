# ADR 0001: Use a transactional outbox with Pub/Sub primary delivery

Date: 2026-08-05

Status: Accepted architecture, production qualification remains evidence-gated

Supersedes: ADR 0001, Retain Cloud SQL direct AgentRun dispatch

## Context

Osfo must durably accept AgentRuns without making PostgreSQL the runnable-work
scheduler. PostgreSQL remains authoritative for AgentRun lifecycle and
canonical Thread state. Pub/Sub owns runnable-work buffering, delivery, flow
control, and redelivery.

This split creates an atomicity boundary. PostgreSQL cannot commit AgentRun
authority and publish to Pub/Sub in one transaction. The original B2 and B3
comparison used the same authenticated Pub/Sub push worker seam:

- B2 directly wrote PostgreSQL and published to Pub/Sub in either order or
  concurrently.
- B3 atomically committed AgentRuns and append-oriented outbox records, then an
  isolated relay published the outbox records.

The production workload target is 232 incoming messages/s. The current
Reference Workload Trace produces 1.5 AgentRuns per incoming message, or 348
AgentRuns/s before retries. The 464 incoming-message/s lane characterizes safe
overload and recovery rather than promising that all offered work is accepted.

## Decision

Select B3. One PostgreSQL admission transaction commits the acceptance receipt,
canonical input facts, AgentRuns, durable capacity reservations, and one outbox
record per AgentRun. An isolated relay publishes minimal delivery identities to
one ordered Pub/Sub subscription. A fixed fleet uses the official high-level
asynchronous StreamingPull client, claims AgentRuns by ID, executes only under
a finite lease and monotonic claim epoch, commits authoritative outcomes under
that fence, then acknowledges delivery.

```text
authenticated command
  -> PostgreSQL acceptance transaction
       -> receipt, ThreadEvent, AgentRun, budget reservation, outbox
  -> isolated confirmed-publication relay
  -> Pub/Sub topic and one ordered pull subscription
  -> fixed StreamingPull worker fleet
  -> point-addressed PostgreSQL claim with lease and epoch
  -> AgentRun execution and fenced terminal transaction
       -> outcome and durable-budget release
  -> Pub/Sub acknowledgement
```

The message envelope contains `AgentRunId`, a stable delivery identity, and
minimal routing metadata. Authoritative input and lifecycle state remain in
PostgreSQL. Workers never scan PostgreSQL for runnable work.

The current fixed-fleet candidate is six workers, four StreamingPull streams
per worker, 32 execution slots per worker, an eight-connection PostgreSQL pool
cap per worker, and explicit flow control. The fleet size is an IaC and operator
input. Metric-triggered worker autoscaling is not part of the selected recovery
contract. Production qualification remains evidence-gated.

The outbox is append-oriented. Relay progress is monotonic and advances only
after publication confirmation. A crash after broker confirmation but before
progress may republish an identity, which is safe. Retention removes a sealed
partition only after every relay cursor and replay-safety window has passed it.

Pub/Sub ordering keys do not replace PostgreSQL Thread ordering. The admission
transaction allocates each Thread sequence in commit order. A worker may claim
only when the predecessor is terminal. Duplicate or out-of-order deliveries
retry without changing authority.

Global and per-Principal non-terminal limits remain admission invariants. A
bounded Principal-first publication window selects one eligible Thread head at
a time by durable Principal and Thread virtual passes. Selection reads indexed
scheduler metadata and outbox Thread heads, never scans AgentRuns for runnable
work. Pub/Sub remains the primary delivery buffer after selection.

## Rejected alternative

B2 is prohibited. Every direct dual-write ordering has an unavoidable failure
window:

- database-first can strand accepted AgentRuns with no broker obligation;
- publish-first can create and acknowledge ghost work before authority exists;
- concurrent publication can produce either failure;
- caller retry cannot be the durable repair mechanism because the caller may
  disconnect or stop retrying.

Adding a reconciliation record or pending-row scanner would no longer be B2.
It would recreate B3 or introduce a new durable publisher topology.

## Evidence

The B2 negative control ran 162 corrected lanes, 16,200 primary faulted
requests, and 8,100 retries. It found 5,712 provably stranded AgentRuns, 4,722
ghost delivery attempts, and 8,100 irreconcilable no-retry outcomes. It produced
zero duplicate terminal commits, which confirms that fencing limits damage but
cannot repair the missing atomic handoff.

The historical B3 push control accepted 139,200 incoming messages over ten minutes and
completed all 208,800 AgentRuns. It recorded zero unknown outcomes, unpublished
obligations, stranded runs, ghost authority, unfinished semantic attempts,
duplicate terminal commits, or budget reconciliation mismatches. Worker loss,
four hard admission boundaries, and two post-confirmation relay boundaries
recovered without manual repair.

The bounded 464/s stress control accepted 15,148 messages, returned 12,692
typed overload responses, and completed all 22,703 authoritative AgentRuns. It
preserved 252.5 Good Root Outcomes/s, above the 232/s production target, and
drained to zero nonterminal work and zero durable-budget mismatch.

The retained-corpus target exposed a publish-to-claim p99 of 1,467.8 ms against
the historical one-second topology threshold. An identical fresh-database
control reproduced a 1,493.1 ms p99, of which 1,359.2 ms was Pub/Sub
publish-to-push arrival. Point and predecessor plans were sub-millisecond on a
71 MB database. Retained corpus depth is therefore not the primary cause, and
publish-to-claim remains an evidence-only characterization under the production
workload contract.

The Principal-first challenge offered one noisy Principal at 230 incoming
messages/s across 128 Threads while a quiet Principal remained continuously
eligible on one Thread. All 30 quiet inputs were accepted, its maximum queued
age was 1,005.435 ms, and it continued advancing while noisy backlog age reached
133,044.089 ms. The 32-permit window was fully used. All 6,868 accepted
AgentRuns completed with zero global or Principal budget mismatch and zero
duplicate terminal commits. Relay loss before publish, relay loss after broker
confirmation, and worker loss all recovered with zero leaked permits.

The first integrated 232 incoming-message/s qualification exposed a separate
capacity failure. The 32-permit fair window requires a mean selected-to-terminal
lifetime below 91.95 ms to carry the trace's 348 AgentRuns/s. The measured mean
was 125.8 ms before terminal pipelining and 98.0 ms after it. The final
60-second control accepted 6,374 of 13,920 commands, while every one of its
8,282 accepted AgentRuns completed with zero correctness or budget mismatch.
Production qualification is `FAIL`; the required 30-minute and 60-million
retained-message lanes remain `MISSING` because the prerequisite target gate
failed.

A Ticket 47 corrective continuation separated Principal-first selection from
publication ownership. The selector now creates durable publication tasks in
one bounded transaction and releases its advisory lock before Pub/Sub calls.
Bounded publisher workers claim tasks with finite leases and monotonic epochs.
Provider confirmation records evidence, confirms the outbox record, and
releases the dispatch permit while the per-Thread gate and durable obligations
remain authoritative until wait or terminal.

Recovery passed loss before publish and loss after provider confirmation. Both
advanced to publication epoch 2, drained automatically, and ended with zero
active publication tasks, leaked permits, or authority mismatch. The
post-confirmation loss produced one expected duplicate publication and one
terminal commit.

Integrated capacity still failed. Corrected 60-second target controls varied
the dispatch window, worker concurrency, worker ceiling, and warm floor. The
best accepted 8,833 of 13,920 offered commands and completed all 12,595 derived
AgentRuns exactly. A max-16 worker ceiling and a 12-worker warm floor did not
close the gap. That historical push short-target gate is `FAIL`; its longer
target and Production Acceptance Corpus lanes remain `MISSING`.

Issue 87 subsequently selected one ordered subscription and a fixed
StreamingPull fleet. A 64-stripe 60-second control accepted all 13,920 commands
and completed all 20,880 AgentRuns. Two 30-minute Montreal repetitions accepted
all 417,600 commands and completed all 626,400 AgentRuns, but the second failed
the receipt-latency gate. The smallest recovery-rate candidate with adequate
tail headroom was six workers. The final `us-east4` A/B/C/D matrix then failed
admission in every cell while reconciling accepted work exactly. Its retained
history hypothesis is supported. A larger WAL envelope reduced WAL and
checkpoint churn but did not qualify admission. Both provider roots tore down
with zero manifest-owned cloud residue. Full `us-east4` production
qualification remains `MISSING`.

The checksummed comparison, exact call flows, reconciliation pointers,
resource manifests, cost boundary, and teardown proof are in
[`HANDOFF-DECISION.md`](../../prototypes/pubsub-worker-seam/HANDOFF-DECISION.md)
and the offline
[`handoff-dashboard.html`](../../prototypes/pubsub-worker-seam/handoff-dashboard.html).
The fairness call flow, rejected shapes, compact evidence, and production
contract are in
[`PRINCIPAL-FAIRNESS-STUDY.md`](../../prototypes/pubsub-worker-seam/PRINCIPAL-FAIRNESS-STUDY.md).
The retained-tail attribution, integrated target controls, and fail-closed
qualification are in
[`B3-RETAINED-TAIL-QUALIFICATION.md`](../../prototypes/pubsub-worker-seam/B3-RETAINED-TAIL-QUALIFICATION.md).

## Cost boundary

No complete B2/B3 lifecycle-cost comparison was measured, so this ADR makes no
total-cost claim. The historical push estimate included push-request pricing
and does not price the selected fixed StreamingPull fleet. Current incremental
relay, Pub/Sub, worker idle floor, worker execution, PostgreSQL, and monitoring
cost remains `MISSING` until the selected production topology is measured.

That lower bound excludes ingress, Cloud SQL, Temporal Cloud, outbox storage,
WAL, backups, retention, logging, monitoring, networking, retry amplification,
and real execution. Those omissions are explicit and must be priced by the GCP
deployment contract before production approval.

## Consequences

- Durable acceptance no longer depends on two independent writes succeeding.
- PostgreSQL remains lifecycle authority but no longer performs broad runnable
  discovery.
- Pub/Sub redelivery is expected. Point claims, claim epochs, and terminal
  fences make duplicates harmless.
- The relay and outbox add observable operational state, WAL, retention,
  maintenance, and cost. They are not treated as free.
- One ordered subscription and a fixed StreamingPull fleet are the selected
  worker-delivery topology. Authenticated push, min-zero activation, CREMA, and
  subscription sharding are rejected for the current contract.
- Retained history was not the cause of the historical push delivery tail. The
  selected StreamingPull topology still requires complete production-region
  qualification.
- Dispatch permits are publication flow control and release on durable provider
  confirmation. They are not held until AgentRun terminal completion.
- Durable publication tasks with owner, lease, and epoch recovery replace the
  selector-wide publication lock.
- Full production approval remains blocked. The selected StreamingPull short
  target passed, but the final `us-east4` matrix failed admission at the target
  rate. Admission stability under exact retained history must pass before the
  overload knee, 400,000-AgentRun reserve outage and drain, retained corpora,
  user-visible SLO, bounded-resource, and complete-cost gates can qualify a
  final production manifest.

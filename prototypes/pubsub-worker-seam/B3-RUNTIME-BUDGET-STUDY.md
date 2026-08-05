# B3 production-shaped Runtime and durable budget study

## Status

The durable budget and production-shaped Runtime invariants pass local and
short cloud controls. A ten-minute sustained target lane using the corrected
admission transaction is running under the persistent qualification
controller. This document is an evidence note for the Issue 38 prototype, not
a production implementation specification.

## Wayfinder alignment

The experiment now consumes the resolved decisions from:

- **Define the Oz-first implementation strategy**: the deterministic path is a
  vertical interaction slice rather than a generic queue job;
- **Choose the production language and runtime**: production remains
  TypeScript, Effect 4, and Node 24 LTS. Go remains disposable benchmark code;
- **Define the production workload and SLO contract**: incoming messages,
  AgentRuns, ModelCalls, attempts, and Good Root Outcomes have separate
  identities and denominators;
- **Define the Agent Runtime and Model Adapter seams**: an authority-free
  Runtime proposes a semantic step, the durable driver records intent, and an
  executor receives only a committed ModelCallAttempt.

The open **Define Native Thread Transport conformance** and **Choose the GCP
deployment and IaC contract** decisions are not preempted by this prototype.

## Production-shaped deterministic call flow

```text
IncomingMessage admission transaction
  -> reserve 1..N AgentRun obligations in a durable budget stripe
  -> commit admission receipt, AgentRuns, ExecutionProfileRef, and outbox rows

Pub/Sub delivery
  -> point claim AgentRun
  -> commit fenced AgentRunAttempt
  -> AgentRuntime.proposeNextStep(currentState)
  -> commit ModelCall and accountable ModelCallAttempt
  -> deterministic ModelCallExecutor executes committed attempt
  -> AgentRuntime proposes AgentRun success
  -> atomically commit normalized ModelCall outcome and AgentRun terminal state
  -> release one durable AgentRun budget obligation
  -> acknowledge Pub/Sub delivery
```

The terminal transaction is the important release boundary. Process-local
completion cannot return capacity. A stale claim epoch cannot commit a terminal
outcome or release a slot.

## Durable budget geometry

The first control used 512 AgentRuns across 64 strict stripes. It was rejected.
At only 23 incoming messages/s, two messages received typed overload even
though total accepted work had not reached global capacity. Eight slots per
stripe were too small for ordinary hash variance, which created false overload
through quota fragmentation.

The corrected control uses 1,024 AgentRuns across 16 stripes:

- 64 obligations per stripe;
- about 2.94 seconds of target AgentRun demand at 348 AgentRuns/s;
- one row lock per admission transaction;
- no publisher, queue, coordinator process, or always-on server;
- exact release in the authoritative terminal transaction;
- typed HTTP 429 rejection with bounded retry guidance when a stripe is full.

This is a static v1 safety bound. It is not an adaptive controller or a product
SLO. Later production sizing must remeasure the Reference Workload Trace after
material Agent Runtime, tool, workflow, provider, or fan-out changes.

## Admission contention controls

The first sustained attempt exposed two prototype-local bottlenecks before the
durable budget was full:

- an 80-slot process-local admission guard rejected 43 target messages, so it
  was disabled in favor of the authoritative database budget;
- with the local guard removed, Cloud Run queued far more requests than the
  ingress database pool could serve, so ingress concurrency was reduced from
  100 to 16;
- four outbox sequence-gate rows still serialized admission transactions, so
  the gate lock was moved immediately before outbox insertion and expanded to
  64 stripes;
- the budget reservation was moved to the end of the transaction, minimizing
  how long each scarce budget row remains locked;
- a missing outbox sequence lookup index reduced the retained-corpus audit from
  roughly two minutes to roughly three seconds.

With 64 sequence stripes, 16 budget stripes, ingress concurrency 16, and no
process-local guard, the corrected one-minute target prelude accepted all
13,920 messages. Caller admission was p95 72.5 ms and p99 101.2 ms. All 20,880
AgentRuns reached a terminal state, publish-to-claim was p95 241.7 ms and p99
376.8 ms, and the durable budget reconciled to zero.

The subscription is reset once before warm-up, not before every traffic lane.
Recreating it immediately before target traffic produced a first-five-second
push startup discontinuity and is not representative of the long-lived
production subscription.

The first 64-stripe sustained lane then found a downstream isolation defect.
After 94,150 accepted messages, one Pub/Sub publication confirmation took 9.2
seconds. The relay waited at a barrier across all four shards, so that one slow
confirmation stopped all publication. All 16 budget stripes correctly reached
their 64-run limit, 1,501 sampled offers were durably rejected, and all
accepted work later drained with zero reconciliation mismatch. The relay now
runs each shard in an independent loop so a slow provider confirmation cannot
freeze unrelated shards. The interrupted lane and its recovered audit are
retained as failure evidence.

The independent-shard ten-minute lane accepted all 139,200 messages and
completed all 208,800 AgentRuns, but missed the target publish-to-claim p99
gate: p95 was 215.3 ms and p99 was 1,467.8 ms. Relay confirmation p99 was only
140.4 ms, which placed the remaining tail between Pub/Sub push and the database
claim. Cloud SQL averaged 73 percent CPU and peaked at 83 percent while worker
CPU averaged about 23 percent. Successful delivery evidence is therefore now
inserted inside the authoritative terminal transaction instead of using one
additional transaction per AgentRun.

That transaction-folding control did not improve the downstream tail. Its
one-minute prelude accepted all 13,920 messages and reconciled completely, but
publish-to-claim was p95 1,288.8 ms and p99 2,354.3 ms. The controller stopped
before another sustained lane. The remaining variation is therefore not
explained by the extra delivery-evidence commit. Correctness and bounded
overload behavior are qualified, but the accepted target p99 performance gate
remains unresolved on the retained 4-vCPU Cloud SQL prototype corpus.

## Short control results

### Warm-up, 23 incoming messages/s for 10 seconds

- 230 offered and accepted;
- 345 authoritative AgentRuns and 345 terminal outcomes;
- 230 Good Root Outcomes;
- 345 ModelCalls and 345 ModelCallAttempts;
- zero unfinished AgentRunAttempts or ModelCallAttempts;
- zero budget use or reconciliation mismatch after drain;
- caller p95 60.5 ms and p99 156.5 ms.

### Target, 232 incoming messages/s for 60 seconds

- 13,920 offered and accepted;
- 20,880 authoritative AgentRuns and 20,880 terminal outcomes;
- 13,920 Good Root Outcomes;
- exactly one ModelCall and ModelCallAttempt per AgentRun;
- zero unknowns, ghosts, stranding, unpublished outbox records, duplicate
  publications, duplicate terminal commits, or unfinished attempts;
- caller p95 228.7 ms and p99 301.6 ms;
- publish-to-point-claim p95 226.1 ms and p99 950.3 ms;
- zero budget use and zero reconciliation mismatch after drain.

### Stress, 464 incoming messages/s for 60 seconds

- 27,840 offered;
- 15,148 accepted and 12,692 typed HTTP 429 rejections;
- zero caller drops, unknown outcomes, or rejections without retry guidance;
- accepted Goodput 252.5 incoming messages/s, above the 232/s target;
- 22,703 authoritative AgentRuns and 22,703 terminal outcomes;
- 15,148 Good Root Outcomes, a 1.0 deterministic ratio;
- publish-to-point-claim p95 384.3 ms and p99 954.0 ms;
- zero nonterminal work, budget use, or budget reconciliation mismatch after
  the fixed audit window.

The earlier unbounded stress control reached a 65.6-second publish-to-claim p95.
The durable budget reduces accepted work before that broker debt can form while
preserving more than target Goodput.

## Qualification interpretation

The historical 250 ms p95 and 500 ms p99 topology thresholds remain target
headroom evidence. They are not stress product SLOs. Stress acceptance follows
the topology-neutral contract: typed pre-acceptance rejection, zero unknowns,
target Goodput, complete deterministic Good Root Outcomes, bounded resources,
and automatic drain. The runner retains target latency gates and uses a bounded
2-second p99 publish-to-claim characterization for this stress control.

## Failure-cut results

- worker process loss after claim redelivered into a second fenced
  AgentRunAttempt, committed exactly one ModelCall and ModelCallAttempt, and
  released the durable budget exactly once;
- four hard admission crash boundaries converged through idempotent retry to
  one accepted message and one terminal AgentRun;
- both hard relay post-confirmation crash boundaries converged without an
  unpublished outbox record or duplicate terminal commit;
- 12 admission matrix controls and the first relay control passed across three
  deterministic seeds and 100 repetitions per cut;
- the remaining soft relay matrix stopped when the deployed relay won the
  advisory-lock race before fault injection. This is retained as a harness
  limitation, not counted as a topology failure or pass.

## Remaining gates

- resolve the retained-corpus and broker-to-claim p99 performance gate;
- isolate the soft relay cut matrix from the deployed relay;
- characterize a longer stress window and recovery slope if the sustained
  target remains clean;
- keep Native Thread Transport, real provider behavior, Temporal workflows,
  retained corpora, and final GCP IaC decisions in their owning tickets.

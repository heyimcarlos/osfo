# Principal-first Pub/Sub dispatch study

## Verdict

Select a bounded Principal-first publication selector between the transactional
outbox and Pub/Sub. The selector preserves Principal starvation resistance
without returning runnable-work discovery to `agent_runs`.

The selected call flow is:

```text
authenticated admission
  -> AgentRun authority, outbox, and durable obligation budgets commit together
  -> one bounded selector chooses Principal, then eligible Thread head
  -> selected outbox identity is published to Pub/Sub
  -> authenticated push point-claims AgentRunId under lease and claim epoch
  -> terminal transaction releases Thread, Principal, dispatch, and global budgets
```

This resolves the fairness seam in issue 50. It does not claim full deployment
qualification. Retained-corpus tail latency, production Temporal integration,
and the complete deployment cost and recovery contract remain separate gates.

## Selected state model

Fairness identity is the authenticated `Principal`. Parentage, child fan-out,
Thread count, and message count do not create additional Principal identities.

The selector maintains only bounded scheduler metadata:

- `b3_fair_principals.virtual_pass` is the durable Principal cursor.
- `b3_fair_threads.virtual_pass` and `next_dispatch_sequence` choose one eligible
  Thread head and preserve per-Thread order.
- `b3_fair_dispatch_budget.in_use` bounds selected but nonterminal work.
- `b3_outbox.fair_selected_at` makes selection recoverable before publication.
- `b3_outbox.fair_published_at` records confirmed publication.
- Sixteen per-Principal obligation stripes enforce admission limits without one
  hot Principal row serializing every admission.

The selector holds one advisory ownership lock, recovers already selected and
unconfirmed records first, then fills at most the available dispatch permits.
Selection reads the indexed Principal and Thread scheduler tables plus the
indexed outbox Thread head. Workers still point-read one `AgentRunId`; they do
not scan `agent_runs` for runnable work.

The 32-permit window is independent from the 8,192 admitted-obligation budget.
One Principal may use every compatible permit when alone. When another
Principal becomes eligible, each newly available permit is assigned by the
lowest durable Principal virtual pass before Thread selection.

## Production-shaped GCP challenge

The passing lane used Cloud SQL for PostgreSQL 17 with 4 vCPU and 15 GiB,
authenticated Pub/Sub push with ordering enabled, one fixed Cloud Run worker
instance, worker concurrency 8, four execution slots, ingress concurrency 16,
64 outbox sequence stripes, 16 global-budget stripes, a 32-permit dispatch
window, and a 4,096 AgentRun per-Principal obligation limit.

The noisy Principal offered 230 incoming messages/s for 75 seconds across 128
Threads. The quiet Principal began 15 seconds later and offered 0.5 incoming
messages/s for 60 seconds on one Thread. The Reference Workload Trace expanded
accepted inputs to one or two AgentRuns.

| Gate | Result |
| --- | ---: |
| Quiet caller outcomes | 30 accepted, 0 rejected or unknown |
| Noisy caller outcomes | 5,191 accepted, 12,059 typed overload rejections |
| Authoritative AgentRuns | 6,868 succeeded of 6,868 |
| Quiet maximum queued age | 1,005.435 ms |
| Noisy maximum queued age | 133,044.089 ms |
| Dispatch window utilization | 32 of 32 permits |
| Duplicate terminal commits | 0 |
| Global budget mismatch | 0 |
| Principal budget mismatch | 0 |
| Final dispatch state | 0 permits, 0 queued Principals |

The result is both fair and work-conserving. The quiet Principal continued to
advance while the noisy Principal retained more than two minutes of backlog,
and the selector used the full dispatch window. All overload responses were the
declared typed rejection with retry guidance, not platform errors.

The two Cloud SQL monitoring samples captured during the final interval peaked
at 40.5 percent CPU and 42.4 percent memory utilization, with 54 PostgreSQL
backends. This short sample is a resource observation, not a sizing claim.

## Recovery evidence

The fair relay was hard-stopped at two new state boundaries:

1. After durable selection but before publish, the snapshot showed one held
   permit. A replacement relay recovered the selected outbox identity, produced
   one terminal result, and released the permit.
2. After provider confirmation but before saving fair publication progress, a
   replacement relay republished once. Pub/Sub delivered twice, but the point
   claim converged to one ModelCall and one terminal result. No permit leaked.

A fair AgentRun worker-loss probe produced two AgentRunAttempts, one ModelCall,
one terminal result, zero budget mismatch, and zero final dispatch permits.

## Rejected shapes and useful failures

The first deployed version updated one per-Principal admission row. A noisy
Principal serialized ingress on that row: only 396 of 17,250 noisy offers and 1
of 120 quiet offers were accepted, with platform timeouts and unknown outcomes.
The fix striped the durable per-Principal obligation counter across 16 rows and
left the Principal selector row owned only by the selector.

The next lane offered 2 quiet messages/s to one ordered Thread. The trace
expanded that to about 3 AgentRuns/s, above the measured serial Thread capacity,
so its 77,970 ms queue age demonstrated quiet self-overload rather than noisy
Principal starvation. The corrected lane offered 0.5 messages/s, about 0.75
AgentRuns/s, below the serial Thread capacity.

A recovery-probe attempt admitted work immediately after deleting an always-on
Cloud Run relay. The retiring instance finished that work before the local
crash injector could select it. The corrected probe waits for instance exit
before admission. The diagnostic is retained because it documents the
operational behavior of background Cloud Run instances during service deletion.

## Evidence identity

The local raw bundles are sealed by these manifests:

| Bundle | SHA-256 of sealed manifest |
| --- | --- |
| Passing noisy-Principal lane | `0845dea700fbfb30eabd703c80c91e803f9ad80949ac85d1ef1b360078ef1fda` |
| Fair relay process-loss lane | `ccf80d11909f617bfb5d455f31e5baa43d5fc97d350490ccc1b369f2c2dc617b` |
| Fair worker process-loss lane | `a834ec8863f4cb843d33003b655a741f6bc6afb53bdfa0ce7cf4f98f967f3d7c` |
| Exact-prefix teardown proof | `47bd14c67d404f7be14c84d31a1b553ebd092987f4fa632531de78169d1ca54d` |

The compact decision evidence is
[`decision.json`](evidence/b3-fairness-window-v2/decision.json). The raw local
bundle includes caller samples, runtime logs, Cloud Monitoring exports, IAM and
topology captures, source-tree hashes, audits, diagnostic failures, and
per-directory checksums. Exact-prefix teardown reports zero Cloud Run, Cloud
SQL, Pub/Sub, Artifact Registry, Secret Manager, or service-account residue.

## Production contract

The production GCP manifest must preserve these gates:

- Principal identity comes from authentication and cannot be selected by the
  caller or multiplied through child AgentRuns.
- Dispatch permits are bounded from compatible worker capacity and declared
  broker prefetch, not from admitted backlog.
- Per-Principal and global durable-obligation limits reject before acceptance.
- Selection, publication confirmation, terminal release, and their mismatch
  counts are observable.
- Relay loss replays selected identities; worker loss relies on Pub/Sub
  redelivery, finite leases, and claim-epoch fencing.
- The challenge lane includes a continuously eligible quiet Principal, a noisy
  Principal with many Threads and child AgentRuns, one-Principal work
  conservation, per-Thread ordering, overload, retained data, and exact-prefix
  teardown.
- Production qualification reruns the lane with the Production Acceptance
  Corpus and integrated Temporal execution under the final deployment limits.

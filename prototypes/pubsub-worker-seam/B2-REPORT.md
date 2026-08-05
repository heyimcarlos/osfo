# Issue 35 decision: direct PostgreSQL plus Pub/Sub dual-write

## Verdict

Direct PostgreSQL plus Pub/Sub dual-write is unshippable for durable AgentRun
acceptance.

All three orderings failed at least one fixed correctness gate under controlled
boundary cuts. Database-first can commit authority without a broker obligation.
Publish-first can deliver and acknowledge an AgentRun ID before authority
exists. Concurrent ordering can produce either result. A caller retry is useful
recovery assistance, but it is not a durable reconciliation mechanism and is
not guaranteed to happen.

The negative-control decision is complete. The full production-shaped
performance comparison is not. The report marks every unexecuted frozen lane
`MISSING`; no short smoke is promoted into a production pass.

## Frozen topology

The prototype added only the admission side. It reused the Issue 39 worker
handler and point-claim implementation without changing their behavior:

```text
authenticated incoming message
              |
              v
   direct PostgreSQL commit
              +
      direct Pub/Sub publish
              |
              v
authenticated push, min 0 / max 8
              |
              v
point claim by AgentRunId, claim epoch, terminal fence, acknowledgement
```

Each message deterministically created one root AgentRun and every second
message created one additional AgentRun, exactly 1.5 AgentRuns per incoming
message. Evidence tables were write-only during offer and drain. Candidate code
never read them, scanned pending rows, or repaired unpublished work.

## Hard process cuts

Each hard-cut admission ran in a separate local process against real Cloud SQL
and Pub/Sub, then exited immediately at the selected durable boundary.

| Ordering and cut | Authority | Terminal | Ghost attempts | Result |
| --- | ---: | ---: | ---: | --- |
| Database-first, after database | 1 | 0 | 0 | stranded accepted AgentRun |
| Database-first, after publish | 1 | 1 | 0 | work safe, caller outcome unknown |
| Publish-first, after publish | 0 | 0 | 1 | ghost acknowledged without authority |
| Publish-first, after database | 1 | 1 | 0 | work safe, caller outcome unknown |
| Concurrent, database wins | 1 | 0 | 0 | stranded accepted AgentRun |
| Concurrent, publish wins | 0 | 0 | 1 | ghost acknowledged without authority |

Every lane failed because one stranded run, one ghost, or one irreconcilable
unknown is enough. The checksummed source is under
`evidence/b2-negative-control/hard-process-cuts/`.

## Deterministic cut matrix

The corrected matrix ran nine cut and dependency-response classes for each of
database-first, publish-first, and concurrent ordering. Every class used 100
identities across three named seeds, with separate no-retry and retry-once
lanes. This produced 16,200 primary requests and 8,100 retries.

The conservative re-audit counts a run as provably stranded only when it has no
confirmed publication, or when every observed delivery was acknowledged before
authority existed. Published work still backed by a broker obligation is
reported separately and is not called stranded.

| Ordering | Retry | Accepted runs | Terminal | Provably stranded | Ghost attempts | Irreconcilable outcomes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Database-first | none | 3,600 | 1,350 | 2,250 | 0 | 2,700 |
| Database-first | once | 4,050 | 4,050 | 0 | 0 | 0 |
| Publish-first | none | 1,350 | 795 | 506 | 1,854 | 2,700 |
| Publish-first | once | 4,050 | 3,206 | 705 | 1,755 | 0 |
| Concurrent | none | 3,150 | 793 | 2,250 | 897 | 2,700 |
| Concurrent | once | 4,050 | 3,975 | 1 | 216 | 0 |

Across all lanes there were 5,712 provably stranded AgentRuns, 4,722 ghost
delivery attempts, 8,100 unresolved no-retry outcomes, 5,850 duplicate
publications, and zero duplicate terminal commits.

Database-first plus one guaranteed retry repaired every controlled case. That
does not satisfy durable acceptance because a client may disconnect, crash, or
stop retrying. Adding an automatic pending-row scan or durable reconciliation
record would change the topology into B3 or another candidate.

The corrected raw aggregates are in
`evidence/b2-negative-control/cut-matrix/reaudit.jsonl`. Two earlier runs are
retained locally as contaminated evidence: the sequential controller was
stopped, and the first parallel controller mixed serializable transaction
aborts into expected fault outcomes.

## Normal-path characterization

The manifest requires three 30-minute target repetitions and three 15-minute
stress repetitions. Those were not run because B2 had already failed its
non-negotiable durability gate. Two 60-second lanes characterize the path but
cannot establish a capacity pass.

| Lane | Messages | AgentRuns | Reconciled | Receipt p95 / p99 | Publish-to-claim p95 / p99 | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 232 messages/s | 13,920 | 20,880 | exact | 43.4 / 69.0 ms | 283.5 / 448.2 ms | correctness pass, latency fail |
| 464 messages/s | 27,840 | 41,760 | exact | 454.6 / 702.7 ms | 528.0 / 1,033.3 ms | correctness pass, latency fail |

The 232/s receipt thresholds passed. Publish-to-claim p95 exceeded the frozen
100 ms target threshold. At 464/s, publish-to-claim p95 exceeded the 250 ms
stress threshold, while p99 remained below 2 seconds. The isolated
publish-to-terminal distribution was not captured separately and remains
`MISSING`.

The 232/s provider samples showed about 45.2 percent ingress CPU, 9.2 percent
worker CPU, 23.5 percent Cloud SQL CPU, 41.8 percent Cloud SQL memory, and 31
database backends. These are two one-minute provider samples, not sustained
capacity evidence.

The restored 23/s baseline accepted 230 of 230 messages and terminalized 345
of 345 AgentRuns exactly once. Caller-to-receipt p95 was 65.3 ms.

## Partial cost lower bound

The 232/s smoke measured 50.103 ingress and 97.454 worker billable instance
seconds. Applying the Issue 39 August 4, 2026 Montréal list-price capture to
measured Cloud Run seconds, requests, and two minimum 1 KiB Pub/Sub operations
per AgentRun gives:

- $0.02095 for 13,920 incoming messages and 20,880 AgentRuns
- $0.001505 per 1,000 incoming messages
- $0.001003 per 1,000 AgentRuns
- about $90.30 per 60-million-message, 90-million-AgentRun month
- about $903.02 per 600-million-message, 900-million-AgentRun month

This is deliberately a lower bound. It omits Cloud SQL, Temporal, logging,
monitoring, networking, backup, retry and outage amplification, and real root
responses. The frozen cost gate is therefore `MISSING`, not `PASS`.

## Gate record

| Gate | Status | Evidence |
| --- | --- | --- |
| Correctness | `FAIL` | hard cuts and matrix produced stranded authority, ghosts, and unresolved outcomes |
| Sustained load and capacity | `MISSING` | only 60-second target and stress smokes were run |
| Latency | `FAIL` | short target and stress handoff p95 exceeded the frozen thresholds |
| Backlog and recovery | `FAIL` | no-retry database-first gaps have no broker obligation and cannot drain automatically |
| Cost | `MISSING` | partial handoff lower bound omits required costs |
| Evidence completeness | `MISSING` | mixed Temporal, fairness, ordering, 15-minute outage, three repetitions, and scale-from-proven-zero remain unexecuted |

The missing performance work cannot rescue B2's correctness result. It would
only characterize the cost of a topology that is already prohibited by the
fixed acceptance invariant.

## Contamination and limits

- The first smoke ran before Pub/Sub OIDC IAM propagation completed and is not
  used for latency.
- A later smoke inherited subscription push backoff from the cut matrix and is
  not used for capacity. Recreating the isolated subscription restored a clean
  provider state.
- Deadline, unavailable, and throttled publish responses were injected at the
  client boundary. Broker acceptance and ambiguous-response cuts used real
  Pub/Sub confirmations. A provider-generated fault campaign remains missing.
- The prototype uses synthetic 15 ms work. It does not claim a full model,
  Temporal, tool, workflow, sandbox, artifact, or streaming result.
- ADR 0001 was later replaced by the transactional-outbox and Pub/Sub
  primary-delivery decision. This report remains the negative-control evidence.

## Decision

Reject B2. Proceed to the transactional-outbox B3 prototype using the same
authenticated-push worker seam. B3 must prove that every accepted AgentRun has
a durable visible publication obligation and automatic recovery without a
runnable-work scan.

# B3 worker flow-control result

## Proposed verdict for human review

Worker concurrency eight is not the missing target fix. Keep Pub/Sub and the
transactional-outbox correctness finding, but stop this qualification branch.
Do not run its stress, failover, or full-manifest lanes because the admissible
warm target missed the frozen publish-to-point-claim p95 gate.

Ticket 38 remains open for the human verdict. The decision is whether to end B3
with an explicit latency failure and advance to the final topology decision, or
authorize a new candidate with a different cost or delivery contract. More
sequence stripes and more worker-concurrency tuning are not supported by the
evidence.

## Controlled variant

The study returned to four commit-order stripes and one active relay container.
It changed aligned Cloud Run request concurrency and application execution
slots from 32 to eight. The worker database pool remained four, worker scaling
remained min zero and max eight, and the Pub/Sub push acknowledgement deadline
remained 10 seconds.

The admissible lane reused a drained, authenticated subscription. A diagnostic
warm-up showed that recreating a subscription immediately before a lane adds a
large push slow-start tail, so the harness now records whether the subscription
was reset before each lane.

## Results

| Lane | Receipt p95 | Outbox confirmation p95 | Publish-to-claim p95 | Claim-to-terminal p95 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Fresh-subscription warm-up, 23/s for 10 seconds | 20.4 ms | 755.7 ms | 10,761.8 ms | 25.3 ms | Diagnostic only |
| Cold target with misplaced reuse flag | 26.5 ms | 74.3 ms | 136.2 ms | 21.9 ms | Contaminated |
| Warm qualified target, 232 incoming/s | 20.4 ms | 71.4 ms | 134.0 ms | 21.1 ms | Latency fail |

The qualified target accepted all 13,920 incoming messages and terminalized
all 20,880 AgentRuns. It had zero unpublished obligations, stranded AgentRuns,
ghost delivery attempts, duplicate publications, duplicate terminal commits,
or nonterminal AgentRuns at audit. Publish-to-claim p99 was 202.9 ms, but p95
was 134.0 ms against the frozen 100 ms gate.

Compared with the corrected four-stripe reference at 147.1 ms p95, the lower
worker concurrency improved the target by about 13 ms. Removing subscription
slow start changed the target by only another 2 ms. Neither effect is large
enough to qualify the topology.

## Resource and delivery evidence

The qualified window reached five active worker instances and one relay
instance. Captured Cloud SQL CPU peaked at 22.5 percent with 48 backends. The
selected Pub/Sub metric contained only acknowledged HTTP 204 responses, the
expired-acknowledgement metric was zero, and the retained runtime summary found
no error-severity entries or HTTP 4xx/5xx responses.

Claim-to-terminal p95 was only 21.1 ms and the database retained substantial
headroom. The remaining tail is therefore before the point claim, in the
publisher-confirmation and Pub/Sub push path, rather than in AgentRun execution
or an exhausted database. This is an inference from the combined latency and
resource evidence, not a provider-side trace.

## Decision implication

The study answers its question negatively: forcing earlier Cloud Run scale-out
with concurrency eight does not make the corrected outbox topology meet the
frozen target. The durability pattern remains valid, and Pub/Sub capacity is
not exhausted, but the selected min-zero ordered-push contract does not meet
the required target tail in this production-shaped handoff.

If the 100 ms gate remains binding, the next candidate must change a real
delivery or cost assumption, such as a warm worker floor or the selected
subscriber contract. That would be a new manifest variant, not another tuning
step inside this study.

All `osfo-b3-38-fc8-*` cloud resources were deleted. The harness and an
independent exact-prefix inventory both reported zero residue.

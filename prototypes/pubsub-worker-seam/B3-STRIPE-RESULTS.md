# B3 sequencing-stripe results

## Four-stripe reference

The archived corrected B3 smoke used four commit-order gates and four relay
owners.

| Lane | Accepted | Receipt p95 | Outbox p95 | Publish-to-claim p95 | Nonterminal at audit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 232/s | 13,920 | 15.8 ms | 95.8 ms | 147.1 ms | 0 |
| 464/s | 27,573 of 27,840 | 1,789.8 ms | 324.8 ms | 1,676.1 ms | 9,964 |

The stress client took 68.5 seconds and received 267 untyped HTTP 429
responses. Peak captured Cloud SQL CPU was about 43%, with 93 backends.

## Sixteen stripes, four relay owners

Source commit: `304370b`. The run used a fresh PostgreSQL 17 instance and fresh
Cloud Run, Pub/Sub, and service-account resources.

| Lane | Accepted | Receipt p95 | Outbox p95 | Publish-to-claim p95 | Nonterminal at audit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 232/s | 13,920 | 96.6 ms | 136.0 ms | 1,007.7 ms | 0 |
| 464/s | 27,840 | 1,333.7 ms | 21,084.0 ms | 46,537.7 ms | 3,640 |

Every offered stress request returned HTTP 201 and an authoritative accepted
outcome. The client completed in 62.6 seconds. There were zero unpublished
outbox obligations, stranded AgentRuns, ghost attempts, duplicate publications,
or duplicate terminal commits in either lane.

Widening the admission gates removed stress shedding and reduced receipt p95,
but it exposed a downstream capacity transfer. Peak captured Cloud SQL CPU rose
to about 62%, with 101 backends. Relay confirmation and worker claim latency
grew sharply under stress, so the 16-stripe topology fails the frozen latency
and drain gates.

The `osfo-b3-38-s16-*` resources were deleted after the run. The exact-prefix
teardown inventory reported zero owned cloud residue. Raw generated telemetry
was discarded after this compact record because large evidence bundles made
local source-control tooling unstable.

## Sixteen-stripe interpretation

Sixteen stripes proves that the four-gate admission knee was real, but moving
past it does not increase end-to-end capacity with the frozen database, relay,
and worker topology.

## Sixty-four stripes, four relay owners

The run used another fresh PostgreSQL 17 instance and fresh Cloud Run, Pub/Sub,
and service-account resources.

| Lane | Accepted | Receipt p95 | Outbox p95 | Publish-to-claim p95 | Nonterminal at audit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 232/s, IAM-contaminated | 13,920 | 29.8 ms | 101.3 ms | 19,273.4 ms | 0 |
| 464/s | 27,840 | 441.8 ms | 6,590.4 ms | 24,067.1 ms | 0 |
| 232/s, stable IAM after stress | 13,920 | 416.6 ms | 207.6 ms | 9,522.1 ms | 0 |

Every offered request returned HTTP 201 with an authoritative accepted outcome.
The stress client completed in 60.3 seconds. Every AgentRun reached terminal
state by audit, with zero unpublished obligations, stranded runs, ghosts,
duplicate publications, or duplicate terminal commits.

The first target lane saw 126 Pub/Sub push HTTP 403 responses while the new
invoker binding propagated, so its publish-to-claim latency is contaminated.
The later target repetition had stable IAM but recorded 80 Pub/Sub push
timeouts and 86 duplicate deliveries. Stress recorded 516 push timeouts and
408 duplicate deliveries. PostgreSQL fencing kept every duplicate harmless,
but Pub/Sub's retry backoff produced multi-second delivery tails.

Peak captured Cloud SQL CPU was about 55% during stress, with 92 backends. The
later target lane retained the same peak backend count and showed materially
worse admission latency than the earlier target, exposing accumulated-state or
resource-contention sensitivity even at the frozen target rate.

The `osfo-b3-38-s64-*` resources were deleted after the run. The exact-prefix
teardown inventory reported zero owned cloud residue. Raw generated telemetry
was discarded after this compact record.

## Stripe-study conclusion

Increasing commit-order stripes from four to 16 to 64 removes the original
admission gate knee. It does not make the frozen four-owner topology pass.
Admission concurrency transfers pressure into Cloud SQL, the relay, and the
point-claim worker. The result is Pub/Sub push timeouts, duplicate replay, and
publish-to-claim p95 far above the frozen 100 ms target gate.

Do not run the full frozen manifest for this configuration. Sequence-striping
alone cannot rescue the candidate. The next human decision is whether to reject
the four-owner relay design or authorize a separately controlled resource and
flow-control experiment before selecting another durable publication
mechanism.

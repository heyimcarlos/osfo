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

## Current interpretation

Sixteen stripes proves that the four-gate admission knee was real, but moving
past it does not increase end-to-end capacity with the frozen database, relay,
and worker topology. A fresh 64-stripe run is required to determine whether
admission continues improving while downstream latency worsens, or whether the
database itself reaches a new knee.

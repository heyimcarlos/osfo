# Issue 39 decision: Pub/Sub worker delivery and scaling seam

## Decision

Select authenticated Pub/Sub push into a request-based Cloud Run service for
the shared worker seam used by Issues 26, 35, and 38.

Freeze this deployment contract for the next comparison:

- Cloud Run service, request-based billing, min 0, max 8
- 1 vCPU and 1 GiB per instance
- Cloud Run concurrency 32, application execution semaphore 32
- PostgreSQL pool limit 4 per instance
- authenticated Pub/Sub push subscription with ordering enabled
- point-addressed AgentRun claim, 15-second lease, monotonic claim epoch
- acknowledge only after the fenced authoritative terminal commit

StreamingPull remains a valid specialized seam when jobs routinely outlive a
push acknowledgement deadline and operators accept a warm worker floor. It is
not the fixed seam for the B2/B3 durability comparison.

## Frozen comparison

Admission and outbox publication were outside the timed interval. Every
authoritative AgentRun existed before the identical envelope set was published.
Both candidates used the same handler and PostgreSQL store:

```text
Pub/Sub push HTTP or StreamingPull callback
                    |
                    v
              shared Handler
                    |
                    v
        TryClaim(primary key, epoch, lease)
             |                    |
       retry or ack          execute trace
                                  |
                                  v
                     Complete(primary key, epoch)
                                  |
                                  v
                         broker acknowledgement
```

There is no PostgreSQL runnable-work scan. A missing or canceled run cannot
create authority. A duplicate can only observe a terminal row, a live lease, or
perform a fenced reclaim after expiry.

The fixed lane gave each candidate four warm 1-vCPU, 1-GiB instances, 32
execution slots per instance, and four database connections per instance. The
database was PostgreSQL 17 on 4 vCPU and 15 GiB in
`northamerica-northeast1`. Pull used the official Go high-level asynchronous
subscriber with four StreamingPull streams per instance and per-stream flow
control. The elastic lane bounded both candidates at 0 to 8 instances. Pull
used the official CREMA Pub/Sub subscription-size scaler with a 10-second poll,
target backlog 32, and 30-second scale-down stabilization.

## Fixed-capacity results

All latency values are measured from Pub/Sub's server-side publish timestamp.
Drain is last authoritative completion minus the end of the offered load. A
negative drain means processing finished before publication stopped.

| Offered load | Candidate | Runs | Claim p50 | Claim p95 | Claim p99 | Completion p95 | Drain |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 232/s for 60s | push | 13,920 | 40.1 ms | 59.9 ms | 715.2 ms | 80.0 ms | -0.185 s |
| 232/s for 60s | pull | 13,920 | 10.9 ms | 21.0 ms | 559.9 ms | 44.3 ms | -0.215 s |
| 464/s for 60s | push | 27,840 | 40.0 ms | 58.2 ms | 80.7 ms | 78.9 ms | 1.287 s |
| 464/s for 60s | pull | 27,840 | 12.6 ms | 131.2 ms | 459.2 ms | 227.4 ms | -0.071 s |

The preceding 23/s smoke lanes completed 115 of 115 runs for each candidate and
validated the broker-side publication timestamp before the decision lanes.
Every one of the 83,520 target and stress AgentRuns reached exactly one
authoritative terminal state. There were no stranded runs and no duplicate
terminal commits. Pull had lower latency at the target rate. Push had lower p95
latency under the 2x stress rate. Both met the isolated capacity gate.

Pub/Sub's platform distributions recorded a count-weighted mean successful
push response latency of 136.5 ms and pull acknowledgement latency of 121.4 ms
in the target windows. These include transport and acknowledgement handling,
while the authoritative table above separates delivery-to-claim and completion.

Cloud Monitoring showed the shared Cloud SQL instance at most 29.3% CPU and
32 aggregate PostgreSQL backends during the adjacent fixed lanes. This stays
within the combined frozen limit of 16 connections per candidate. Candidate
container CPU peaked at 18.2% for push and 63.5% for pull in the target windows.
The normal successful database path is identical: three claim statements in
one transaction, one fenced completion statement, and one evidence insert. A
terminal or missing delivery executes one point lookup and one evidence insert.

## Duplicate, acknowledgement, and worker-loss results

| Lane | Candidate | Authoritative result | Delivery attempts | Recovery drain |
| --- | --- | --- | ---: | ---: |
| duplicate and acknowledgement expiry | push | 89 succeeded, 3 canceled, 0 stranded | 136 | 26.066 s |
| duplicate and acknowledgement expiry | pull | 89 succeeded, 3 canceled, 0 stranded | 130 | 14.719 s |
| four injected process exits | push | 1,160 succeeded, 0 stranded | 1,316 | 16.809 s |
| four injected process exits | pull | 1,160 succeeded, 0 stranded | 1,375 | 15.111 s |

The acknowledgement-expiry lane included duplicate, missing, canceled, and
15-second executions. Push cannot extend an individual acknowledgement
deadline, so four long requests were redelivered while the original request was
still running. The point claim and lease made those retries harmless. The
high-level pull client extended acknowledgement deadlines automatically and
avoided the concurrent lease retries. Both worker-loss lanes recovered only by
redelivery of the same Pub/Sub ID and finite lease expiry. Neither candidate
needed a database scan.

## Scale-from-zero result

The CREMA path was supported and stable in the benchmark region, but its
zero-idle reaction did not meet this traffic regime. After 3,480 messages were
offered at 232/s from a worker-pool count of zero, CREMA observed a backlog of
zero for 150 seconds. It first observed 1,747 messages at 156 seconds, selected
one worker, then selected the configured cap of eight ten seconds later. All
runs completed exactly once, but delivery-to-claim was 160.7 seconds at p50 and
169.1 seconds at p95. The observed oldest unacknowledged message age reached
169 seconds.

Push uses Cloud Run's native request autoscaler and requires no continuously
running external control service. From a Cloud Monitoring-proven instance
count of zero, the same 3,480-run burst reached claim at 19.0 ms p50, 1.813
seconds p95, and 3.453 seconds maximum. All 3,480 runs committed exactly once,
and the final completion preceded the end of the offered load by 0.355 seconds.
Pub/Sub issued 128 harmless post-terminal redeliveries during the cold scale-up.
The one-minute platform samples recorded backlog depth at most 128, oldest age
at most 3 seconds, and the service reaching its eight-instance cap.

## Idle and 60-million-run cost envelope

The model uses August 4, 2026 Cloud Billing Catalog list prices for Montréal:
worker-pool CPU `$0.000013492/vCPU-s`, worker-pool memory
`$0.000001482/GiB-s`, instance-based service CPU `$0.0000216/vCPU-s`,
instance-based service memory `$0.0000024/GiB-s`, request-based active CPU
`$0.0000336/vCPU-s`, request-based active memory `$0.0000035/GiB-s`, and
`$0.40/million` Cloud Run requests. Shared account free tiers and Cloud SQL are
excluded. Pub/Sub is common to both candidates and is modeled as two 1-KiB
operations per run at `$40/TiB`.

| Shape | Idle worker floor | 60M-run list-price envelope |
| --- | ---: | ---: |
| push, min 0 | $0/month | about $29 to $207, about $34 with p95 80 ms and concurrency 32 |
| pull, fixed 4 | $157.41/month | about $161.88 including Pub/Sub |
| pull, CREMA 0 to 8 | $63.07/month CREMA control service | about $67.54 plus burst worker seconds, about $106.89 if one worker remains active |

The broad push upper bound assumes no request overlap at the measured 80 ms
p95. The configured concurrency-32 case is the relevant planning point. Pull's
fixed four-worker floor is simple and gives excellent target-rate latency, but
it spends continuously for capacity that the 60-million-run monthly average
does not need. CREMA removes the worker floor, but not its always-on control
service, and the measured Pub/Sub metric delay produces a long cold backlog.

## Relationship to Issue 20

Issue 20 remains useful evidence for the envelope parser, point claim, claim
epoch, duplicate handling, failure injection, and historical cost rates. Its
direct-PostgreSQL topology recommendation is rejected. That study compared four
continuously warm direct workers with min-zero transactional-outbox push, so its
32.483-second stress drain mixed protocol, publication, cold scaling, and
worker lifecycle. This prototype removes admission and publication from the
timed worker seam and gives push and StreamingPull identical resource floors.

## Sources and evidence limits

Google documents authenticated push as the serverless Cloud Run integration,
and notes that push cannot modify individual acknowledgement deadlines:
<https://docs.cloud.google.com/pubsub/docs/push>. Google recommends the
high-level asynchronous client for StreamingPull:
<https://docs.cloud.google.com/pubsub/docs/pull>. Worker pools otherwise use
manual scaling:
<https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling>.
The supported CREMA Pub/Sub pattern is documented at
<https://docs.cloud.google.com/run/docs/tutorials/autoscale-workerpools-pubsub>.
Pricing sources are <https://cloud.google.com/run/pricing> and
<https://cloud.google.com/pubsub/pricing>.

Cloud Monitoring metrics are one-minute platform samples and can overlap an
adjacent lane at the edges. They support the capacity and scaling observations,
while the PostgreSQL authoritative audits are the correctness and latency
source of truth. This gate uses the frozen synthetic 15 ms worker trace. It does
not claim to measure the later full Temporal and provider path. Every sealed
evidence directory has a SHA-256 manifest. Final teardown inventory reported
zero owned services, worker pools, databases, topics, subscriptions,
repositories, secrets, service accounts, and parameters.

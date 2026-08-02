# PostgreSQL dispatch topology prototype evidence

## Question

Can PostgreSQL remain both lifecycle authority and runnable-work queue across the 700 AgentRun/s human baseline, a preliminary 2,083 AgentRun/s proactive target, synchronized timer triggers, managed-database latency sensitivity, overload, and injected worker failure while preserving ordering, durability, fairness, fencing, bounded saturation, and recovery? Where does it break first?

## Verdict

The tested PostgreSQL topology preserved every correctness claim. The ordered matrix first became unhealthy at **target-700-rtt-10ms** under the explicit prototype thresholds. The 700/s human target is borderline rather than comfortably validated: the first zero-delay control achieved the 95.0% minimum, while its repeat achieved 94.7%. The preliminary 2,083/s proactive target is falsified on this database shape. Capacity and correctness are separate: every authoritative acceptance still completed with zero lost work.

This is evidence from a disposable local PostgreSQL profile, not production sizing. The proactive volume is a design hypothesis, not observed product traffic. SSE contention was excluded by the approved ticket scope.

## Reproduce

```sh
./prototypes/dispatch-topology/run.sh
```

## Fixed environment

- PostgreSQL 17.6
- 4 vCPU container limit
- 4 GiB container memory limit
- 100 PostgreSQL connections
- 1 GiB shared buffers
- Open-arrival driver with a 5,000-item caller queue and a 2-second admission deadline

## Cloud SQL resource mapping

The exact resource-label match is Cloud SQL Enterprise `db-custom-4-4096`: 4 vCPU and 4 GiB. It is not performance-equivalent because managed storage, service scheduling, flags, and network behavior differ. At the published Toronto and Montreal rates captured on 2026-08-02, zonal compute and memory are about USD $0.2124/hour, while regional HA is about $0.4252/hour, before storage and other charges. A read replica costs roughly another standalone instance and cannot serve authoritative queue operations because it is asynchronous and read-only. See [the cited mapping](../../../../docs/research/cloud-sql-dispatch-prototype-mapping.md).

## Correctness and failure checks

| Claim | Result | Evidence |
|---|---|---|
| atomic admission | confirmed | one transaction exposed one linked receipt, AgentRun, and accepted ThreadEvent (joined rows=1) |
| idempotency | confirmed | identical retry=idempotent_replay, same run=true, conflicting retry=idempotency_conflict |
| per-Thread ordering | confirmed | completion-order violations=0, ThreadEvent position gaps=0 |
| cross-Thread concurrency | confirmed | observed 2 simultaneous synthetic remote operations across Threads |
| bounded worker concurrency | confirmed | configured bound=4, observed maximum=2 |
| Principal-first fairness | confirmed | quiet Principal first appeared at claim rank 2; first claims=[1, 2, 1, 2, 1, 1] |
| global and per-Principal saturation | confirmed | per-Principal typed rejection=true, global typed rejection=true, durable accepted=8, non-terminal counter=8 |
| missing and duplicate notification safety | confirmed | missing wake recovered=true, duplicate wakes harmless=true |
| authoritative readiness reconciliation | confirmed | deliberately zeroed ready_count projection recovered=true |
| process death and lease takeover | confirmed | killed process exit=86, epochs 1 -> 2, attempts=2, final=succeeded |
| stale completion fencing | confirmed | stale epoch rejected=true, takeover completed=true |

## Load and recovery

| Stage | Pattern | RTT proxy | Offered/s | In-window/s | Offered | Acknowledged | Authoritative | Ambiguous commit | Dropped | Timeout | Caller queue | Claim p95 | Peak pending | PG CPU | Locks | Drain | Lost | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| target-700 | uniform | 0 ms | 700 | 665.0 | 14000 | 14000 | 14000 | 0 | 0 | 0 | 699 | 27.4 ms | 134 | 411.5% | 60 | 21.5 s | 0 | healthy |
| target-700-rtt-1ms | uniform | 1 ms | 700 | 687.4 | 14000 | 14000 | 14000 | 0 | 0 | 0 | 252 | 11.4 ms | 4 | 410.4% | 58 | 21.8 s | 0 | healthy |
| target-700-rtt-3ms | uniform | 3 ms | 700 | 683.2 | 14000 | 14000 | 14000 | 0 | 0 | 0 | 336 | 8.9 ms | 3 | 339.6% | 57 | 21.9 s | 0 | healthy |
| target-700-rtt-5ms | uniform | 5 ms | 700 | 683.5 | 14000 | 14000 | 14000 | 0 | 0 | 0 | 328 | 14.6 ms | 2 | 329.3% | 54 | 21.8 s | 0 | healthy |
| target-700-rtt-10ms | uniform | 10 ms | 700 | 680.9 | 14000 | 14000 | 14000 | 0 | 0 | 0 | 385 | 1147.9 ms | 546 | 280.6% | 53 | 23.2 s | 0 | unhealthy |
| target-700-repeat | uniform | 0 ms | 700 | 663.0 | 14000 | 14000 | 14000 | 0 | 0 | 0 | 740 | 29.4 ms | 53 | 408.7% | 61 | 21.8 s | 0 | unhealthy |
| probe-900 | uniform | 0 ms | 900 | 255.3 | 18000 | 5125 | 13258 | 8133 | 0 | 12875 | 1809 | 1921.0 ms | 768 | 407.8% | 62 | 22.1 s | 0 | unhealthy |
| probe-1100 | uniform | 0 ms | 1100 | 204.1 | 22000 | 4102 | 13593 | 9491 | 0 | 17898 | 2211 | 120.4 ms | 62 | 412.9% | 60 | 82.4 s | 0 | unhealthy |
| burst-1400 | uniform | 0 ms | 1400 | 280.3 | 14000 | 2869 | 7907 | 5038 | 0 | 11131 | 2814 | 19.0 ms | 5 | 408.0% | 62 | 22.1 s | 0 | unhealthy |
| proactive-target-2083 | uniform | 0 ms | 2083 | 111.0 | 41660 | 2254 | 13005 | 10751 | 0 | 39406 | 4187 | 14.4 ms | 5 | 406.9% | 61 | 21.9 s | 0 | unhealthy |
| timer-herd-no-jitter | herd | 0 ms | 5000 | 0.0 | 5000 | 1219 | 1280 | 61 | 0 | 3781 | 5000 | 36.2 ms | 0 | 364.4% | 56 | 22.1 s | 0 | unhealthy |
| timer-herd-jitter-60s | jittered | 0 ms | 83 | 83.3 | 5000 | 5000 | 5000 | 0 | 0 | 0 | 2 | 4.7 ms | 1 | 366.8% | 0 | 22.0 s | 0 | healthy |
| proactive-overload-4167 | uniform | 0 ms | 4167 | 63.2 | 250020 | 3989 | 25160 | 21171 | 96080 | 149951 | 5098 | 342.3 ms | 141 | 405.4% | 61 | 22.3 s | 0 | unhealthy |

## Managed-database latency sensitivity

| RTT proxy | In-window admission/s | Acknowledged | Authoritative | Ambiguous commit | Timeout | Claim p95 | Verdict |
|---:|---:|---:|---:|---:|---:|---:|---|
| 0 ms | 665.0 | 14000 | 14000 | 0 | 0 | 27.4 ms | healthy |
| 1 ms | 687.4 | 14000 | 14000 | 0 | 0 | 11.4 ms | healthy |
| 3 ms | 683.2 | 14000 | 14000 | 0 | 0 | 8.9 ms | healthy |
| 5 ms | 683.5 | 14000 | 14000 | 0 | 0 | 14.6 ms | healthy |
| 10 ms | 680.9 | 14000 | 14000 | 0 | 0 | 1147.9 ms | unhealthy |
| 0 ms | 663.0 | 14000 | 14000 | 0 | 0 | 29.4 ms | unhealthy |

Each proxy holds one pooled connection for the configured delay before the single PostgreSQL stored-function call used by admission, claim, or completion. It is a sensitivity curve, not Cloud SQL emulation. The 10 ms point is the clear latency-induced break. The zero-delay repeat missed the throughput threshold by 0.3 percentage points, so 700/s has insufficient headroom even without added latency. An ambiguous commit means PostgreSQL durably accepted work after the caller deadline; the same idempotency key must be retried to resolve that outcome.

## Human and proactive comparison

| Envelope | Offered/s | Admitted in window/s | Dropped | Timeout | Peak pending | Drain |
|---|---:|---:|---:|---:|---:|---:|
| Human baseline | 700 | 665.0 | 0 | 0 | 134 | 21.5 s |
| Proactive hypothesis | 2083 | 111.0 | 0 | 39406 | 5 | 21.9 s |
| Proactive 2x overload | 4167 | 63.2 | 96080 | 149951 | 141 | 22.3 s |

The proactive rows answer a sensitivity question. They do not promote 20 proactive admissions per user per day into a product fact.

## Observed overload sequence

1. At the 700/s human target, admission achieved 665.0/s. The exact global obligation counter created up to 60 lock waiters and PostgreSQL reached 411.5% container CPU.
2. As offered work exceeded sustained admission capacity, claim latency and the caller-side admission queue grew.
3. At the 4,167/s proactive overload, the bounded caller queue dropped 96080 offers and 149951 admissions reached their deadline. PostgreSQL committed 25160 authoritative obligations, but only 3989 were acknowledged before the caller deadline.
4. After offers stopped, every accepted obligation completed in 22.3 seconds. Lost accepted work remained 0.

This is the cascade boundary: contention raises latency, queues fill, and throughput stops scaling. The bounded caller boundary prevents overload from turning into an unlimited hidden queue. PostgreSQL durability and epoch fencing preserve accepted work through recovery.

## Timer synchronization comparison

| Shape | Offer window | Admitted in window | Dropped | Timeout | Claim p95 | Peak pending |
|---|---:|---:|---:|---:|---:|---:|
| 5,000 simultaneous timers | 0.001 s | 0 | 0 | 3781 | 36.2 ms | 0 |
| Same timers spread across 60 seconds | 60.0 s | 4999 | 0 | 0 | 4.7 ms | 1 |

Timer jitter changes the arrival shape without changing total work. The comparison shows whether smoothing avoids the first cascade boundary.

## Worker concurrency and broker interpretation

The 700/s run reached **13270 simultaneously running AgentRuns** with a 64-connection application pool. This proves that PostgreSQL connections do not impose a one-connection-per-running-AgentRun limit. A connection is held only for short admission, claim, reconciliation, and completion transactions. Synthetic 20-second remote work runs after the connection is released.

PostgreSQL does limit how quickly work can cross those authoritative transitions. The measured first hotspot was the exact global obligation counter, with 60 lock waiters and 4.11 PostgreSQL CPU cores at the human baseline. Adding workers would create more claim and completion contenders without repairing that admission hotspot.

RabbitMQ could later offload runnable discovery, buffering, and delivery to horizontally scaled consumers. It would not remove PostgreSQL admission, idempotency, per-Thread ordering, claim-epoch fencing, or completion writes. The safe later shape is `PostgreSQL admission + transactional outbox -> sharded durable queues -> worker -> fenced PostgreSQL completion -> broker acknowledgement`. See [the cited broker analysis](../../../../docs/research/broker-dispatch-concurrency.md).

## Dashboard interpretation

The dashboard separates Google SRE's traffic, latency, errors, and saturation signals, then keeps the injected failure as a Restate- and Temporal-style durable execution history. Counts and durations never share an axis. Claim P50, P95, and P99 are stage summaries; the sampled P95 line is cumulative from the start of its stage, not a rolling percentile. See [the cited observability comparison](../../../../docs/research/dispatch-dashboard-observability-comparables.md).

## Interpretation rules

A stage is unhealthy if final acceptance falls below 95%, admission throughput during the offer window falls below 95%, drops plus timeouts plus errors exceed 1%, claim p95 exceeds 1 second, oldest pending exceeds 2 seconds, accepted work is lost, or work remains non-terminal after recovery. These are prototype review thresholds, not permanent Osfo service objectives. A timed-out admission is not assumed accepted. Every accepted receipt is checked independently for terminal durability.

## Evidence inventory

- `run-config.json`: inputs and thresholds
- `environment.json`: reproducibility facts
- `samples.csv`: per-second measurements
- `results.json`: machine-readable verdicts
- `dashboard.html`: self-contained presentation view

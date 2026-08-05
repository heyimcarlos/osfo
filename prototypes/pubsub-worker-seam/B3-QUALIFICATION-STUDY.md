# B3 manifest v2 qualification

## Decision

Select transactional-outbox publication followed by authenticated Pub/Sub push
to min-zero Cloud Run workers. The human reviewer accepted this UX-aligned
normal target contract:

- desired publish-to-point-claim p95 at most 200 ms;
- hard qualification p95 at most 250 ms;
- publish-to-point-claim p99 at most one second;
- caller-to-authoritative-receipt p95 at most 250 ms and p99 at most 500 ms;
- zero missing publications, stranded accepted work, ghost authority, or
  duplicate terminal commits;
- bounded automatic backlog recovery.

This is manifest `pubsub-handoff-v2`. It changes the warm target
publish-to-point-claim p95 gate from 100 ms to the desired and hard thresholds
above. The stress p95 of 250 ms, stress p99 of two seconds, correctness,
capacity, recovery, and evidence gates remain unchanged.

B2 does not rerun. Direct dual-write failed the invariant under every ordering,
so a performance-threshold change cannot make it shippable.

## Selected controlled topology

- four commit-order sequence stripes;
- one min-one, max-two relay service with four logical owners and 128-record
  batches;
- min-zero, max-eight authenticated push workers;
- worker concurrency eight, execution slots eight, and database pool four;
- 1 vCPU and 1 GiB per worker;
- 10-second push acknowledgement deadline;
- request-based billing with CPU throttling;
- unchanged point claim, lease epoch, terminal fence, and acknowledgement after
  terminal commit.

The min-zero selection is deliberate. The two-instance warm-floor experiment
measured 140.0 ms p95 compared with 134.0 ms at min zero, so the floor did not
buy latency and should not become an idle cost.

## Qualification order

1. Run a fresh authenticated warm-up and a drained-subscription 60-second
   target control.
2. Run the 60-second 464 incoming/s stress gate.
3. Continue only if correctness, typed overload, bounded resources, and drain
   hold.
4. Run the three sustained target and stress repetitions, ramp, scale-zero,
   failure recovery, retention, and complete cost capture supported by the
   isolated handoff harness.
5. Keep production-shaped Temporal, fairness, multi-device, and full
   root-response gates explicit if they require the separate lifecycle stack.
   Existing evidence cannot be silently relabeled as an integrated run.

## Environment

```bash
export B3_EXPERIMENT=qualification-push
export B3_MANIFEST_VERSION=pubsub-handoff-v2
export B3_SEQUENCE_STRIPES=4
export B3_WORKER_CONCURRENCY=8
export B3_WORKER_SLOTS=8
export B3_WORKER_DB_POOL=4
export B3_WORKER_MIN_INSTANCES=0
export B3_INGRESS_ADMISSION_SLOTS=64
```

## Ordered stress finding and corrective experiment

The first manifest v2 stress control retained Pub/Sub ordering. It accepted
27,143 of 27,840 offered inputs, left 6,551 accepted AgentRuns nonterminal after
five minutes, and recorded only HTTP 503 worker redeliveries after the measured
window.

The database order fence and broker order fence can deadlock. Concurrent
admission can commit a higher `ThreadSequence` before its predecessor. The
higher wake-up is published first, the worker correctly refuses it while the
predecessor is pending, and Pub/Sub then blocks the predecessor behind that
unacknowledged message on the same ordering key.

Run one controlled correction with `B3_ENABLE_ORDERING=0`. The point-addressed
claim, predecessor check, finite lease, and terminal fence remain authoritative.
Without broker ordering, the predecessor can be delivered independently and a
later retry can claim the dependent run. This removes coordination and cost
rather than adding compute.

That correction failed its target control. Unordered delivery completed only
6,844 of 20,880 AgentRuns during the observation window because freely delivered
successors produced a retry storm behind pending predecessors.

The underlying prototype defect was the definition of `thread_sequence`.
Admission derived it from caller ordinal even though concurrent requests can
commit in a different order. Osfo's canonical `ThreadPosition` is committed
order, not offer order. The final corrective experiment allocates contiguous
per-Thread sequence after acquiring the existing commit-order stripe gate.
Requests for one synthetic Thread always share a stripe, so the later statement
observes the preceding commit and assigns the next sequence. Restore Pub/Sub
ordering for this aligned-order control.

The aligned-order stress control terminalized every accepted AgentRun and met
the stress handoff gate at 169.6 ms p95 and 705.4 ms p99. Its remaining failure
was 7,806 generic Cloud Run 429 responses before application code.

The first overload control used 32 admission slots and falsely rejected 310
normal target inputs. The final control gives each ingress instance 64
nonblocking admission slots while retaining Cloud Run concurrency 80. Valid
requests that cannot
acquire a slot receive a parseable `rejected` outcome with error class
`overloaded`. This reserves request capacity for explicit rejection instead of
allowing database lock waiters to occupy every platform slot. The worker, relay,
database pools, service maxima, and accepted-work durability path remain fixed.

## Sustained target admission-buffer finding

The clean 10-minute 23/s baseline passed exact reconciliation with
publish-to-point-claim p95 of 152.0 ms and p99 of 188.4 ms. The first sustained
232/s repetition then stopped after 958 of the planned 1,800 seconds. Its
durability path still reconciled exactly: 221,852 accepted inputs created
332,776 terminal AgentRuns, with zero unknown outcomes, unpublished outbox
records, stranded work, ghosts, duplicate publications, or duplicate terminal
commits. Publish-to-point-claim p95 was 82.3 ms and p99 was 114.1 ms.

The target gate failed because 392 of 222,244 offered inputs received typed
`rejected/overloaded` outcomes. The load generator remained at exactly 232
offers/s. During the main three-second rejection cluster, accepted request
latency rose above one second and observed global accepted concurrency reached
145. The two ingress instances exposed 128 application admission slots in
total. Rejections occurred with 120 to 127 accepted requests already in flight.
Cloud SQL CPU remained near 51 percent, ingress CPU near 39 percent, Pub/Sub and
outbox latency remained healthy, and every accepted run drained.

This localizes the failure to insufficient bounded admission buffering during
a brief database commit or lock convoy, not broker or worker capacity. The next
controlled variant raises admission slots from 64 to 80 per ingress instance
and Cloud Run request concurrency from 80 to 100, preserving 20 request slots
per instance for typed overload. It keeps instance maxima, sequence stripes,
relay, worker pool, database, and durability semantics fixed. Run a 10-minute
target control before authorizing another 30-minute repetition.

## Eighty-slot control finding

The fresh 80-slot control offered exactly 139,200 inputs over 10 minutes. It
accepted 139,025 and returned 175 typed `rejected/overloaded` outcomes, so it
failed the zero-rejection target gate. Every accepted input reconciled exactly:
208,540 AgentRuns reached terminal state with zero unknown caller outcomes,
unpublished outbox records, stranded work, ghosts, duplicate publications, or
duplicate terminal commits. Publish-to-point-claim latency passed at 144.5 ms
p95 and 626.0 ms p99. Caller-to-receipt latency passed at 42.4 ms p95 and
117.5 ms p99.

Cloud Run kept the ingress at one 1-vCPU instance throughout the offer window.
Its captured CPU utilization peaked at 57.8 percent, just below the pressure
needed to add capacity, while Cloud SQL peaked at 58.1 percent CPU and 41
backends. Raising the per-instance buffer therefore reduced fleet capacity from
the previous two observed ingress instances to one and did not remove transient
overflow. The fixed-buffer-size hypothesis is falsified.

The controller also exposed an evidence-runner defect: a failed sealed-lane
check could be followed by a successful status write. The lane audit and sealed
measurements were unaffected. The runner now propagates each lane failure
explicitly, and replaying the sealed control produces controller state `failed`
with exit code 1.

The next single-variable control sets the ingress minimum to two instances. It
keeps ingress concurrency 100, admission slots 80, max instances eight, and the
entire database, relay, Pub/Sub, and worker path unchanged. This tests whether
the target needs a small warm API floor rather than more admission buffering.
Run a 60-second prelude and a 10-minute target gate before any sustained
qualification repetition.

## Two-instance ingress finding

The two-instance control offered 139,200 inputs over 10 minutes. It accepted
138,655 and returned 545 typed overload outcomes, so a warm ingress floor does
not solve the target. Every accepted input still reconciled exactly: 207,980
AgentRuns reached terminal state with zero unknowns, unpublished outbox rows,
stranded work, ghosts, duplicate publications, or duplicate terminal commits.
The durable handoff passed at 145.8 ms p95 and 356.9 ms p99. Receipt latency
failed at 391.8 ms p95 and 522.2 ms p99.

Cloud SQL logs correlate the repeated stalls with automatic database
maintenance. At 15:54:54 UTC, automatic VACUUM and ANALYZE began across the
high-write tables. ANALYZE took 2.63 seconds on `b3_admissions` and 2.13 seconds
on the outbox partition. Typed rejections began two seconds after maintenance
started and continued through the sequence. A second cycle began at 15:56:54;
ANALYZE took 2.74 seconds on admissions and 2.33 seconds on outbox, followed by
the next rejection cluster. Further cycles repeated at roughly two-minute
intervals and grew more disruptive with table size.

This falsifies both larger per-instance admission buffers and a two-instance
warm floor as primary fixes. The broker, relay, point claim, terminal fence,
and accepted-work recovery remain within their gates. The remaining bottleneck
is database work in the prototype admission path.

The prototype currently adds two audit-only transactions to every normal
request: insert attempt evidence, perform the atomic authority commit, then
update attempt evidence. Production needs the middle transaction. The next
controlled variant disables attempt evidence only for no-fault ingress load.
Fault and cut tests retain the full evidence path. Target receipt gates move to
the stricter client end-to-end completion samples, which can return accepted
only after the authority transaction commits, while database reconciliation
continues to prove exact durable state. Keep min two and all other topology
parameters fixed for this causal control.

## Production-shaped authority finding

The authority-only 10-minute target is the first sustained control to pass
every target gate. It offered and accepted all 139,200 inputs. Those inputs
created 208,800 AgentRuns, all of which reached terminal state with zero
unknowns, unpublished outbox records, stranded runs, ghosts, duplicate
publications, or duplicate terminal commits.

Stricter client end-to-end receipt latency was 53.5 ms p95, 170.8 ms p99, and
430.6 ms maximum. Publish-to-point-claim latency was 131.0 ms p95 and 260.9 ms
p99. Outbox-ready-to-publish-confirmation latency was 81.4 ms p95 and 110.8 ms
p99. All are within manifest v2.

Automatic VACUUM and ANALYZE continued during the passing target. Two complete
maintenance sequences began at 16:26:01 and 16:26:21 UTC. They included a
2.5-second admissions analyze and a 1.8-second outbox analyze, yet produced zero
rejections and did not raise end-to-end p95 above 57 ms. This confirms that the
failed controls measured interference from audit-only admission transactions,
not a need to suppress PostgreSQL maintenance or buy a larger database.

The evidence controller completed with exit code zero. Its compact log filter
kept the complete experiment evidence at 5.4 MB, including the subsequent
stress lane and final zero-residue teardown inventory.

## Authority-only stress finding

The 60-second 464/s stress control offered 27,840 inputs. It accepted 27,394 and
returned 446 typed overload outcomes with zero unknown outcomes. Accepted work
remained internally consistent, but the fixed drain and handoff gates failed:
41,093 AgentRuns were authoritative, 41,029 were terminal at audit, 64 remained
nonterminal, and publish-to-point-claim latency reached 65.6 seconds p95.

Cloud Run scaled the worker to five observed instances. The accepted rate was
about 457 inputs/s, or 685 AgentRuns/s, which exceeded the measured downstream
service rate and created a broker backlog. The former audit-heavy ingress had
accidentally shed more work before this boundary. Removing that overhead
therefore exposed the actual missing production control.

The selected durable topology now passes target admission, receipt, handoff,
maintenance interference, and exact reconciliation. It does not yet pass the
two-times-target overload gate. The next controlled component is a distributed
in-flight AgentRun budget checked during admission. It must consume capacity in
the same transaction that creates AgentRuns and outbox records, release capacity
at terminal commit, shard contention, and return the existing typed overload
response when the budget is exhausted. This adds no publisher, queue, or
always-on server. A plain per-instance rate limiter is not acceptable because
Cloud Run instance count and routing change dynamically.

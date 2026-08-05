# B3 worker flow-control study

## Question

Can earlier Cloud Run scale-out and lower per-instance request pressure make the
corrected four-stripe transactional-outbox topology meet the frozen target
without changing its relay, database pool, acknowledgement deadline, or
durability semantics?

This is a throwaway decision prototype for Wayfinder ticket 38. It is not a
production migration.

## Controlled change

The reference topology allowed 32 concurrent Cloud Run requests and 32
application execution slots per worker instance while exposing only four
database connections. This variant changes the two aligned worker concurrency
limits to eight. It keeps these controls fixed:

- four commit-order sequencing stripes;
- one min-one relay container, four logical relay owners, and 128-record
  batches;
- four database connections per worker instance;
- min-zero and max-eight worker instances;
- a 10-second Pub/Sub push acknowledgement deadline;
- the same point claim, lease, claim epoch, terminal fence, ordering keys, and
  acknowledgement-after-terminal-commit behavior.

## Decision rule

Run only a fresh 60-second target lane and a 60-second stress lane first. The
variant qualifies for failover and full-manifest work only if the target has:

- exact accepted, authoritative, and terminal reconciliation;
- zero unpublished outbox obligations, stranded AgentRuns, ghost attempts, and
  duplicate terminal commits;
- publish-to-point-claim p95 at most 100 ms and p99 at most one second;
- no Pub/Sub push timeouts or growing final backlog;
- no positive target drain after the fixed observation window.

The stress lane must preserve correctness, typed overload behavior, bounded
resources, and automatic drain. It characterizes the boundary and does not
replace the target gate.

## One-command operations

Every operation uses the same explicit profile:

```bash
export B3_EXPERIMENT=flow-control-8
export B3_SEQUENCE_STRIPES=4
export B3_WORKER_CONCURRENCY=8
export B3_WORKER_SLOTS=8

./b3-run.sh provision
./b3-run.sh relay
./b3-run.sh load iam-warmup-23 23 10 1

export B3_RESET_SUBSCRIPTION=0
./b3-run.sh load warm-target-smoke-232 232 60 1
./b3-run.sh load warm-stress-smoke-464 464 60 1
./b3-run.sh seal
./b3-run.sh teardown
```

Evidence lands under `evidence/b3-flow-control-8/`. Teardown is mandatory even
when a lane fails.

The warm-up creates and authenticates a fresh subscription. Target and stress
reuse that drained subscription so Pub/Sub push slow start is not mislabeled as
steady-state target latency. Every scenario records whether its subscription
was reset immediately before the lane.

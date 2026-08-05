# B3 warm push-worker study

## Question

Can the smallest capacity-backed Cloud Run worker floor make the selected
transactional-outbox push topology meet the frozen publish-to-point-claim
latency gate at an acceptable idle cost?

This is a throwaway decision prototype for Wayfinder ticket 38. It is not a
production migration and it does not add the separately proposed Pub/Sub
agent-output topic.

## Controlled change

The admissible flow-control lane used worker concurrency eight, execution slots
eight, a four-connection database pool, and minimum zero instances. It reached
publish-to-point-claim p95 of 134.0 ms against the frozen 100 ms gate.

This variant changes only the Cloud Run worker minimum to two instances. The
floor is capacity-backed: at the measured 21.1 ms claim-to-terminal p95, a
four-connection worker pool has an approximate p95 service capacity of 190
AgentRuns/s. Two instances cover the frozen 348 AgentRuns/s target without
assuming scale-out. All other controls remain fixed:

- four commit-order sequencing stripes;
- one min-one relay container, four logical relay owners, and 128-record
  batches;
- worker concurrency eight and eight application execution slots;
- four database connections per worker instance;
- max eight worker instances;
- request-based Cloud Run billing with CPU throttling;
- a 10-second Pub/Sub push acknowledgement deadline;
- the same point claim, lease, claim epoch, terminal fence, ordering keys, and
  acknowledgement-after-terminal-commit behavior.

## Decision rule

Run a short authenticated warm-up and then one fresh 60-second target lane
against the same drained subscription. The variant qualifies for a stress lane
and the remaining frozen manifest only if the target has:

- exact accepted, authoritative, and terminal reconciliation;
- zero unpublished outbox obligations, stranded AgentRuns, ghost attempts, and
  duplicate terminal commits;
- publish-to-point-claim p95 at most 100 ms and p99 at most one second;
- no Pub/Sub push timeouts or growing final backlog;
- no positive target drain after the fixed observation window.

If the target passes, run the 60-second stress lane before deciding whether the
full manifest is justified. If it fails, stop the push qualification and
compare a warm StreamingPull subscriber contract.

## One-command operations

Every operation uses the same explicit profile:

```bash
export B3_EXPERIMENT=warm-workers-2
export B3_SEQUENCE_STRIPES=4
export B3_WORKER_CONCURRENCY=8
export B3_WORKER_SLOTS=8
export B3_WORKER_DB_POOL=4
export B3_WORKER_MIN_INSTANCES=2

./b3-run.sh provision
./b3-run.sh relay
./b3-run.sh load iam-warmup-23 23 10 1

export B3_RESET_SUBSCRIPTION=0
./b3-run.sh load warm-target-qualified-232 232 60 1
```

Evidence lands under `evidence/b3-warm-workers-2/`. Teardown is mandatory even
when a lane fails. Seal decision-critical evidence before discarding bulky raw
files.

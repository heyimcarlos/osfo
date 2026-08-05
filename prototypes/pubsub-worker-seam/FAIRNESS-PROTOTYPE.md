# Principal-first dispatch window prototype

## Question

Can a bounded Principal-first dispatch window preserve Osfo v1 starvation
resistance, per-Thread order, and work conservation while keeping Pub/Sub as
primary AgentRun delivery and avoiding broad AgentRun discovery in PostgreSQL?

This is a throwaway logic prototype for
[Prove Principal starvation resistance with Pub/Sub primary delivery](https://github.com/heyimcarlos/osfo/issues/50).
It is not production code. The deployed Cloud SQL challenge and selected seam
are recorded in
[`PRINCIPAL-FAIRNESS-STUDY.md`](PRINCIPAL-FAIRNESS-STUDY.md).

## Run

From `prototypes/pubsub-worker-seam`:

```bash
go run ./cmd/b3-fairness-tui
```

Start in `principal-first` mode. Add several noisy batches, select work, add a
quiet run, complete one permit, and select again. The quiet Principal should
receive the next compatible opportunity. Add only noisy work and all permits
should remain usable. Runs on one Thread cannot pass an open predecessor.

Switch to `broker-fifo` mode to see the negative control. A quiet run appended
behind a sustained noisy backlog waits behind that backlog.

## Candidate seam

```text
admission transaction
  -> AgentRun authority + append-oriented outbox + durable obligation budget
  -> Principal-first selector reserves a bounded dispatch permit
     -> choose Principal by durable virtual pass
     -> choose one eligible Thread head inside that Principal
  -> confirmed relay publication of the selected AgentRunId
  -> authenticated Pub/Sub push
  -> point-addressed fenced claim and execution
  -> terminal transaction releases both dispatch permit and obligation budget
```

The dispatch window is bounded independently from the admitted-obligation
budget. It contains at most the compatible execution capacity plus a small,
declared broker prefetch margin. A noisy Principal can fill unused permits when
alone. Once a quiet Principal becomes eligible, newly released permits are
selected by Principal before Thread or child fan-out.

The deployed challenge lane passed against Cloud SQL, the isolated relay,
Pub/Sub push, a fixed Cloud Run worker bound, worker loss, relay loss, and typed
overload. Full production qualification must rerun it with the Production
Acceptance Corpus and integrated Temporal execution.

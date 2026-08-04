# Issue 35 direct dual-write negative control

## Question

How often and in what exact forms does direct PostgreSQL plus Pub/Sub
dual-write violate durable AgentRun acceptance when the request process or one
dependency fails at the atomicity boundary?

## Candidate under test

Each authenticated incoming-message request deterministically creates one root
AgentRun and an additional child AgentRun on every second request. This fixes
the measured 1.5 AgentRuns per incoming message. The request performs the
PostgreSQL admission commit and the direct Pub/Sub publications in
database-first, publish-first, or concurrent order.

An idempotent retry may point-read its admission and repeat direct publication.
There is no outbox, reconciliation record, pending-row scan, or background
repair. The `b2_attempt_evidence` and `b2_publish_evidence` tables are
instrumentation only. Candidate code never reads them, and audits run only
after offer and drain windows.

The Pub/Sub worker is the frozen Issue 39 authenticated-push implementation:

```text
request
  |-- PostgreSQL admission commit
  `-- Pub/Sub publish
           |
           v
authenticated push, min 0 / max 8
           |
           v
point claim by AgentRunId, epoch fence, terminal commit, acknowledgement
```

The prototype is expected to be a negative control. One stranded accepted
AgentRun, ghost delivery, irreconcilable unknown caller outcome, or silent loss
makes B2 unshippable.

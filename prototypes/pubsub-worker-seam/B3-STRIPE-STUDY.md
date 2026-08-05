# B3 sequencing-stripe study

## Question

Does widening the transactional-outbox commit-order gate from four stripes to
16 or 64 remove the observed admission capacity knee without changing the
frozen four-owner relay, worker, Pub/Sub, Cloud SQL, or load topology?

## Controlled change

Each admission selects a sequence stripe from its ordinal. A sequence stripe
has its own transaction-held PostgreSQL gate and durable relay cursor. The
stripe maps to one of four relay owners with `stripe % 4`. The tested stripe
counts divide the frozen 1,024-thread corpus, so every Thread stays on one
stripe and retains commit order.

Each relay owner keeps one database connection and reads a bounded 128-record
batch fairly across its assigned stripes. Publication confirmation and all
stripe cursor advances remain separate durability boundaries, so replay after
an ambiguous outcome remains duplicate-safe.

## Decision rule

Run the 16-stripe target and stress smoke lanes against a fresh database. The
16-stripe variant settles the question if it restores the frozen target
publish-to-claim p95 and produces typed, bounded stress overload with a stable
drain. Run 64 stripes only if the 16-stripe result leaves the capacity or
latency relationship unresolved.

## One-command operations

```bash
B3_EXPERIMENT=stripes-16 B3_SEQUENCE_STRIPES=16 ./b3-run.sh provision
B3_EXPERIMENT=stripes-16 B3_SEQUENCE_STRIPES=16 ./b3-run.sh load target-smoke-232 232 60 1
B3_EXPERIMENT=stripes-16 B3_SEQUENCE_STRIPES=16 ./b3-run.sh load stress-smoke-464 464 60 1
B3_EXPERIMENT=stripes-16 B3_SEQUENCE_STRIPES=16 ./b3-run.sh teardown
```

This is a throwaway decision prototype. It is not a production migration.

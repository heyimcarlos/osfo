# Direct PostgreSQL plus Pub/Sub dual-write negative control

This throwaway Issue 35 prototype measures whether direct dual-write can meet
Osfo's durable AgentRun acceptance invariant. It is isolated from production,
uses synthetic identities only, and creates cloud resources with the
`osfo-b2-35` prefix.

The admission candidate is new. The authenticated-push worker, point claim,
15-second lease, claim epoch, execution semaphore, terminal fence, and broker
acknowledgement are the frozen Issue 39 implementation and are not modified by
this prototype.

## Run

The decision evidence is one command:

```bash
./b2-run.sh decision
```

It provisions the isolated Cloud SQL, Pub/Sub, and Cloud Run resources, checks
authentication behavior, exercises hard process cuts, and runs the frozen
100-cut, three-seed matrix for database-first, publish-first, and concurrent
ordering. Evidence lands in `evidence/b2-negative-control/`.

Production-shaped load lanes are explicit because they are intentionally long:

```bash
./b2-run.sh load-manifest
./b2-run.sh scale-zero
```

Always finish by sealing the evidence and deleting every owned resource:

```bash
./b2-run.sh seal
./b2-run.sh teardown
```

`teardown-verification.json` must report zero residue. No command sends real
user data or production traffic.

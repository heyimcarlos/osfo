# Transactional-outbox Pub/Sub delivery prototype

This throwaway Issue 38 prototype asks whether one PostgreSQL admission
transaction plus an append-only outbox can close the durable handoff gap found
by B2 without moving runnable-work discovery back into PostgreSQL.

It uses synthetic identities only and creates isolated cloud resources with the
`osfo-b3-38` prefix. The authenticated-push worker, point claim, 15-second
lease, claim epoch, terminal fence, and acknowledgement behavior are unchanged
from the frozen worker seam.

## Run

The review evidence is one command:

```bash
./b3-run.sh decision
```

It provisions isolated Cloud SQL, Pub/Sub, Cloud Run worker and ingress
resources, exercises admission and relay process cuts, runs the frozen
100-cut, three-seed matrix, then records short 23, 232, and 464 incoming
message per second characterization lanes. Raw evidence lands under
`evidence/b3-transactional-outbox/`.

The full production-shaped lanes remain explicit:

```bash
./b3-run.sh load-manifest
./b3-run.sh scale-zero
```

Always finish by sealing the selected evidence and deleting all owned cloud
resources:

```bash
./b3-run.sh seal
./b3-run.sh teardown
```

`teardown-verification.json` must report zero residue.

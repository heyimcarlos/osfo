# Pub/Sub worker seam prototype

## Question

Should Osfo use authenticated Pub/Sub push into a Cloud Run service or the
official asynchronous StreamingPull client in a Cloud Run worker pool for
primary AgentRun delivery? The prototype isolates only delivery, claiming,
execution, acknowledgement, and scaling. Admission and outbox publication are
outside every timed window.

## Frozen authority contract

PostgreSQL already contains every authoritative AgentRun before publication.
The broker envelope contains only the AgentRun ID, a stable delivery ID, the
benchmark ID, and the client publication timestamp. Delivery latency uses the
broker's server-side publish timestamp so publisher retries cannot contaminate
the worker-side comparison. Both candidates call the
same primary-key claim and completion code with the same lease, monotonic claim
epoch, execution semaphore, workload trace, database tier, connection budget,
topic policy, region, and resource ceiling.

The pure delivery decision is:

```text
missing or terminal -> acknowledge
pending -> fenced claim
running, lease live -> retry delivery
running, lease expired -> fenced reclaim
claimed -> execute, commit outcome, acknowledge
```

No path scans PostgreSQL for runnable work. A killed worker leaves one broker
message and one finite lease. Redelivery retries that same AgentRun ID until it
can reclaim the expired lease.

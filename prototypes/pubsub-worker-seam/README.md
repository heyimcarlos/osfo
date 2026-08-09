# Pub/Sub worker seam prototype

This throwaway prototype answers one question: should the shared B2/B3 worker
use authenticated Pub/Sub push into a Cloud Run service or StreamingPull in a
Cloud Run worker pool?

It reuses the useful Issue 20 contracts, envelope shape, point-addressed claim,
claim epoch, lease, duplicate handling, and failure cases. It does not reuse
Issue 20's direct PostgreSQL recommendation or its contaminated comparison of
four warm direct workers against min-zero transactional-outbox push.

## Run

The complete cloud prototype is one command sequence:

```bash
./run.sh provision
./run.sh matrix
./run.sh collect push-fixed target-232
./run.sh teardown
```

`provision` creates only resources prefixed `osfo-b0-39` in the configured GCP
project. The region defaults to `northamerica-northeast1`. `matrix` runs the
fixed and elastic comparisons. `teardown` deletes every manifest-owned cloud
resource and writes independent inventory evidence.

The fixed comparison holds both protocols at four 1-vCPU, 1-GiB instances,
32 execution slots per instance, four database connections per instance, and
one 4-vCPU, 15-GiB PostgreSQL 17 database. The elastic comparison uses push at
min 0/max 8 and the official CREMA Pub/Sub scaler at min 0/max 8 for pull.

Evidence is written under `evidence/`. Every scenario contains the corpus and
rate manifest, authoritative audit, deployed topology, logs, and SHA-256
manifest. `collect` adds filtered Cloud Monitoring time series after their
normal ingestion delay. Generated evidence is intentionally ignored until the
selected results are sealed for the prototype branch.

## Matched live-model comparison

The ticket 152 comparison reuses the B3 GCP topology without repeating its
historical fault and qualification campaigns. It changes only two workload
inputs: one AgentRun per message and a real `openai/gpt-5-nano` OpenRouter call
with the same prompt and eight-token cap as the Cloudflare prototype.

```bash
export OPENROUTER_API_KEY="replace-with-an-openrouter-key"
./b3-matched-model-run.sh
```

The command provisions resources under the isolated `osfo-b3-152-mm` prefix,
runs one provider smoke and the four matched load lanes, seals the evidence,
and deletes every manifest-owned GCP resource. It does not rerun the earlier
cut matrix, process-loss, fairness, retention, or saturation programs.

## Safety

This prototype uses synthetic AgentRun IDs only. It never scans PostgreSQL for
runnable work. Acknowledgement happens only after a fenced terminal commit, or
when the point-addressed row is already terminal or missing. Worker death
recovers by redelivering the same ID and reclaiming its finite expired lease.

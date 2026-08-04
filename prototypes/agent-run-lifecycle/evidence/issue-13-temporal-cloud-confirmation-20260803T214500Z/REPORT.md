# Production-shaped AgentRun lifecycle evidence

## Decision

PASS: every mandatory issue-level correctness and failure coverage gate passed. The optional live-provider lane is reported separately.

Target confirmation: **FAIL**. The fixed 32-vCPU runner did not sustain the inherited 700 AgentRuns/s completion target and shed traffic at 2,083 and 4,167 AgentRuns/s. The evidence is valid for the observed cold-reconstruction lanes, but the exact duration and persistence-profile matrix remains incomplete.

Across all lanes: 879042 offered, 694382 accepted, 694381 completed, and 184660 shed before acceptance.

## Capacity result

| Stage | Offered/s | Accepted | Acceptance | Completed | Shed | Drain | Completed/s | p99 end to end |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| temporal-timer-herd-retry-batch | 0 | 20 | 100.0% | 20 | 0 | 0.0 s | 2.99 | 6691.6 ms |
| approval-gated-mailpit-batch | 0 | 20 | 100.0% | 20 | 0 | 0.0 s | 3.43 | 307.5 ms |
| steady-700-cold | 700 | 420000 | 100.0% | 420000 | 0 | 582.8 s | 355.09 | 425984.0 ms |
| steady-1400-cold | 1400 | 84000 | 100.0% | 84000 | 0 | 178.4 s | 352.34 | 134742.0 ms |
| steady-2083-cold | 2083 | 104897 | 83.9% | 104897 | 20083 | 283.0 s | 301.09 | 226623.5 ms |
| steady-4167-cold | 4167 | 85443 | 34.2% | 85443 | 164577 | 198.8 s | 330.13 | 162791.4 ms |
| e2b-focused-conformance | 1 | 1 | 100.0% | 1 | 0 | 0.0 s | 1.27 | 784.7 ms |
| rig-openai-live-conformance | 3 | 1 | 100.0% | 0 | 0 | 0.0 s | 0.00 | 0.0 ms |

The 10-minute 700/s lane accepted all 420,000 runs but required 582.8 seconds of drain after its 600-second offer window, with 355.09 completions/s over the full run and 425,984 ms p99 end-to-end latency. The 60-second 1,400/s lane also accepted all traffic but completed at 352.34/s after drain. At 2,083/s, 20,083 of 124,980 offers were shed. At 4,167/s, 164,577 of 250,020 offers were shed. These observations reject stable target completion on the current single-runner local Docker shape.

## Telemetry completeness

4 frozen load runs contributed 276 of 276 successful acceptance queries. All seven required targets were healthy: runner process, runner node, PostgreSQL exporter, Cloud SQL monitoring, Temporal Cloud, Temporal Rust SDK worker, and Prometheus.

## Cost evidence

Known GCP catalog estimate: **$24.15**. Temporal Actions first-tier list-rate equivalent: **$10.90**. Actual combined invoice cost: **MISSING**.

The GCP value uses measured provider operation intervals and exact public Catalog API SKUs. The Temporal value is a notional estimate from the frozen OpenMetrics Action series, not an invoice charge. The authoritative Temporal Billing API lags approximately 24 hours, the plan includes a monthly Action allocation, storage was not captured, and trial credits may apply. See `cost.json` for rates, formulas, exclusions, and continuing stopped-resource cost.


## Correctness gates

| Gate | Result | Evidence |
|---|---|---|
| focused durable failure cuts | PASS | 18 of 18 injected cuts passed |
| real Temporal batch | PASS | 20 workflows, 751 total history events, all approval, retry, replay, nondeterminism, sandbox, and artifact checks passed |
| approval-gated SMTP batch | PASS | 20 ToolCalls produced exactly 20 Mailpit messages |
| authority-free Rig adapter | PASS | Rig 0.41.0 returned one deterministic mock result |
| traffic accounting | PASS | 1 observed stages reconciled at caller, admission, and terminal seams |
| traffic accounting | PASS | 1 observed stages reconciled at caller, admission, and terminal seams |
| traffic accounting | PASS | 1 observed stages reconciled at caller, admission, and terminal seams |
| traffic accounting | PASS | 1 observed stages reconciled at caller, admission, and terminal seams |
| E2B focused provider conformance | PASS | artifact 968f2c3c2bda2c1990b644fd68a5ce8aaf32d834a1502d0e359e09220da5a138 was produced inside the sandbox and the sandbox was explicitly terminated |
| Rig live provider conformance | FAIL | authentication: OpenAI rejected the configured API key |
| Cloud SQL topology exercised | PASS | at least one evidence lane identifies its Osfo authority as Cloud SQL |
| full issue 13 failure matrix | PASS | all 29 required injection families have passing evidence |

## Remaining blockers

- The runner project has a 32-vCPU global Compute Engine quota, so the tested topology cannot add another runner or grow beyond the current 32-vCPU VM without a quota increase.
- The production-shaped local Docker sandbox mix needs about 28 sandboxed workflows/s at 700 AgentRuns/s, while the measured tail drains about 13 to 14/s. E2B passed focused provider conformance, but it does not replace the required local deterministic lane.
- The configured OpenAI key was rejected with `invalid_api_key`, so the real Rig-to-OpenAI conformance row is recorded as failed. The deterministic Rig lane passed.
- The full 30-minute, three-persistence-profile matrix is not justified on this fixed shape because the 10-minute 700/s lane already accumulates nearly a full offer window of drain.

No latency threshold was selected before measurement. Focused failure batches preserve every sample instead of presenting unstable tail percentiles.

## Requirement audit

See `AUDIT.md` for the issue exit-criteria mapping, known gaps, Grafana evidence hierarchy, cost interpretation, and follow-up scope.

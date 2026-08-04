# Issue 13 requirement audit

Audit date: 2026-08-03.

## Outcome

Issue 13's stated exit criteria are satisfied as a negative capacity confirmation:

- the reference journey and the separate approval-gated SMTP ToolCall passed the correctness gate;
- all 29 normalized required failure families have passing evidence;
- same-region Cloud SQL and isolated Temporal Cloud were exercised;
- p50, p90, p95, p99, maximum, sample count, throughput, and error evidence identifies the tested envelope and its limit.

The inherited demo target is not satisfied. The fixed single-runner topology accepted 700 AgentRuns/s for ten minutes, but completed only 355.09 AgentRuns/s over the full run and needed 582.8 seconds to drain. Stable completion capacity is therefore below 700 AgentRuns/s for this workload and topology.

This is not a production-readiness confirmation. `results.json` correctly records `target_result=FAIL`, `load_matrix_gate=MISSING`, and `evidence_validity=MISSING` for the complete prescribed matrix.

## Exit-criteria mapping

| Requirement | Result | Evidence |
|---|---|---|
| Reference parent and Child AgentRun journey | PASS | `results.json`, correctness gates, and `evidence/temporal-cloud-focused-20-cloudsql/temporal-reports.json` |
| Versioned eight-step awaited Temporal workflow | PASS | 20 of 20 real workflows completed with 751 total history events |
| Editorial and release approval ordering and idempotency | PASS | Temporal approval failure rows cover duplicate, wrong-order, and post-settlement updates |
| Separate approval-gated SMTP ToolCall | PASS | 20 of 20 ToolCalls produced exactly 20 Mailpit messages |
| PostgreSQL remains lifecycle authority | PASS | Cloud SQL topology and authority assertions passed; Temporal workers did not write AgentRun or ThreadEvent authority |
| Child AgentRuns are Osfo AgentRuns | PASS | Typed child outcomes, concurrent ChildJoin settlement, deadline cancellation, and late outcomes passed |
| Sandbox and artifact authority | PASS | Missing and invalid sandbox states, cold reconstruction, immutable export checksum, mutation rejection, and lost commit acknowledgement passed |
| Runtime checkpoint is optional acceleration | PASS | Absent, deleted, corrupt, and incompatible checkpoint fallback passed |
| Required failure cuts | PASS | 29 of 29 normalized injection families passed, with observed recovery and invariant text in `results.json` |
| Same-region Cloud SQL | PASS | PostgreSQL 17 Enterprise in `northamerica-northeast1`, with the runner in `northamerica-northeast1-c` |
| Isolated real Temporal | PASS | Temporal Cloud namespace `osfo.qvao9` in `gcp-us-east4`, On-Demand, 500 APS; Temporal persistence is managed and separate from Osfo Cloud SQL |
| Real artifact store | PASS | Regional Google Cloud Storage artifact store and checksum-verified ArtifactRefs |
| Focused hosted sandbox conformance | PASS | E2B SDK 2.38.0 completed create, command, artifact, and teardown in 784.7 ms |
| Focused live Rig provider smoke | FAIL, optional | OpenAI rejected the supplied credential before model usage; the sanitized lane records only the `invalid_api_key` classification |
| Percentile and throughput report | PASS | `dashboard.html`, `REPORT.md`, `results.json`, latency CSVs in source bundles, and 276 of 276 frozen telemetry queries |
| Capacity limit identified | PASS | No stable completion point at or above 700 AgentRuns/s; 2,083/s and 4,167/s safely shed before acceptance with no lost accepted work |
| Exact infrastructure and teardown | PASS | `teardown.json` records runner `TERMINATED`, Cloud SQL `STOPPED`, activation policy `NEVER`, and CPU quota usage returned to zero |
| Observed cost | PARTIAL | `cost.json` records a reproducible $24.15 GCP public-list estimate and a $10.90 Temporal Action list-rate equivalent. Provider invoice totals remain unavailable |

## Load and latency result

| Offered stage | Accepted | Completed | Shed | Completion rate over full run | Drain | End-to-end p99 |
|---:|---:|---:|---:|---:|---:|---:|
| 700/s for 600 s | 420,000 | 420,000 | 0 | 355.09/s | 582.8 s | 425,984.0 ms |
| 1,400/s for 60 s | 84,000 | 84,000 | 0 | 352.34/s | 178.4 s | 134,742.0 ms |
| 2,083/s for 60 s | 104,897 | 104,897 | 20,083 | 301.09/s | 283.0 s | 226,623.5 ms |
| 4,167/s for 60 s | 85,443 | 85,443 | 164,577 | 330.13/s | 198.8 s | 162,791.4 ms |

The capacity knee's upper bound is below 700 AgentRuns/s for the tested production-shaped mix. The dominant measured limit is the constrained local Docker sandbox lane, which needs about 28 sandboxed workflows/s at a 700 AgentRuns/s offer rate but drained about 13 to 14/s. Runner CPU peaked at 84.4%, Cloud SQL CPU at 68.9%, and Temporal Action utilization at 27.6%, with no Temporal Action or request throttling.

## Grafana and durable telemetry

Grafana was used as the live inspection layer. It is not the authority for the verdict.

The source load bundles preserve:

- five provisioned Grafana dashboard definitions;
- Prometheus, Grafana, exporter, Cloud SQL, runner, and Temporal configuration;
- exact UTC query windows;
- raw JSON for every acceptance query;
- target health and Prometheus runtime metadata;
- fixed manifests, dependency versions, run logs, latency CSVs, and checksums.

The consolidated `telemetry.json` embeds all four final load windows. It contains 276 successful query results out of 276 and reports all seven required scrape targets healthy. `dashboard.html` is the self-contained offline review surface built from those frozen records.

## Cost interpretation

`cost.json` separates measured usage, catalog estimates, and authoritative billed cost.

- GCP known public-list estimate through teardown capture: $24.15.
- Temporal frozen non-background Action estimate: approximately 217,996 Actions.
- Temporal first-tier list-rate equivalent: $10.90.
- Actual combined invoice cost: MISSING.
- Continuing retained-resource list cost: about $101.68 per full August month until the two 250 GiB SSD allocations and Cloud SQL IPv4 reservation are deleted or reconfigured.

The Temporal figure is not an incremental charge claim. Essentials includes 1 million Actions each calendar month, the account plan is separate, storage usage was not frozen, trial credits may apply, and the Billing API is authoritative. Current-month Billing API data lags approximately 24 hours and is provisional until month close.

## Known gaps and follow-up

1. The full duration and three-persistence-profile load matrix is MISSING. The current shape failed the first sustained 700/s target, so longer repetitions would add cost without changing the capacity decision.
2. The actual worker split was 32 admission workers and 224 execution workers: 100 basic, 15 child, 85 Temporal, 20 sandbox, and 4 SMTP. This differs from the prescribed manifest split even though the total remained 256. The evidence confirms the actual declared topology only.
3. Project-wide Compute Engine quota is 32 vCPUs. It blocked a larger runner or second fixed runner.
4. The deterministic Docker sandbox lane is the measured bottleneck.
5. Temporal Rust replay works in the prototype but crosses unstable or hidden SDK surfaces.
6. The live Rig provider smoke failed authentication and is optional to the issue exit criteria.
7. Provider invoice cost and Temporal storage remain unavailable today.

Focused follow-ups:

- GitHub issue 19: scale the fixed deterministic Docker sandbox fleet and rerun the exact 700/s target before testing higher rates.
- GitHub issue 15: establish a supported, version-pinned Temporal Rust replay gate.

## Reproduction and integrity

Use `REPORT_SHA256SUMS` as the bundle root. `SHA256SUMS` covers the supporting machine-readable artifacts. Individual source bundles referenced by `inputs.json` preserve their own configuration, raw telemetry, latency CSVs, logs, and checksum files.

No secret value is present in this audit, the evidence JSON, the HTML, or the GitHub issue records.

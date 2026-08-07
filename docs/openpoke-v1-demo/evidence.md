# Evidence matrix

This matrix separates measured facts from production qualification. `PASS`
means the named scope passed. `FAIL` means the named scope was measured and
failed. `MISSING` means the required proof does not exist in this packet. A
historical or non-production `PASS` is never promoted to current production
qualification.

## Exact 100k DAU arithmetic

| Step | Exact arithmetic | Status | Source and assumption |
| --- | ---: | :---: | --- |
| Daily active users | 100,000 | PASS | Assignment input, retained in the [100k DAU scorecard](assets/grafana/openpoke-100k-scorecard.png). |
| Incoming messages per active user per day | 20 | PASS | Explicit presentation assumption, not a measured product fact. |
| Daily incoming messages | 100,000 x 20 = 2,000,000 | PASS | Exact multiplication. |
| Daily average | 2,000,000 / 86,400 = 23.148148... messages/s | PASS | Exact division, displayed as 23.15 messages/s. |
| Peak factor | 10x daily average | PASS | Explicit presentation assumption, not a product SLO. |
| Modeled peak | 23.148148... x 10 = 231.481481... messages/s, rounded up to 232 | PASS | The selected incoming-message target. |
| Reference trace amplification | 626,400 / 417,600 = 1.5 AgentRuns per message | PASS | Both sustained [rep 1](evidence/runs/sustained-target-232-rep1/audit.json) and [rep 2](evidence/runs/sustained-target-232-rep2/audit.json). |
| Delivery target | 232 x 1.5 = 348 AgentRuns/s | PASS | Exact derived internal demand, confirmed by the [pre-admitted control](evidence/runs/pre-admitted-348/audit.json). |
| Concurrent authenticated devices at target | The local three-tab journey proves independent authenticated resume without target load; no selected load lane combines target traffic with 2 to 4 live device streams per account | MISSING | [Local recording](assets/three-tab/authenticated-three-tab-resume.mp4) is useful protocol proof, not the missing production-load combination. |

## Load and failure requirements

| Requirement | Exact result | Status | Checksummed source and scope |
| --- | --- | :---: | --- |
| Short selected-topology target | 13,920 / 13,920 commands accepted, 20,880 / 20,880 AgentRuns succeeded, receipt p99 631.585 ms, maximum 797.256 ms, zero reconciliation violations | PASS | [Scenario](evidence/runs/short-target-232/scenario.json), [audit](evidence/runs/short-target-232/audit.json), and [caller summary](evidence/runs/short-target-232/caller-summary.json). This is a 60-second Montreal topology control, not production qualification. |
| Sustained target repetition 1 | 417,600 / 417,600 accepted, 626,400 / 626,400 succeeded, zero nonterminal work, receipt p99 204.241 ms, 83 over 1 second, 99.98012452% within 1 second | PASS | [Scenario](evidence/runs/sustained-target-232-rep1/scenario.json), [audit](evidence/runs/sustained-target-232-rep1/audit.json), [caller summary](evidence/runs/sustained-target-232-rep1/caller-summary.json), and [receipt derivation](evidence/receipt-slo.json). Non-production region. |
| Sustained target repetition 2 | 417,600 / 417,600 accepted, 626,400 / 626,400 succeeded, zero nonterminal work, receipt p99 1,598.577 ms, 9,105 over 1 second, 97.81968391% within 1 second | FAIL | [Scenario](evidence/runs/sustained-target-232-rep2/scenario.json), [audit](evidence/runs/sustained-target-232-rep2/audit.json), [caller summary](evidence/runs/sustained-target-232-rep2/caller-summary.json), and [receipt derivation](evidence/receipt-slo.json). The receipt gate failed. |
| Final `us-east4` A/B/C/D matrix | A: 416,518 accepted, 1,082 unknown, 83.69348659% within 1 second, receipt p99 4,557.002 ms. B: 411,270 accepted, 6,330 unknown, 79.48563218% within 1 second, p99 12,212.259 ms. C: 369,152 accepted, 48,448 unknown, 12.21743295% within 1 second, p99 14,402.979 ms. D: 410,372 accepted, 7,228 unknown, 35.12308429% within 1 second, p99 13,007.533 ms. Each cell offered 417,600. | FAIL | The copied [stable summary](evidence/final-us-east4-matrix-summary.json) records all four admission failures and accepted-work reconciliation passes. |
| Production topology cell D reconciliation | 410,372 Good Root Outcomes and 615,590 / 615,590 AgentRuns succeeded with zero nonterminal, duplicate-terminal, unfinished AgentRun attempt, or unfinished ModelCall attempt counts | PASS | Accepted-work correctness in the [stable summary](evidence/final-us-east4-matrix-summary.json). It does not override the admission failure. |
| Retained-history hypothesis | With current WAL, clean A atomic admission averaged 37.374086 ms and receipt p99 was 4,557.002 ms; preloaded C averaged 244.337152 ms and p99 was 14,402.979 ms | PASS | The stable matrix marks the history hypothesis `SUPPORTED`. This is a causal qualification of the measured comparison, not production qualification. |
| Larger-WAL effect on preloaded history | C produced 38,761,102,246 WAL bytes and started 47 checkpoints; D produced 12,861,783,893 WAL bytes and started 3 checkpoints. D still failed admission. | FAIL | The stable matrix conclusion is `REDUCES_WAL_AND_CHECKPOINT_CHURN_BUT_DOES_NOT_QUALIFY_ADMISSION`. |
| Provider teardown, source scope | Both verified provider roots report `manifest_owned_cloud_residue=0` with empty services, worker pools, SQL, topics, subscriptions, repositories, secrets, service accounts, and project IAM inventories | PASS | Externally verified source evidence, recorded in [issue #87](https://github.com/heyimcarlos/osfo/issues/87#issuecomment-5213382073). The copied [matrix summary](evidence/final-us-east4-matrix-summary.json) records `checksums_verified` and both provider-root seal digests. Per handoff, raw lane and teardown files are not packet-owned, so this is not a packet-verifiable teardown artifact. |
| Request error rate in both sustained repetitions | 0 admission failures / 417,600 offered = 0% in each repetition | PASS | Both checksummed caller summaries contain one `accepted` outcome for every offer. This does not override repetition 2's receipt-latency failure. |
| Current production throughput ceiling | All four final matrix cells fail at the 232 messages/s target, but no sealed `us-east4` knee run establishes the highest healthy concurrent stream count or message rate | MISSING | A failing target matrix is not a measured healthy ceiling. |
| Current production breaking point | No selected `us-east4` overload lane has established the first failing component and failure signature | MISSING | Historical Toronto direct-dispatch evidence is contextual only. |
| Historical 464 messages/s boundary | 13,920 offered, 11,284 accepted, 9,433 client-observed completions, 4,487 rejected or failed, admission p95 30,752.767 ms, drain 90.655775 s, correctness false | FAIL | Existing sealed [historical result](../../prototypes/agent-run-lifecycle/evidence/deployed-toronto-luna-claim-split-breaking-464-30s-20260804T055000Z/results.json). It used the superseded direct-dispatch topology. |
| Current selected-topology saturation | CPU, memory, open connections, queue depth, and PostgreSQL utilization are not all present for one production-qualified selected lane | MISSING | The [capacity dashboard](assets/grafana/openpoke-capacity-postgres.png) predates cell D and preserves the missing fields. |
| Before-claim worker loss | 1 / 1 accepted and succeeded, 2 deliveries, zero lost or ghost work, zero duplicate terminal commits, zero unfinished attempts | PASS | [Scenario](evidence/runs/worker-loss-before-claim/scenario.json) and [audit](evidence/runs/worker-loss-before-claim/audit.json). Focused non-production cut. |
| After-claim worker loss | 1 / 1 accepted and succeeded under attempt 2, zero lost work, zero duplicate terminal commits, zero unfinished AgentRun or ModelCall attempts | PASS | [Scenario](evidence/runs/worker-loss-after-claim/scenario.json) and [audit](evidence/runs/worker-loss-after-claim/audit.json). Focused non-production cut. |
| Process loss under selected production load | No sealed production lane combines process loss with the selected full workload | MISSING | Focused single-run cuts do not certify the complete load case. |
| Historical process loss under load | 4,640 / 4,640 accepted and completed, 0 lost, 0 duplicate authority records, drain 12.751011 s after a 16 -> 1 -> 16 worker cut | PASS | Existing sealed [historical result](../../prototypes/agent-run-lifecycle/evidence/deployed-toronto-final-db8-process-loss-worker16-to1-to16-20260804T024000Z/results.json) and [cut record](../../prototypes/agent-run-lifecycle/evidence/deployed-toronto-final-db8-process-loss-worker16-to1-to16-20260804T024000Z/EVIDENCE.md). Superseded direct-dispatch topology. |
| Correctness under sustained selected-topology load | Both 30-minute repetitions finished all accepted AgentRuns with zero stranded work, ghost delivery, duplicate terminal commits, nonterminal work, unfinished attempts, or budget mismatch | PASS | The two copied sustained audits. This certifies accepted-work reconciliation only, not the receipt gate or multi-device streams. |
| Multi-device correctness under target load | No selected lane proves zero gaps, duplicates, and ordering for several authenticated devices while target load runs | MISSING | The [multi-device dashboard](assets/grafana/openpoke-multi-device.png) keeps every detailed requirement `MISSING`. |
| Historical deployed cursor replay | 4 devices, zero gaps, correct order, identical replay, resume after cursor, zero resume duplicates | PASS | Existing sealed [four-device result](../../prototypes/agent-run-lifecycle/evidence/deployed-toronto-multi-device-20260804T014400Z/results.json). This is separate historical evidence, not the current local journey or a target-load proof. |
| External-action retry control | 20 / 20 bounded SendEmail ToolCalls produced exactly 20 Mailpit messages; duplicate decision and terminal outcome returned idempotent replay | PASS | Existing sealed [Issue 13 result](../../prototypes/agent-run-lifecycle/evidence/issue-13-temporal-cloud-confirmation-20260803T214500Z/results.json). Focused test sink only. |
| Production external-action guarantee | No production ActionReceipt lane proves retries against a real external action provider | MISSING | The Mailpit control explicitly does not establish production ActionReceipt semantics. |
| Recovery-rate screen | Four workers: claim p99 10,966.367 ms. Six: 30.548 ms. Eight: 40.649 ms. Every fleet completed 36,540 / 36,540 at 609 AgentRuns/s before offer end. | PASS | [Four](evidence/runs/recovery-rate-609-workers-4/audit.json), [six](evidence/runs/recovery-rate-609-workers-6/audit.json), and [eight](evidence/runs/recovery-rate-609-workers-8/audit.json). Six is the selected fixed-fleet candidate. |
| Full outage recovery and backlog drain | The required 15-minute outage creates 313,200 AgentRuns. The final matrix used the 400,000-AgentRun reserve candidate, leaving 86,800 nominal slots, but did not execute the declared outage. No sealed proof shows progress within 5 minutes and full drain within 20 minutes. | MISSING | Reserve sizing is present; outage, recovery, drain, and cost qualification remain absent. The [durability dashboard](assets/grafana/openpoke-durability-recovery.png) keeps each recovery requirement `MISSING`. |
| Run-specific visual summaries | 13 deterministic 1600 x 900 PNG cards cover final matrix A/B/C/D, short target, sustained repetitions 1 and 2, pre-admitted delivery, recovery fleets 4/6/8, and before/after-claim worker loss | PASS | [Sealed card directory](assets/post-run/). Every card is explicitly labeled `post-run render from sealed records, not an in-run screen capture`; these are not historical in-run recordings. |
| Five Grafana views | Five 1920 x 1080 captures exist and their copied bytes match the packet index | PASS | [Scorecard](assets/grafana/openpoke-100k-scorecard.png), [capacity](assets/grafana/openpoke-capacity-postgres.png), [durability](assets/grafana/openpoke-durability-recovery.png), [multi-device](assets/grafana/openpoke-multi-device.png), and [topology](assets/grafana/openpoke-topology-evolution.png). The capacity view was regenerated through Grafana from the corrected dashboard definition and sealed final matrix mapping. Dashboard panels remain derived presentation, not authority. |
| Authenticated three-tab independent resume recording | Three real Chrome tabs use one authenticated Principal and Thread with independent tab state. B disconnects at cursor 0 and resumes through 5, C disconnects at 5 and resumes through 10, A disconnects at 10 and resumes through 15, and all projections converge through 15. | PASS | [MP4](assets/three-tab/authenticated-three-tab-resume.mp4), [semantic journey](assets/three-tab/journey.json), and [ffprobe result](assets/three-tab/ffprobe.json). This is a local PostgreSQL journey. Sender-close-mid-response, session expiry, revocation, target load, and production scope are not exercised. |
| Overall production qualification | Required production-region admission, overload knee, saturation, full recovery, multi-device target load, production ActionReceipt, and complete cost are not all closed | MISSING | No lower-level pass is promoted to an overall pass. |

## Current selected operating inputs

These are configuration inputs, not saturation evidence:

| Input | Current value |
| --- | ---: |
| Ordered subscriptions | 1 |
| Fixed workers | 6 candidate |
| StreamingPull streams | 4 per worker, 24 total |
| Execution slots | 32 per worker, 192 total |
| PostgreSQL pool cap | 8 per worker, 48 total |
| Relay selector | 1 active N1 selector |
| Relay publisher workers | 4 recoverable publishers |
| Principal-first publication window | 128 records |
| Selected-region durable reserve | 400,000 AgentRuns, candidate exercised by the final admission matrix; outage qualification still `MISSING` |
| Historical Montreal reserve | 4,096 AgentRuns, superseded and rejected for the full outage contract |

## Evidence catalog disposition

The cockpit catalog covers every row above and resolves narrative links to the
structured JSON that owns the measured fact. It discovers all 13 packet runs:
four final matrix cells, short target, two sustained repetitions, pre-admitted
delivery, recovery fleets 4/6/8, and before/after-claim worker loss. The copied
[`final-us-east4-matrix-summary.json`](evidence/final-us-east4-matrix-summary.json)
is authoritative for A/B/C/D admission, PostgreSQL, WAL, checkpoint, and
accepted-work reconciliation facts. Presence never overrides its four failed
admission verdicts.

The checksum-sealed snapshots in [`evidence/catalog/`](evidence/catalog/) add
current development runtime facts, all bounded development SSE attempts, and
read-only development cloud metadata. They remain development evidence and
keep production qualification `MISSING`. The GitHub issue snapshot records
issue dispositions and outstanding requirements as contextual external
authority. It cannot establish a sealed measurement.

Selected historical sources remain visible for the superseded Toronto 464/s
break, process loss under load, four-device replay, and the Mailpit Action
control. Other prototype, local, historical, malformed, unsealed, or
checksum-mismatched sources are linked or explicitly excluded with reasons.
None can fill the four production placeholders: selected-topology saturation,
full outage recovery and drain, production ActionReceipt proof, or complete
production cost. Generated normalized catalog and coverage reports are derived
views and are intentionally absent from `artifact-index.json`.

## Integrity

Every copied artifact is listed in [`artifact-index.json`](artifact-index.json).
Run:

```bash
bun run demo:evidence:verify
```

The verifier rejects a malformed index, duplicate artifact IDs, missing files,
non-regular files, canonical realpath escapes, and SHA-256 mismatches. For each
provenanced artifact it also parses the referenced typed source manifest and
requires the exact original path and digest entry. `MISSING` entries must have
no path or checksum, so a placeholder cannot look like present evidence. The
card renderer runs this verifier before reading any record or invoking
Chromium. It then rechecks each input through a canonical, no-follow handle,
builds the complete card set in temporary staging, requires every reproduced
byte and manifest to match the index, and verifies the packet again without
overwriting sealed assets. The opt-in three-tab command keeps normal tests side-effect free,
removes raw frames, validates the final codec, dimensions, and frame rate with
ffprobe, and seals only the MP4, semantic journey, and probe result.

# AgentRun lifecycle prototype

This production-shaped prototype validates issue 13 through Osfo-owned seams:

```text
deterministic or Rig Agent Runtime
  -> lifecycle manager -> PostgreSQL authority
                       -> Osfo-hosted workers -> Temporal Cloud workflow history
                       -> constrained Docker sandbox
                       -> immutable artifact store
                       -> approval-gated Mailpit SMTP sink
```

Run the local correctness suite:

```sh
./prototypes/agent-run-lifecycle/local.sh test
```

Run the complete local evidence suite:

```sh
./prototypes/agent-run-lifecycle/local.sh evidence-local
```

The command prints the final self-contained `dashboard.html` path. During a
run, the live operator views are:

- Grafana: `http://127.0.0.1:3000/d/osfo-agent-run-lifecycle`
- Prometheus: `http://127.0.0.1:9090`
- Mailpit: `http://127.0.0.1:8025`

Grafana is deliberately not the durable evidence source. The runner preserves
the manifest, JSON, CSV, raw focused samples, and one offline HTML dashboard so
the result remains inspectable after the containers and cloud resources are
gone. A consolidated report merges every frozen Prometheus query series into
`telemetry.json` and embeds the same data into `dashboard.html`.

The Osfo PostgreSQL database owns AgentRun lifecycle state and typed records.
Temporal Cloud owns WorkflowInstance execution history. Cloud credentials and
optional provider keys belong only in an untracked `.env`.

Temporal Cloud is the only orchestration lane. Osfo runs the Rust workflow and
Activity workers in its own compute project. Start the Cloud SQL support and
Temporal Cloud observability stack with all three Compose files:

```sh
docker compose \
  -f prototypes/agent-run-lifecycle/compose.yaml \
  -f prototypes/agent-run-lifecycle/compose.cloud.yaml \
  -f prototypes/agent-run-lifecycle/compose.temporal-cloud.yaml \
  up -d
```

`TEMPORAL_METRICS_API_KEY_FILE` must point to a mode `0400` file outside the
repository owned by UID/GID `65534`, the runtime identity of the pinned
Prometheus image. It contains a Temporal service-account key with only the
account-level Metrics Read-Only role. The workflow API key remains separate.
Prometheus honors Temporal Cloud source timestamps and scrapes every 30 seconds.
Cloud metrics are one-minute aggregates that arrive about three minutes later,
so the acceptance runner waits 210 seconds after the workload before capturing
the final range.

The `Issue 13 Temporal Cloud capacity` Grafana dashboard preserves action-rate
utilization, throttling, service errors, task-queue backlog, Cloud latency,
worker SDK queue latency, worker slot saturation, and billable action mix.

The local Docker provider is a seam and lifecycle test. It is not evidence of
production hostile-code isolation, particularly when the host daemon is not
rootless.

Run the optional E2B conformance lane from the repository root after placing
`E2B_API_KEY` only in the untracked `.env`:

```sh
cd prototypes/agent-run-lifecycle/conformance/e2b
npm ci --ignore-scripts
npm audit --audit-level=high
set -a; source ../../../../.env; set +a
node smoke.mjs
```

The E2B SDK is pinned to 2.38.0. Its optional Undici dependency is overridden
to 8.9.0 because the version selected by the upstream package had published
security advisories. The smoke disables sandbox internet access, runs one
artifact-producing command, verifies its hash, and explicitly terminates the
sandbox. It is focused provider conformance only.

Run the optional real Rig provider lane through OpenRouter from the prototype
directory:

```sh
set -a; source ../../.env; set +a
OSFO_EVIDENCE_DIR=evidence/rig-openai-live \
  cargo run --locked --bin provider_evidence
```

The lane pins Rig 0.41.0 and defaults to the explicitly named
`openai/gpt-5.6-luna` model. It stores only the provider, model, latency,
response hash, and a sanitized failure class. It never records the API key,
prompt, response, or raw provider error. A provider response does not become
AgentRun lifecycle authority.

Run the live reasoning discovery lane to measure work amplification instead of
assuming it:

```sh
set -a; source ../../.env; set +a
OSFO_REASONING_REPETITIONS=3 \
OSFO_EVIDENCE_DIR=evidence/reasoning-discovery-luna \
  cargo run --locked --bin reasoning_discovery
```

The typed Luna decision records quick replies, child AgentRuns, awaited and
detached joins, Temporal workflows and Activities, approval-gated ToolCalls,
proactive messages, reminders, sandbox jobs, and artifact commits. The JSON
schema and semantic validator permit one bounded correction request. Raw user
or model text is never written to evidence. The resulting measured distribution
is the input to the deterministic capacity lane, not a claim about the final
production population.

The external deployed load generator supports four explicit open-loop arrival
patterns through `OSFO_LOAD_ARRIVAL_PATTERN`: `uniform`, `linear-ramp`,
`burst`, and `idle-to-burst`. For a burst, the generator offers
`OSFO_LOAD_RATE_PER_SECOND * OSFO_LOAD_DURATION_SECONDS` messages at the same
scheduled instant. A linear ramp also requires
`OSFO_LOAD_START_RATE_PER_SECOND`. Idle-to-burst uses
`OSFO_LOAD_IDLE_SECONDS` before the scheduled impulse. Every lane records the
pattern and schedule parameters in `results.json`.

Set `OSFO_LOAD_JOURNEY_PROFILE=luna-discovery` to replay the recorded Luna work
graph. Each root AgentRun stores its typed decision, and the evidence endpoint
requires every declared count to match actual PostgreSQL records before the
sample passes.

Run actual Temporal Cloud workflows separately at the workflow rate measured by
the reasoning discovery. For the confirmed 0.357 workflows per message and a
232 messages/s target, the rounded workflow rate is 83/s:

```sh
set -a; source ../../.env; set +a
OSFO_TEMPORAL_LOAD_ARRIVAL_PATTERN=uniform \
OSFO_TEMPORAL_LOAD_RATE_PER_SECOND=83 \
OSFO_TEMPORAL_LOAD_DURATION_SECONDS=15 \
OSFO_TEMPORAL_LOAD_OUTPUT=evidence/temporal-cloud-load-83s/results.json \
  cargo run --locked --features temporal-cloud --bin temporal_cloud_load_client
```

Use `OSFO_TEMPORAL_LOAD_ARRIVAL_PATTERN=timer-herd` with an explicit
`OSFO_TEMPORAL_LOAD_COUNT` for a concurrent durable-timer burst. This lane
captures complete Temporal histories and worker identities. It does not write
AgentRun or ThreadEvent authority from workflow code.

Build the consolidated offline report with `deployed_dashboard`. Pass the
traffic results through `OSFO_DEPLOYED_RESULT_FILES`, the live Luna result
through `OSFO_REASONING_DISCOVERY_RESULT`, actual workflow runs through
`OSFO_TEMPORAL_RESULT_FILES`, recovery and provider records through
`OSFO_AUXILIARY_EVIDENCE_FILES`, and the sanitized planning estimate through
`OSFO_COST_RESULT`. The HTML keeps missing or failed requirements visible.

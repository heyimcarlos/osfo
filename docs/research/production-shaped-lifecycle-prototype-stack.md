# Production-shaped lifecycle prototype stack

Research date: 2026-08-02. Library and hosted-service capabilities change, so
pin every evaluated version and capture exact deployment metadata in the test
report.

## Decision

Issue 13 should become a production-shaped system prototype, not only a Cloud
SQL mutation benchmark. The smallest credible stack is:

```text
deterministic Osfo Agent Runtime adapter
              |
              v
Osfo AgentRun manager in Rust
  |        |           |              |
  |        |           |              +--> local Mailpit SMTP sink
  |        |           +--> local Docker SandboxProvider
  |        +--> real Temporal service + Rust workflow worker
  +--> real same-region Cloud SQL + real artifact bucket

focused conformance lanes, outside load measurements
  +--> Rig 0.41 adapter with Rig mock model
  +--> small live-provider Rig smoke test
  +--> optional E2B or Daytona hosted-sandbox smoke test
```

This tests the real authority boundaries and service glue while keeping model
latency, provider quotas, and human response time out of the Cloud SQL capacity
measurement. The load path must use real Cloud SQL, real Temporal workflow
history, real container lifecycle operations, real artifact export, and real
SMTP protocol delivery to a test sink. Model outputs, approval decisions,
Activity failures, and timing distributions should be deterministic fixtures.

Rig, Temporal, and the SandboxProvider must sit behind Osfo-owned interfaces.
None of their serialized state is the authority for AgentRun, ToolCall,
ThreadEvent, or ArtifactRef state.

## Why the lanes are separated

The benchmark is answering two different questions:

1. Does the complete Osfo lifecycle remain correct and healthy at the accepted
   traffic envelope on Cloud SQL?
2. Can the chosen external libraries and services implement their assigned
   seams without semantic mismatch?

Putting live model traffic or hosted-sandbox variability into every load sample
would confound the first answer. Replacing Temporal or sandbox execution with
in-memory fakes would weaken the second answer. The proposed lanes keep the
durability-producing services real and make only decision inputs deterministic.

| Surface | Main load path | Focused conformance path |
| --- | --- | --- |
| Agent Runtime | Osfo deterministic adapter | Rig `AgentRun` and `AgentRunner` adapter |
| Model | Scripted typed ModelCall results | Rig mock model, then a small live-provider sample |
| Tool | Scripted typed tool choices, real ToolCall commits | Rig tool-call and hook mapping |
| Workflow | Real Temporal service and Rust worker | Replay, cancellation, duplicate delivery, and worker-loss tests |
| Approval | Deterministic approve, reject, duplicate, and timeout events | Manual UI or API smoke for each approval path |
| Sandbox | Real local Docker container operations | Optional E2B or Daytona provider adapter |
| Email | Real SMTP transaction into Mailpit | Optional explicitly approved live-email smoke |
| Artifact | Real object upload, checksum, and metadata commit | Missing, corrupt, and delayed export tests |
| Database | Real same-region Cloud SQL | Zonal and regional HA variants |

## Reference journey

Use one story that naturally exercises the complete contract instead of many
unrelated synthetic endpoints. A good fixture is a reviewed outbound briefing:
the user asks an agent to investigate a topic, prepare an artifact in a
sandbox, collect approvals, wait until a requested release time, and send the
approved result.

### Parent and child AgentRuns

```text
Parent AgentRun
  1. deterministic or Rig-backed ModelCall selects the plan
  2. admit two Child AgentRuns with stable identities
  3. wait on ChildJoin(AllTerminal)
  4. consume typed child outcomes
  5. start one Awaited WorkflowInstance
  6. wait, wake once, and produce final AssistantOutput
```

The children should have mixed duration and outcome fixtures. One returns a
typed research result, and one returns a durable artifact reference. Separate
cases exercise `FirstSuccessful`, deadline, child cancellation, late completion,
and duplicate admission. Do not model Osfo Child AgentRuns as Temporal child
workflows. That would erase the authority boundary the prototype is intended to
test.

### Eight-step awaited Temporal workflow

Use one typed workflow with these externally visible steps:

1. Validate the stable Osfo WorkflowInstance identity and input version in an
   Activity.
2. Request editorial approval and wait for an approval Update.
3. Run a short durable timer representing a review or release delay.
4. Create or resume a sandbox in an Activity.
5. Produce and export an immutable draft artifact, then verify its checksum.
6. Request release approval and wait for a second approval Update.
7. Execute a synthetic publish Activity with configured retry and injected
   failures.
8. Deliver one typed terminal outcome to Osfo, with duplicate delivery enabled
   in selected cases.

Temporal's current Rust SDK exposes typed workflow macros for `run`, `signal`,
`query`, and `update` methods, and its workflow context supplies Activities,
timers, deterministic joins and conditions. Workflow Updates can mutate state
and return a result, which is a better fit than a fire-and-forget Signal for an
approval API that must tell the caller whether a specific decision was accepted.
The client can start an Update or execute it while waiting for its result.
[Temporal Rust SDK 0.5 workflow guide](https://docs.rs/crate/temporalio-sdk/latest),
[Temporal WorkflowHandle API](https://docs.rs/temporalio-client/latest/temporalio_client/struct.WorkflowHandle.html).

Use a stable approval request ID inside each Update payload. The workflow should
idempotently return the prior decision for a duplicate request, reject a
decision for the wrong gate, and prevent a later decision from changing a
settled gate. These are Osfo prototype rules, not behavior delegated to
Temporal.

The workflow should race cancellation against timers, Activities, and approval
conditions. The Rust SDK exposes cancellable timers and Activities, and its
client handle exposes workflow cancellation.
[Temporal workflow context](https://docs.rs/temporalio-sdk/latest/temporalio_sdk/struct.SyncWorkflowContext.html),
[Temporal WorkflowHandle cancellation](https://docs.rs/temporalio-client/latest/temporalio_client/struct.WorkflowHandle.html).

### Separate non-workflow approval path

The same parent scenario should also exercise a bounded ToolCall that does not
start a WorkflowInstance:

```text
Rig or deterministic model requests SendEmail ToolCall
  -> Osfo commits ToolCall intent
  -> Osfo records a durable approval interruption and moves AgentRun to waiting
  -> approval commits once and wakes the same AgentRun
  -> SMTP execution attempt sends to Mailpit
  -> Osfo commits one terminal ToolCall outcome
```

This is intentionally distinct from the awaited workflow approvals. It proves
that ordinary ToolCall approval does not require Temporal and that an approved
external effect still observes fencing and stable ToolCall identity.

OpenAI's Agents SDK is a useful comparable for this interaction shape. A tool
can declare `needs_approval`; a run exposes pending interruptions, serializes a
`RunState`, accepts or rejects a specific tool call, and resumes the original
run. The documented example uses `send_email` as the approval-gated tool.
[OpenAI Agents SDK human-in-the-loop guide](https://openai.github.io/openai-agents-python/human_in_the_loop/).
Osfo should emulate the interrupt and resume semantics, but keep the approval
record and AgentRun authority in PostgreSQL rather than persisting an SDK
`RunState` as its contract.

Mailpit is a suitable first external-effect sink because it is a real SMTP
server, has a REST API for integration assertions, ships an official Docker
image, and can inject SMTP errors through its chaos controls.
[Mailpit project](https://github.com/axllent/mailpit),
[Mailpit Docker setup](https://mailpit.axllent.org/docs/install/docker/),
[Mailpit integration testing](https://mailpit.axllent.org/docs/integration/).
It proves protocol delivery and retry behavior without sending mail to a real
recipient. A live-email smoke can be a separately approved follow-up.

## Rig integration assessment

Rig v0.41.0 is the current tagged release as of the research date. Rig is a
Rust library for LLM-powered applications, not Osfo's durable manager.
Its current public surface is nevertheless a close fit for the Agent Runtime
adapter. Rig describes itself as a Rust library with provider-neutral
completion abstractions, agents, tools, and multiple provider integrations.
[Rig v0.41.0 release](https://github.com/0xPlaygrounds/rig/releases/tag/v0.41.0),
[Rig repository](https://github.com/0xPlaygrounds/rig),
[Rig completion abstractions](https://docs.rs/rig-core/latest/rig_core/completion/).

### Useful surfaces

| Rig surface | What it provides | Osfo use |
| --- | --- | --- |
| `Agent<M>` | Model, preamble, static and dynamic context, tools, memory, and run defaults | Build the pinned behavior for one adapter version |
| `AgentRunner<M>` | Hook-aware driver for model I/O, tool execution, memory, blocking, and streaming runs | Focused end-to-end adapter smoke |
| `AgentRun` | Sans-I/O, steppable, serializable model and tool loop | Preferred mapping point for Osfo-proposed ModelCall and ToolCall steps |
| `AgentRunStep` | `CallModel`, `CallTools`, and `Done` next actions | Map to Osfo's authority-free typed step interface |
| `AgentHook` | Run-scoped observation and steering through typed `StepEvent` values | Correlate model and tool behavior, never commit authority directly |
| `MockCompletionModel` | Scripted deterministic completion model behind the `test-utils` feature | Rig adapter conformance without provider traffic |

Rig v0.41.0 describes `AgentRun` as a sans-I/O, steppable, serializable state
machine. A driver calls `next_step`, performs `CallModel` or `CallTools`, feeds
the result back, and stops at `Done`.
[Rig v0.41.0 AgentRun source](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-agent/src/agent/run/mod.rs#L1-L30).
The configured `Agent` executes through `AgentRunner`, whose driver combines
the same state machine with hooks, model I/O, tool execution, memory, and
concurrency.
[Rig v0.41.0 Agent module](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-agent/src/agent/mod.rs#L1-L44),
[Rig v0.41.0 AgentRunner](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-agent/src/agent/runner.rs#L187-L229).

Rig's hook system exposes typed model and tool events plus control responses
that can observe, rewrite, skip, retry, stop, or patch selected operations.
[Rig v0.41.0 AgentHook](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-agent/src/agent/hook.rs#L916-L993).
Use hooks for correlation, telemetry, and conformance assertions. Do not let a
hook append canonical Osfo state itself, because that would bypass the claim
epoch validation and commit boundary.

Rig's inline human-approval example waits inside a tool hook, while its durable
approval example serializes `AgentRun` at `CallTools` and later reloads it so
the pending calls are emitted again.
[Rig inline approval example](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/examples/agent_with_human_in_the_loop/src/main.rs#L1-L19),
[Rig durable approval example](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/examples/agent_with_durable_approval/src/main.rs#L201-L214).
The first shape is only process-local. The second supports an optional pinned
checkpoint, but Osfo must still own the durable approval and ToolCall state.

Rig publishes deterministic test utilities behind the `test-utils` feature,
including a scripted `MockCompletionModel` that consumes fixed model and tool
turns and records requests. `rig-agent` also exports reusable conformance
scenarios for tools, cancellation, invalid calls, structured output, and
streaming.
[Rig v0.41.0 test-utils feature](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/Cargo.toml#L262-L265),
[Rig v0.41.0 MockCompletionModel](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-core/src/test_utils/completion.rs#L48-L90),
[Rig v0.41.0 conformance scenarios](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-agent/src/test_utils/mod.rs#L1-L22).
These are sufficient for a real Rig adapter conformance lane without injecting
provider variance into the database load test.

### Rig constraints

Rig explicitly says that serialized `AgentRun` embeds the accumulated
conversation and has no cross-version stability guarantee. It must be resumed
with the same Rig version that suspended it.
[Rig v0.41.0 AgentRun serialization warning](https://github.com/0xPlaygrounds/rig/blob/v0.41.0/crates/rig-agent/src/agent/run/mod.rs#L21-L30).
The repository also warns that future releases may contain breaking changes.
[Rig repository warning](https://github.com/0xPlaygrounds/rig).

Therefore:

- pin the exact Rig crate version and record it in the AgentRun's semantic
  configuration references;
- treat serialized Rig `AgentRun` only as an optional `RuntimeCheckpointRef`;
- prove reconstruction from Osfo interaction records with the Rig checkpoint
  deleted;
- map Rig types into Osfo-owned ModelCall, ToolCall, and output types at one
  adapter boundary;
- keep the deterministic Osfo adapter, even after the Rig adapter works.

## Temporal integration assessment

### Capability fit

The native Rust SDK v0.5.0 is published, but it remains **Public Preview** and
states that its API will continue to evolve.
[Temporal Rust SDK v0.5.0 README](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk/README.md#L1-L10),
[Temporal Rust SDK repository](https://github.com/temporalio/sdk-rust).
This is the largest dependency risk in the proposed stack. It is also a strong
reason to test the integration now.

The current SDK provides the primitives required by the reference workflow:

- typed Workflows and Activities registered on a worker;
- durable timers and Activities from workflow context;
- Signal, Query, and Update handlers;
- deterministic `select`, `join`, and `join_all` helpers;
- client handles for Updates, cancellation, history fetch, and result waits;
- runtime nondeterminism detection that rejects ordinary Tokio timers, I/O, and
  spawned tasks inside workflow code.

These surfaces are documented in the
[Temporal Rust SDK v0.5.0 guide](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk/README.md#L12-L248),
[Temporal v0.5.0 saga example](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk/examples/saga/workflows.rs#L20-L61),
and [Temporal client workflow handle](https://docs.rs/temporalio-client/latest/temporalio_client/struct.WorkflowHandle.html).

Multiple approvals are an application pattern rather than a dedicated Temporal
primitive. Store approval gates in workflow state, accept typed Updates, and
wait on the corresponding condition. The v0.5.0 client options expose stable
`update_id` and Signal `request_id` fields, so the adapter can make retries
idempotent.
[Temporal v0.5.0 message-passing workflow](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk/examples/message_passing/workflows.rs#L1-L39),
[Temporal v0.5.0 interaction IDs](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/client/src/options_structs.rs#L359-L377).

Temporal's Rust repository runs integration tests against an ephemeral server
by default and can target an already-running external server. It also contains
a heavy-test target and supports OpenTelemetry collection for integration runs.
[Temporal Rust repository test instructions](https://github.com/temporalio/sdk-rust#building-and-testing).
This supports three useful test levels:

1. Rust unit tests for workflow state and Osfo adapters.
2. Short functional tests against the SDK's ephemeral or CLI development
   server.
3. The production-shaped load run against Temporal Cloud, whose metrics and
   storage are isolated from the Osfo Cloud SQL instance.

The Temporal CLI can run a local development service, and the Rust Core crate
also exposes feature-gated development and test-server configuration with
optional SQLite persistence.
[Temporal server local start](https://github.com/temporalio/temporal#download-and-start-temporal-server-locally),
[Temporal Rust ephemeral-server configuration](https://github.com/temporalio/sdk-rust/blob/v0.5.0/crates/sdk-core/src/ephemeral_server/mod.rs#L1-L60).
That can support SDK development, but it is not an Osfo confirmation lane.
Every integration, failure, and load run in this prototype targets Temporal
Cloud so the measured topology does not change between tests.

### Recommended Temporal deployment

Use one service profile:

| Profile | Purpose | Credentials |
| --- | --- | --- |
| Temporal Cloud | Functional, failure, replay, and production-shaped load lanes, measured separately from Cloud SQL | Temporal Cloud endpoint, namespace, and API key |

Temporal Cloud is the only orchestration service. Osfo-hosted Rust workers run
workflow and Activity code, while the managed service owns workflow history.
Cloud SQL remains the sole authority for AgentRun lifecycle and typed records.
This removes an unrelated Temporal operations problem from the take-home scale
question and keeps the database result interpretable.

Pin `temporalio-sdk`, `temporalio-client`, and the workflow type version. Record
Temporal Cloud as a managed service and capture its API and capacity facts for
each run. The prototype should fail closed if the pinned worker is not
available. This directly exercises Osfo's accepted compatibility-pending state
instead of silently running a newer workflow implementation.

### Failure injection

Use real failures at these boundaries:

- return typed retryable and non-retryable Activity failures;
- kill the Temporal worker during each Activity and approval wait;
- stop or partition the Temporal service after Osfo's durable start intent but
  before start confirmation;
- deliver each approval Update twice and in the wrong order;
- race cancellation with each timer, approval, Activity completion, and Osfo
  outcome delivery;
- drop the first Osfo outcome callback and replay it;
- restart the Rust worker on the same pinned version and verify workflow replay;
- run one deliberately nondeterministic workflow in a negative test and verify
  that it cannot produce an accepted Osfo outcome.

Keep production-shaped timers short enough for ordinary wall-clock load tests.
Use separate time-accelerated tests only if the pinned Rust SDK exposes a stable
test harness for them. The repository documents an ephemeral-server integration
path, but its public Rust documentation does not currently make a time-skipping
test environment a settled application API. Do not base the main prototype on
an undocumented test-only surface.

## Sandbox options

### OpenAI Agents SDK as the interface comparable

OpenAI's Agents SDK now has beta Sandbox Agents. The design separates the agent
definition from runtime transport: `SandboxRunConfig` can receive a sandbox
client, client-specific options, a live session, serialized session state, a
manifest, and a snapshot.
[OpenAI SandboxAgent overview](https://openai.github.io/openai-agents-python/ref/sandbox/),
[OpenAI sandbox concepts](https://openai.github.io/openai-agents-python/sandbox/guide/).
Its docs distinguish reconnecting to a specific backend through serialized
session state from seeding a fresh environment through a snapshot. They also
separate SDK-owned and developer-owned lifecycle.
[OpenAI sandbox concepts](https://openai.github.io/openai-agents-python/sandbox/guide/).

This is a good vocabulary and interface precedent for Osfo:

```text
SandboxSpec       immutable requested environment and limits
SandboxRef        optional provider connection or restoration reference
SandboxSnapshot   optional acceleration for a fresh environment
ArtifactRef       durable authoritative output, never a sandbox path
```

The SDK supplies local Unix and Docker clients plus hosted client extensions
for providers including E2B and Daytona.
[OpenAI sandbox clients](https://openai.github.io/openai-agents-python/sandbox/clients/).
Its Docker session separates persistence-only `stop`, backend teardown, and
client-level deletion.
[OpenAI Docker sandbox API](https://openai.github.io/openai-agents-python/ref/sandbox/sandboxes/docker/).

The feature is explicitly beta, and the implementation is Python and
JavaScript/TypeScript rather than Rust.
[OpenAI sandbox quickstart](https://openai.github.io/openai-agents-python/sandbox_agents/),
[OpenAI JavaScript sandbox clients](https://openai.github.io/openai-agents-js/guides/sandbox-agents/clients/).
It is therefore a comparable and source of test cases, not a direct dependency
for the Rust Osfo prototype.

The separate hosted `ShellTool` can provision or reconnect to an OpenAI-managed
container, while local `ComputerTool` and local shell execution require an
application-provided implementation.
[OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/).
This hosted tool is useful for a focused OpenAI-specific experiment, but making
it Osfo's general SandboxProvider would couple sandbox authority to one model
provider and bypass the Rig integration being evaluated.

### E2B

E2B sandboxes support pause and resume of both filesystem and memory state.
Snapshots capture filesystem and memory from a running sandbox and can seed
multiple new sandboxes, while pause and resume continues one sandbox identity.
[E2B persistence](https://e2b.dev/docs/sandbox/persistence),
[E2B snapshots](https://e2b.dev/docs/sandbox/snapshots).
E2B also exposes auto-pause and auto-resume lifecycle controls.
[E2B auto-resume](https://e2b.dev/docs/sandbox/auto-resume).

These semantics are the closest hosted match to testing both an optional
SandboxRef fast path and cold reconstruction after the reference disappears.
The pause or snapshot process drops live connections, so the Osfo adapter must
reconnect rather than treat a network connection as durable state.
[E2B snapshot connection behavior](https://e2b.dev/docs/sandbox/snapshots).

E2B's first-party repository directs callers to its JavaScript/TypeScript or
Python SDKs and requires `E2B_API_KEY` for the hosted service. It does not list
an official Rust SDK.
[E2B repository](https://github.com/e2b-dev/E2B),
[E2B quickstart](https://e2b.dev/docs/quickstart).
A Rust prototype would need a small HTTP adapter, a sidecar, or an intentionally
separate Python/TypeScript smoke client. Do not put a sidecar in the main load
path merely to claim hosted-sandbox coverage.

### Daytona

Daytona provides container and VM sandbox classes with different persistence
semantics. Container stop and start preserves filesystem but not memory; VM
pause and resume preserves filesystem and memory. Container archives move a
stopped filesystem to object storage. Cold container snapshots preserve
filesystem, while hot VM snapshots can include memory.
[Daytona sandbox lifecycle](https://www.daytona.io/docs/en/sandboxes/),
[Daytona persistence](https://www.daytona.io/docs/en/persistence/).
Daytona also provides persistent volumes that can outlive one sandbox.
[Daytona volumes](https://www.daytona.io/docs/en/volumes/).

Daytona publishes first-party TypeScript, Python, Ruby, Go, and Java clients,
plus an HTTP API. Its current client list does not include Rust.
[Daytona repository client list](https://github.com/daytonaio/daytona#client-libraries),
[Daytona API reference](https://www.daytona.io/docs/en/tools/api/).
A Rust integration can use the HTTP API directly, but that is more adapter work
than local Docker. Hosted use requires a Daytona account and API key.

Daytona is the better optional comparison when Osfo wants to exercise separate
container and VM persistence profiles. E2B is the smaller optional comparison
when hot pause and resume is the main question. Neither should be required to
start issue 13.

### Minimal local Docker provider

The default prototype SandboxProvider should use a local Docker Engine through
a small Osfo-owned adapter. It should implement only:

```text
create(SandboxSpec) -> SandboxRef
resume(SandboxRef) -> live session or Missing
exec(SandboxRef, command, deadline) -> typed execution result
export(path) -> immutable bytes + checksum
stop(SandboxRef)
delete(SandboxRef)
```

Pin the image by digest. Create containers with a non-root user, no privileged
mode, network disabled unless the fixture explicitly requires it, a read-only
root filesystem plus a writable workspace, dropped Linux capabilities,
`no-new-privileges`, and explicit CPU, memory, process, and command deadlines.
Docker exposes flags for read-only root filesystems, capability drops, PID
limits, networks, CPU, and memory on container creation.
[Docker container create](https://docs.docker.com/reference/cli/docker/container/create/).
Docker applies no resource constraints by default, so the prototype must set
them explicitly.
[Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

Prefer a rootless Docker daemon for the benchmark host. Docker documents that
rootless mode runs both daemon and containers without root privileges, while
also noting platform conditions for cgroup-backed limits.
[Docker rootless mode](https://docs.docker.com/engine/security/rootless/),
[Docker rootless resource-limit caveats](https://docs.docker.com/engine/security/rootless/tips/).

This provider is sufficient to test lifecycle, restoration, loss, execution,
artifact export, and concurrency behavior. It is not evidence that Docker is a
safe production sandbox for arbitrary hostile code. Security evaluation and a
hosted microVM comparison are separate decisions.

## Recommended implementation sequence

1. Define Osfo-owned `AgentRuntime`, `WorkflowProvider`, `SandboxProvider`,
   approval, and artifact interfaces with stable test identities.
2. Build the deterministic Agent Runtime and complete lifecycle ledger first.
3. Add the local Docker SandboxProvider and real artifact export.
4. Add the real Temporal Rust worker and eight-step workflow against the local
   development service.
5. Add the non-workflow approval-gated email ToolCall and Mailpit assertion.
6. Add the Rig adapter using `MockCompletionModel`, then one small live-provider
   smoke test.
7. Run the full local failure matrix until every invariant holds.
8. Move Osfo PostgreSQL to same-region Cloud SQL and use an external Temporal
   service isolated from that database.
9. Run steady, burst, timer-herd, retry-storm, worker-loss, and drain profiles.
10. Add one hosted-sandbox adapter smoke only if its credentials are available.

This order makes each service boundary independently diagnosable before the
combined load run.

## Measurement design

Report `p50`, `p90`, `p95`, `p99`, maximum, sample count, throughput, and error
rate for every latency family. The user asked for p90, p95, and p99; p50 is kept
as the baseline center and maximum exposes individual stalls that percentiles
can hide.

Do not combine intentional human or timer waiting with platform processing
latency. Report both elapsed journey time and service time:

```text
journey elapsed
  = service processing
  + configured workflow timers
  + approval response delay
  + retry backoff
  + queueing
```

### Required latency families

| Family | Start | End |
| --- | --- | --- |
| Admission | command received | AgentRun pending commit acknowledged |
| Claim | AgentRun eligible | fenced attempt committed |
| Reconstruction | claim commit | first legal runtime step available |
| ModelCall commit | intent transaction start | normalized outcome committed |
| ToolCall commit | intent transaction start | terminal semantic outcome committed |
| Approval delivery | decision received | waiting AgentRun or workflow eligible to run |
| Child admission | parent request received | child and join membership committed |
| ChildJoin settle | satisfying child commit starts | parent wake commit acknowledged |
| Workflow accept | ToolCall start request | durable start intent and waiting state committed |
| Temporal start reconciliation | Osfo start-intent commit | matching Temporal execution confirmed |
| Workflow task queue | Temporal schedules task | worker starts task |
| Activity task queue | Temporal schedules Activity | worker starts Activity |
| Workflow outcome delivery | Temporal terminal commit observed | Osfo idempotent outcome accepted |
| Sandbox create or resume | provider call starts | command-ready session returned |
| Sandbox command | exec accepted | exit or deadline result returned |
| Artifact export | export begins | bytes, checksum, and ArtifactRef metadata committed |
| Email tool | approved attempt begins | Mailpit accepts SMTP message and ToolCall outcome commits |
| Wake | durable condition settles | replacement AgentRunAttempt starts |
| End to end | initial command received | final AgentRun terminal commit |

Temporal and its client expose request-latency metrics, and the Rust repository
supports OpenTelemetry collection for integration runs.
[Temporal client metric constants](https://docs.rs/temporalio-client/latest/temporalio_client/struct.WorkflowHistory.html),
[Temporal Rust telemetry test setup](https://github.com/temporalio/sdk-rust#building-and-testing).
Correlate those measurements with Osfo spans by WorkflowInstance ID, but report
Temporal queue and execution latency separately from PostgreSQL transaction
latency.

### Workload stages

For every stage, record offered, accepted, completed, failed, and canceled rates
plus all correctness counters.

1. Warm-up without retained measurements.
2. Steady-state accepted Oz traffic envelope.
3. Sustained 2x offered burst under finite admission and capacity limits.
4. Mixed-duration child fan-out and both ChildJoin modes.
5. Awaited and detached workflow mix.
6. Approval batch and delayed approval release.
7. Timer herd, with many workflows waking in a narrow window.
8. Retry storm from injected Temporal Activity, artifact, sandbox, and SMTP
   failures.
9. Worker death, Temporal interruption, and sandbox deletion at every durable
   cut point.
10. Backlog drain and return to steady state.

Use fixed random seeds and persist the generated workload manifest. Give every
high-volume percentile family enough observations to make its p99 useful. For
rare failure paths, publish every individual sample and outcome rather than a
misleading percentile.

### Correctness is the first gate

No latency result is acceptable if any of these counters is nonzero:

- lost accepted AgentRuns;
- stale attempt commits;
- duplicate child, workflow, proactive AgentRun, or terminal semantic outcome;
- ChildJoin or workflow wake count other than exactly one;
- completed ToolCall rewritten after completion;
- terminal AgentRun reclaimed;
- authoritative artifact referenced only by sandbox path;
- logical recovery failure after deleting RuntimeCheckpointRef or SandboxRef;
- Temporal writing canonical AgentRun or ThreadEvent state directly.

Latency acceptance should be expressed against the observed capacity knee and
product SLOs, not invented before the first representative run. The report must
show p50, p90, p95, and p99 curves as offered load rises, then identify the
first load at which backlog age grows without recovering or a correctness gate
fails.

## Credentials and paid services

Do not put any secret value in source, generated fixtures, reports, traces, or
issue comments.

| Integration | Required material | Required for first credible run? |
| --- | --- | --- |
| Google Cloud | Project identity able to provision the test compute, Cloud SQL, network, and artifact bucket; database credentials or workload identity as chosen | Yes |
| Temporal local development service | None | Yes for local conformance |
| Temporal Cloud | Namespace endpoint and API key, or the account's chosen auth material | Recommended for external production-shaped lane, not required for local work |
| Rig mock model | None | Yes |
| Live Rig provider | Provider API key such as `OPENAI_API_KEY` | Optional focused smoke only |
| Local rootless Docker | Access to a test Docker daemon | Yes |
| Mailpit | None for isolated local test configuration | Yes |
| E2B | `E2B_API_KEY` and a hosted account with sufficient quota | Optional |
| Daytona | `DAYTONA_API_KEY`, service endpoint if non-default, and sufficient account quota | Optional |
| Live email provider | Explicitly scoped SMTP or API credential and an allowlisted test recipient | Optional and separately approved |

Use separate least-privilege test credentials and destroy managed resources
after raw evidence and configuration are exported.

## Final recommendation

Proceed with the larger prototype. The reference journey is large enough to
exercise the accepted seam, but still small enough to diagnose:

- two Child AgentRuns and one real ChildJoin;
- one eight-step awaited Temporal workflow;
- two workflow approval Updates, one timer, one retrying Activity, and
  cancellation races;
- one real local Docker sandbox lifecycle and artifact export;
- one separately approval-gated non-workflow email ToolCall into Mailpit;
- one deterministic Agent Runtime load lane;
- one Rig mock-model conformance lane and a small live-provider smoke;
- one optional E2B or Daytona hosted-sandbox smoke;
- real same-region Cloud SQL with p50, p90, p95, and p99 evidence.

The Temporal Rust SDK's Public Preview status and Rig's unstable serialized
run format are not reasons to avoid the prototype. They are the two most
important compatibility hypotheses for it to prove or reject.

# Osfo agent-platform comparables

Research date: 2026-08-07

Decision: keep Osfo's durable semantic core, make Oz the explicit application
composition, and keep every model provider behind the Osfo-owned
`ModelCallExecutor` seam.

## Question

Which mature systems provide the best current patterns for a reusable reliable
agent platform where:

- one product composes reusable modules and concrete Adapters;
- model providers perform one normalized turn without owning agent lifecycle;
- logical operations are durable before external execution;
- process loss reconstructs from recorded authority;
- retries, uncertainty, idempotency, and fencing have one explicit owner?

The refreshed sources were inspected at exact clean revisions:

| Comparable                                                                                             | Revision     | Score | Primary use                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------ | ----: | ------------------------------------------------------------------------- |
| [Executor](https://github.com/UsefulSoftwareCo/executor/tree/b029643641832ef5f9b0d4ff263d96e1a5b2739c) | `b029643641` | 33/35 | Deep plugin seams and Agent Application composition                       |
| [OpenCode](https://github.com/anomalyco/opencode/tree/284214c78d32a09fd9c729bdefc07be50f74eb40)        | `284214c78d` | 30/35 | Provider-neutral model turns, tool registry, and session orchestration    |
| [Restate](https://github.com/restatedev/restate/tree/f26577320b8be42b7a754d20932e881f06988876)         | `f26577320b` | 28/35 | Durable ownership, commit-before-effect, fencing, replay, and idempotency |

Scores cover domain fit, target-stack fit, production maturity, architecture
clarity, operations relevance, testing quality, and documentation and
maintainability signal, each out of five.

## Ranked conclusions

### 1. Executor: composition and deep adapter seams

Executor is the best structural comparable for Osfo and Oz. `ExecutorApp.make`
separates core-resolved provider slots from application-only extensions and
accepts plugins, providers, extensions, configuration, boot behavior, and
request scope in one composition facade. See
[`executor-app.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/api/src/server/executor-app.ts#L25-L38)
and its
[`ExecutorApp` options](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/api/src/server/executor-app.ts#L300-L327).

The same reusable facade produces different applications. Cloud supplies one
set of identity, storage, plugins, execution, and routes in
[`apps/cloud/src/app.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/apps/cloud/src/app.ts#L69-L136).
Self-host supplies another in
[`apps/host-selfhost/src/app.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/apps/host-selfhost/src/app.ts#L101-L154).

Its narrow `CodeExecutor` contract accepts code and one tool invoker, returns a
typed result, and does not own the enclosing product lifecycle. See
[`packages/kernel/core/src/types.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/kernel/core/src/types.ts#L48-L66).
The execution engine depends on provider contracts rather than host internals
in
[`packages/core/execution/src/engine.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/execution/src/engine.ts#L29-L37).

Executor also demonstrates host-owned scoping. Plugin storage receives an
already owner-bound facade, not a raw database, in
[`packages/core/sdk/src/plugin.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/sdk/src/plugin.ts#L63-L85).
Its blob and plugin-storage contracts remain small in
[`packages/core/sdk/src/blob.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/sdk/src/blob.ts#L23-L99).

The strongest Osfo adaptations are:

- add one readable Oz application composition facade;
- inject Model Adapters, tool and Action executors, repositories, identity,
  policy, and transport through named capability slots;
- give Adapters scoped services, never raw Drizzle clients or deployment
  credentials;
- keep SDK logic, server routes, React integration, and testing helpers in
  separate exports;
- use one typed Oz Adapter manifest for runtime, build tooling, and tests.

Executor's test strategy supports both contract and composed tests. A tiny fake
`CodeExecutor` exercises the real engine in
[`engine.test.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/execution/src/engine.test.ts#L19-L85),
while the self-host test application reuses the production composition facade
in
[`test-app.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/apps/host-selfhost/src/testing/test-app.ts#L180-L264).

Do not copy Executor's broad mega-plugin or in-memory pause state. Its engine
retains paused executions and settled outcomes in process maps in
[`engine.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/execution/src/engine.ts#L448-L465).
Osfo must reconstruct AgentRuns from PostgreSQL after worker or deployment
loss. Osfo should also keep capability-specific Adapter contracts rather than
copying the very broad `PluginSpec` surface in
[`plugin.ts`](https://github.com/UsefulSoftwareCo/executor/blob/b029643641832ef5f9b0d4ff263d96e1a5b2739c/packages/core/sdk/src/plugin.ts#L610-L766).

### 2. OpenCode: one normalized model turn

OpenCode provides the best current provider seam. `LLMClient` exposes prepare,
stream, and generate in
[`packages/llm/src/route/client.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/route/client.ts#L141-L154).
Request preparation normalizes and validates a provider-native body without
executing it in
[`client.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/route/client.ts#L341-L379).

The enclosing session runner performs exactly one `llm.stream(request)` call,
settles output and tools, reloads recorded history, and then explicitly decides
whether to continue. See
[`packages/core/src/session/runner/llm.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/core/src/session/runner/llm.ts#L173-L228)
and the continuation boundary in the
[same file](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/core/src/session/runner/llm.ts#L383-L416).

Internally, OpenCode decomposes a model route into:

- protocol lowering and event normalization in
  [`protocol.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/route/protocol.ts#L4-L21);
- endpoint construction in
  [`endpoint.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/route/endpoint.ts#L11-L35);
- transport preparation and framing in
  [`transport/index.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/route/transport/index.ts#L8-L31);
- route composition in
  [`client.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/route/client.ts#L29-L56).

OpenRouter reuses OpenAI Chat semantics while supplying only its endpoint and
options in
[`providers/openrouter.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/src/providers/openrouter.ts#L33-L75).
Osfo should keep this decomposition private behind the smaller
`ModelCallExecutor` interface until a second concrete Model Adapter earns public
reuse.

Provider compilation is independently testable. OpenCode asserts the selected
provider, route, endpoint, body, usage, reasoning, and cache options without a
network call in
[`openrouter.test.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/llm/test/provider/openrouter.test.ts#L8-L91).
Osfo should add the same prepare-time coverage plus streamed observation,
ToolCall, usage reconciliation, cancellation, typed error, redaction, and
recorded-fixture conformance.

OpenCode's tool registry materializes the exact effective tool set for a turn,
applies policy, captures registration identity, and rejects stale replaced
tools in
[`packages/core/src/tool/registry.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/core/src/tool/registry.ts#L23-L116).
This is a strong pattern for ordinary Osfo ToolCalls. It is insufficient for
Actions, which require durable intent, idempotency, uncertainty, and receipts.

OpenCode is weaker than Osfo's reliability target. Its execution coordinator is
process-local and retains fibers in a map in
[`run-coordinator.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/core/src/session/run-coordinator.ts#L5-L33).
The runner itself records missing durable ownership, fencing, retries, and crash
continuation in
[`runner/llm.ts`](https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/core/src/session/runner/llm.ts#L43-L69).
Adopt its provider and interactive-agent seams, not its process-local ownership.

### 3. Restate: durable ownership and replay

Restate is not an agent framework, but it is the strongest durability
comparable. Its partition processor reads committed log records, applies them
to one storage transaction, commits, and only then dispatches collected
Actions. See
[`crates/worker/src/partition/mod.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/mod.rs#L562-L713)
and
[`state_machine/mod.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/state_machine/mod.rs#L199-L242).
The explicit Action algebra includes invocation, outbox, timer, acknowledgement,
response, and abort facts in
[`actions.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/state_machine/actions.rs#L29-L119).

Execution is a replaceable actuator. `InvokerHandle` exposes invoke, notify,
retry, pause, and abort without storage implementation detail in
[`worker-api/src/invoker/handle.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker-api/src/invoker/handle.rs#L20-L72).
Invoker results normalize into stored effects in
[`effects.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker-api/src/invoker/effects.rs#L27-L106).

Every attempt is fenced. A fresh token is created per invocation in
[`leader_state.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/leadership/leader_state.rs#L826-L849).
Only effects with the current token are appended, while stale effects are
dropped in the
[same file](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/leadership/leader_state.rs#L660-L684).
Recovery scans durable invoked state and re-invokes with new fences in
[`leadership/mod.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/leadership/mod.rs#L695-L848).

Restate's idempotency is deterministic identity plus retained outcome, not a
temporary duplicate flag. Duplicate in-flight calls attach to the same result
and completed calls return their stored result in
[`state_machine/mod.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/state_machine/mod.rs#L996-L1097).
Its outbox is durable, while the in-memory notification channel is explicitly a
lossy hint in
[`shuffle.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/shuffle.rs#L60-L147).

The transferable Restate rules are:

- commit semantic intent before dispatching an effect;
- make one durable driver the sole lifecycle owner;
- check the current fence on every observation and terminal write;
- reconstruct from normalized records and pinned interpretation;
- require a durable progress barrier before retry;
- retain idempotent completed outcomes;
- keep durable outbox authority separate from lossy wake hints.

Do not copy Bifrost, partitioning, RocksDB, or the Restate service protocol into
Osfo. PostgreSQL, the transactional outbox, and fenced AgentRun leases can
implement the required v1 semantics with less machinery. Model calls also
cannot be replayed as if they were deterministic service commands. Restate's
Business Source License permits architectural study, not source reuse. See its
[`LICENSE`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/LICENSE#L1-L46).

## Standards guidance

The implementation should use Effect services as capability interfaces and
Layers as application-owned implementations. Public values and durable records
remain plain closed Schema data. Effects describe execution requirements, not
serialized authority. The inspected Effect source revision is
[`22f4897bba`](https://github.com/Effect-TS/effect/tree/22f4897bbae24783d4516f6bef353f1db4ec6d03).

TypeScript should infer types from Effect Schemas and concrete factories rather
than duplicate adjacent structural declarations. Unknown provider, network,
database, and JSON inputs are decoded once at boundaries. Errors remain typed
failures. Package dependencies use public exports only. These rules keep Adapter
contracts navigable and prevent provider types from leaking into durable Osfo
state.

The deep-module criterion is information hiding: a module should hide
substantial policy, lifecycle, or protocol complexity behind a small stable
interface. The relevant seams are Agent Runtime proposal, AgentRun lifecycle,
ModelCall execution, ToolCall execution, Action external effects, persistence,
transport, and Agent Application composition. File count and domain nouns do
not by themselves earn modules.

## Target architecture

```text
Oz Agent Application
  selects identity, policy, Execution Profiles, tools, workflows, UI
  selects OpenRouter or another Model Adapter
  composes Osfo modules through Effect Layers

Osfo Native Thread Transport
  admits one durable command
  returns one Acceptance Receipt
  publishes canonical ThreadEvents only after commit

Osfo AgentRun driver
  reconstructs recorded state
  asks Agent Runtime for one proposal
  commits intent
  invokes one scoped executor
  commits normalized result under the current fence

Agent Runtime
  pure proposal from recorded state
  no provider, database, tool, transport, or scheduling authority

Model Adapter
  one provider turn through ModelCallExecutor
  protocol lowering and normalization only

PostgreSQL repositories
  canonical Thread and AgentRun authority
  transactions, idempotency, outbox, claims, leases, and fences
```

## Concrete recommendations

1. Keep `AgentRuntime.decide` authority-free and grow its typed proposal algebra
   only through implemented vertical slices.
2. Keep `ModelCallExecutor` as one normalized provider turn. Move OpenRouter
   protocol concerns behind it and do not let it own AgentRun continuation.
3. Add one explicit Oz composition manifest so runtime, API, tools, UI, and
   tests consume the same selected Adapter set.
4. Give Adapters scoped capabilities. Never pass raw database clients,
   application credentials, or mutable product configuration.
5. Add prepare-time and live conformance suites for every Model Adapter.
6. Snapshot the exact effective tool registry for each ModelCall. Reject stale
   tool definitions fail-closed.
7. Keep ordinary ToolCalls separate from externally effectful Actions.
8. Make every lifecycle transition transaction-oriented and fenced. Commit
   before effects and normalize before the next Runtime decision.
9. Separate safe transport reconnects from durable logical attempt retries.
10. Reconstruct after process loss from recorded interactions and a pinned
    Execution Profile. Never continue from an in-memory agent object.
11. Keep Oz product routes, prompts, onboarding, and UI outside Osfo packages.
12. Test core seams with deterministic implementations and test Oz through the
    same production composition used at runtime.

## Caveats

- Executor demonstrates excellent composition depth, but some execution pause
  state remains process-local and its plugin surface is broader than Osfo needs.
- OpenCode demonstrates excellent model and tool ergonomics, but its clustered
  durable execution ownership remains incomplete.
- Restate demonstrates strong distributed durability, but its deterministic
  service replay is not a license to replay nondeterministic model calls or
  uncertain external Actions.
- None of the comparables supplies Osfo's exact Thread, AgentRun, ActionReceipt,
  multi-device cursor, production-workload, or evidence contract. Those remain
  Osfo-owned differentiators.

# Cloudflare as an Osfo and Oz foundation

Research date: 2026-08-08  
Source policy: official Cloudflare and PlanetScale documentation, official
Cloudflare repositories and changelogs, and Osfo's accepted local contracts  
Access date for every external source: 2026-08-08

## Decision

**No-go on making Cloudflare the default Osfo/Oz foundation before testing a
managed agent platform such as LangSmith Deployment. Go on one bounded,
Cloudflare-native Oz prototype as the second comparison.**

This is not a rejection of Cloudflare. It is a layer decision:

```text
LangSmith Deployment
  delegates an Agent Server, thread/run persistence, queue workers,
  deployment, tracing, and evaluation

Cloudflare
  delegates stateful application compute, local durable storage, live
  connections, queues, workflows, model routing, and sandboxes

Oz on Cloudflare
  still defines and implements the agent harness or embeds one
```

Cloudflare is the strongest full-stack application-runtime candidate in this
review. It can collapse ingress, per-thread serialization, WebSocket fanout,
stream resumption, scheduled tasks, durable workflows, model routing, and code
sandboxes into one operated platform. It does **not** provide LangSmith's
managed Agent Server and trace/evaluation product as a single adopted unit.
[LangSmith Agent Server](https://docs.langchain.com/langsmith/agent-server)
and [LangSmith Cloud](https://docs.langchain.com/langsmith/cloud)

The largest simplification is available only if Oz accepts a Cloudflare Agent
or `AIChatAgent` as the canonical conversational authority. If PlanetScale
remains canonical for the same thread while a Durable Object also stores agent
state, the design retains dual-write, outbox, deduplication, replay, and
reconciliation work. That hybrid is a no-go as the target architecture because
it removes too little of the current complexity.

Flue-on-Cloudflare is also not the first Cloudflare experiment. Flue and the
Cloudflare Agents SDK both want to own conversation and runtime state. The
Cloudflare prototype should first use Cloudflare's native `AIChatAgent` or its
current Think harness so the experiment measures the maximum platform
simplification. Flue remains viable only as a replaceable reasoning loop that
executes one bounded turn inside the Cloudflare-owned lifecycle and persists
no competing canonical history. [Flue runtime at the inspected revision](https://github.com/withastro/flue/tree/bf86b8726f5f9b0d4ff263d96e1a5b2739c/packages/runtime)

## The key category distinction

Cloudflare explicitly describes its Agents SDK as an execution shell, not the
agent's cognition layer. In Cloudflare's own OpenAI integration, the OpenAI
Agents SDK supplies reasoning and tool orchestration while Cloudflare supplies
identity, state, concurrency control, and execution. Cloudflare says the shell
can integrate with other agent runtimes, subject to their actual Workers
runtime compatibility. [Cloudflare and OpenAI Agents SDK](https://blog.cloudflare.com/building-agents-with-openai-and-cloudflares-agents-sdk/)

The useful decomposition is:

```text
Oz product
  identity, permissions, UI, tools, approval policy, product outcomes
      |
agent harness
  model/tool loop, context construction, handoffs, guardrails
      |
Cloudflare Agent
  durable identity, local state, event serialization, client connections
      |
Cloudflare platform
  Workers, Durable Objects, Workflows, Queues, AI Gateway, Sandboxes
```

This means Cloudflare can replace much of the current deployment topology. It
does not answer which harness Oz should adopt. LangChain-managed is a broader
delegation because Agent Server and LangSmith also supply first-class thread,
run, deployment, tracing, and evaluation surfaces.

## What Cloudflare can own

| Capability                                 | Cloudflare service                              | What Cloudflare operates                                                    | What Oz still owns                                                      |
| ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Globally routed HTTP compute               | Workers                                         | isolate scheduling, deployment, routing, scaling, runtime                   | routes, authentication, authorization, overload policy                  |
| Per-thread state and serialization         | Durable Objects and Agents                      | globally addressable object, single active instance, private SQLite storage | object key, schema, invariants, admission idempotency, retention        |
| Live browser channel                       | Agent WebSockets and Durable Object hibernation | socket termination, routing, hibernation, wakeup                            | authentication, cursor protocol, bounded fanout policy, product events  |
| Chat transcript and live response recovery | `AIChatAgent`                                   | SQLite message persistence, buffered chunks, reconnect resumption           | product transcript meaning, recovery policy, external-effect safety     |
| Delayed and recurring work                 | Agent schedules and Durable Object alarms       | wakeup and alarm retry                                                      | callback idempotency, missed occurrence policy, terminal failure record |
| Multi-step durable work                    | Workflows                                       | step state, retry, sleep, external waits, instance operations               | workflow logic, side-effect idempotency, semantic outcome promotion     |
| Cross-object dispatch                      | Queues                                          | durable message buffer, retries, autoscaled consumers, dead-letter queues   | deduplication, ordering authority, business outcome commit              |
| Model inference                            | Workers AI                                      | hosted model serving                                                        | model quality, prompt, portability, evaluation                          |
| Multi-provider model gateway               | AI Gateway                                      | proxying, keys, logs, analytics, caching, rate limits, fallbacks            | semantic request normalization, retry policy, model result meaning      |
| Untrusted code execution                   | Sandbox SDK and Containers                      | Linux isolation, container lifecycle, resource allocation                   | tool policy, credentials, artifact durability, replay and receipts      |
| Regional relational control plane          | PlanetScale via Hyperdrive                      | database HA, backup, failover, pooling, regional Postgres                   | schema, queries, capacity choice, application transactions              |

The platform does not own Oz's Principal, authorization rules, canonical
product events, Action uncertainty, billing, abuse controls, data export, or
support contract. Those remain product work regardless of the host.

## Guarantees that matter

| Primitive                   | Durable state                                                         | Delivery or execution semantics                                                                | Ordering                                         | Consequence for Oz                                                                                           |
| --------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Durable Object SQLite       | Transactional and strongly consistent within one object               | Local transactions are serializable; output gates hold outgoing messages until writes settle   | One object is a global coordination point        | Strong candidate for one Thread's sole write authority                                                       |
| Durable Object alarm        | Alarm stored with the object                                          | Guaranteed at-least-once handler execution, with bounded automatic retries after thrown errors | Only one alarm handler runs at a time per object | Scheduled callbacks must be idempotent and persist terminal failure policy                                   |
| Agent local queue           | Rows in the Agent's SQLite database                                   | Sequential callbacks with automatic retry; exhausted work has no built-in DLQ                  | Sequential within the Agent                      | Useful for short per-thread work, but head-of-line blocking and failure tracking remain application concerns |
| Cloudflare Queue            | Managed queue storage                                                 | At-least-once; duplicate delivery is possible                                                  | Best effort, not publication order authority     | Never use as canonical ThreadEvent ordering; deduplicate every consumer effect                               |
| Workflow `step.do`          | Persisted step result and instance state                              | Successful prior steps are resumed, failed step callbacks may retry                            | Program order between declared steps             | External side effects can repeat if effect succeeds before result persistence; use idempotency keys          |
| Hibernating WebSocket       | Connection stays at Cloudflare; small attachment survives hibernation | Healthy sockets remain connected while object memory is discarded                              | Frame order on the live socket only              | Persist product events and cursors separately; socket state is not conversation history                      |
| `AIChatAgent` stream buffer | Generated chunks and messages in Agent SQLite                         | Client reconnect can replay buffered chunks; optional recovery handles Agent eviction          | SDK message/stream protocol                      | Strong convenience, not an exactly-once AgentRun contract                                                    |
| PlanetScale transaction     | Standard PostgreSQL ACID transaction                                  | Atomic only inside PlanetScale                                                                 | Database-defined                                 | Cannot atomically include Durable Object, Queue, Workflow, or WebSocket writes                               |

Sources: [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[input and output gates](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[Agent queues](https://developers.cloudflare.com/agents/runtime/execution/queue-tasks/),
[Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[Queue JavaScript API and ordering](https://developers.cloudflare.com/queues/configuration/javascript-apis/),
[Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/),
and [PlanetScale Postgres compatibility](https://planetscale.com/docs/postgres/postgres-compatibility).

There is no cross-service exactly-once boundary. A local Durable Object
transaction can commit a UserMessage, ordered ThreadEvent, run intent, and
outbox row together if all are stored in that one object's SQLite database.
Starting a Workflow, publishing to a Queue, writing PlanetScale, and calling a
model are later effects. Stable IDs, idempotent targets, and reconciliation are
still required, although they can be contained inside one Thread Agent instead
of spread across a fleet-wide PostgreSQL topology.

## Durable Objects and the Agents SDK

An Agent is a Durable Object. Each named Agent maps to one globally routable
object, has private embedded SQLite, and handles RPC, HTTP, WebSocket, schedule,
and state operations. Cloudflare documents tens of millions of concurrently
addressable Agents, with one Agent-specific state limit of 1 GB and a default
30 seconds of CPU refreshed per HTTP request, WebSocket message, or scheduled
event. Waiting on I/O does not consume that CPU budget. [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
and [Agents limits](https://developers.cloudflare.com/agents/platform/limits/)

The scale model is horizontal across Agent identities. A single Durable Object
is inherently single-threaded and has a soft throughput limit around 1,000
requests per second, with practical throughput depending on work and storage.
Cloudflare warns against using one global singleton. One object per Oz Thread
or Principal fits the platform; one object for all Oz traffic does not.
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

SQLite-backed Durable Objects are GA, support SQL and 30-day point-in-time
recovery, and allow up to 10 GB for a general object on the paid plan. The
narrower Agents SDK limit is the relevant limit when using Agent state.
[SQLite GA announcement](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)
and [PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Important lifecycle facts:

- In-memory fields, promises, timers, and caches disappear on hibernation or
  eviction. There is no reliable shutdown hook.
- Hibernatable inbound WebSockets can remain connected while the object leaves
  memory. Connection attachments survive only while the socket remains healthy
  and are limited to 16,384 bytes.
- An object is normally placed near its first request and currently does not
  dynamically relocate. Location hints are best effort. Cross-region clients
  still route to that object's fixed location.
- A code update or resource failure can reset the live object. Successfully
  persisted storage remains, but in-flight work must recover from records.

Sources: [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
[WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[data location](https://developers.cloudflare.com/durable-objects/reference/data-location/),
and [error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).

### Thread persistence and streaming

`AIChatAgent` is the most important simplification for the current Oz
prototype. Current official documentation says it automatically stores
messages in SQLite, buffers live stream chunks, keeps server generation going
across an ordinary browser disconnect, and replays buffered chunks when the
client reconnects. This is materially more than raw WebSocket or SSE framing.
[Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)

The recovery boundary must be understood precisely:

- Reconnect resumption handles client connection loss while the server turn is
  still alive.
- Durable Object eviction severs the model stream and loses in-memory stream
  execution.
- `chatRecovery` records a recoverable fiber, reconstructs buffered partial
  output, and can continue the partial response or retry an unanswered user
  turn after reactivation.
- `chatRecovery` defaults to `false` on `AIChatAgent`; the current Think harness
  defaults it to `true`.
- Continuation is not exact replay. A provider may generate different text, and
  external tools still require idempotency and settled-result repair.

This is a useful product contract if Oz accepts it. It is not equivalent to
the current Osfo definition of an AgentRun with pinned interpretation, typed
interaction history, fences, and normalized terminal outcomes.
[Osfo AgentRun definition](../../CONTEXT.md#agentrun)

Cloudflare Agents are WebSocket-first. Workers can stream HTTP and implement
SSE, but SSE does not add durable replay or cursor interpretation. If Oz keeps
its current `ThreadCursor` and immutable `ThreadEvent` contract, it must still
store those events and implement the replay-to-live cut. If Oz adopts
`AIChatAgent`'s message and resumable-stream protocol, much of that code can be
deleted. The decision is semantic, not transport-level.

## Workflows

Cloudflare Workflows is GA and is appropriate for independently durable,
multi-step work. It persists `step.do` results, automatically retries failed
steps, sleeps without active compute, waits for external events for up to 365
days, and exposes instance status and lifecycle operations. Waiting instances
do not consume active concurrency slots. [Workflows GA](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/),
[Workflows overview](https://developers.cloudflare.com/workflows/),
and [events](https://developers.cloudflare.com/workflows/build/events-and-parameters/)

Workflows does not make arbitrary side effects exactly once. Cloudflare tells
developers to make API and binding calls idempotent because a step may run
multiple times. Code with side effects outside a step may also repeat when the
engine restarts. [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)

For Oz, map Workflows to independently durable product work, not automatically
to every model turn:

- Use an Agent method or recoverable chat fiber for an ordinary interactive
  model response.
- Use an Agent schedule for per-thread delayed or recurring work.
- Use a Workflow for long multi-step tools, human approvals, imports, exports,
  artifact pipelines, and other work that can outlive one Agent activation.
- Give every Workflow a stable Oz ID and promote progress or completion into
  the Thread Agent idempotently.

Cloudflare supplies `AgentWorkflow` for bidirectional progress and completion
callbacks, which reduces integration code but also couples the workflow to the
Agent SDK. [Agents and Workflows](https://developers.cloudflare.com/agents/concepts/workflows/)

## Queues

Cloudflare Queues is GA, supports Workers push consumers and external HTTP pull
consumers, autoscaled concurrency, explicit acknowledgement and retry, delay,
retention, and dead-letter queues. It is suitable for projections, indexing,
email, analytics, bulk work, and other cross-Agent dispatch.
[Queues GA](https://developers.cloudflare.com/queues/platform/changelog/)
and [pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)

It is not a Thread ordering primitive:

- delivery is at least once;
- duplicates are possible;
- ordering is best effort;
- a failed batch is redelivered unless individual messages were acknowledged;
- messages expire at the configured retention limit;
- failed messages are deleted after retry exhaustion unless a DLQ exists.

Use a stable event ID as a unique key in the consumer's authoritative store.
Do not derive ThreadPosition from delivery order. [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[batch retry behavior](https://developers.cloudflare.com/queues/configuration/batching-retries/),
and [Queue limits](https://developers.cloudflare.com/queues/platform/limits/)

## Workers AI and AI Gateway

Workers AI and AI Gateway are both GA. Workers AI hosts Cloudflare's model
catalog. AI Gateway can front Workers AI and third-party providers such as
OpenAI and Anthropic, and it provides analytics, request/response logging,
caching, rate limits, retries, fallbacks, spend controls, key management, and
custom-provider routing. [Workers AI limits and GA status](https://developers.cloudflare.com/workers-ai/platform/limits/),
[AI Gateway overview](https://developers.cloudflare.com/ai-gateway/), and
[custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)

AI Gateway is a valuable replacement for provider-specific transport and
operational telemetry. It is not a provider-neutral agent semantics layer:

- the compatible API normalizes an OpenAI-style request shape, not differences
  in reasoning events, tool protocols, token accounting, or failure meaning;
- automatic retries or fallbacks can create multiple billed generations;
- caching is exact-request caching and is volatile;
- model logs can contain prompts and responses and must follow Oz's data and
  retention policy;
- gateway logs and analytics do not represent the complete agent, tool,
  approval, or product-outcome trace.

Keep one narrow Oz model call interface even if AI Gateway is the only network
path. Use gateway features for routing and operations, not as canonical
AgentRun evidence. [AI Gateway features](https://developers.cloudflare.com/ai-gateway/features/),
[caching](https://developers.cloudflare.com/ai-gateway/features/caching/), and
[logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)

## Sandboxes and Containers

Cloudflare Containers and Sandboxes were declared GA on 2026-04-13. Sandbox
provides isolated Linux containers for commands, files, processes, interpreters,
terminals, and preview services. [GA announcement](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)
and [Sandbox overview](https://developers.cloudflare.com/sandbox/)

The container filesystem is ephemeral. A default Sandbox stops after ten
minutes of inactivity, and the next activation starts with a fresh filesystem.
Durable data requires a backup/restore operation or an S3-compatible mounted
store such as R2, S3, or GCS. [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)
and [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)

Use Sandbox only behind a typed Oz tool or Action boundary. A sandbox ID is not
an AgentRun, and its filesystem is not canonical conversation or artifact
authority. Oz still records intent before execution, constrains network and
credentials, exports durable artifacts, and normalizes cancellation, timeout,
and uncertain outcomes.

Production maturity is nuanced. The platform is GA, but the official Sandbox
repository still identifies the SDK as beta and the 2026 changelog includes
transport deprecations. Current package APIs should therefore be isolated
behind an Oz-owned interface. [Sandbox repository](https://github.com/cloudflare/sandbox-sdk)
and [Sandbox transport deprecations](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/)

## PlanetScale compatibility

PlanetScale Postgres and Cloudflare Workers are officially integrated through
Hyperdrive. Hyperdrive supports standard Postgres drivers, pools connections
near the database, and can cache eligible reads near Workers. PlanetScale
documents the integration directly. [Cloudflare Hyperdrive and PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/)
and [PlanetScale Cloudflare tutorial](https://planetscale.com/docs/postgres/tutorials/planetscale-postgres-cloudflare-workers)

PlanetScale is the database, not the application host. A production PlanetScale
Postgres cluster has one primary and two replicas across availability zones in
one region. PlanetScale operates failover, backups, storage, and database
infrastructure, but CPU and RAM sizing is manual and Postgres writes still
concentrate on one primary. [PlanetScale architecture](https://planetscale.com/docs/postgres/postgres-architecture)
and [operational characteristics](https://planetscale.com/docs/postgres/postgres-compatibility/)

Hyperdrive does not invalidate cached reads after application writes. Critical
authorization, admission, session, and canonical replay reads must use a
cache-disabled Hyperdrive configuration or an uncached connection.
[PlanetScale on Hyperdrive](https://developers.cloudflare.com/hyperdrive/planetscale/)

There are two coherent storage choices:

### Cloudflare-native authority

```text
Browser
  -> Worker authentication and routing
  -> Thread Agent Durable Object
       SQLite: transcript, ordered product events, admission keys, local outbox
       WebSockets: live updates and stream resumption
       harness: one bounded model/tool turn
       Workflow: independent long-running work
       Sandbox: isolated code tool
       AI Gateway: model traffic
       Queue: at-least-once projections

PlanetScale
  -> users, organizations, billing, searchable control-plane metadata
```

This is the recommended Cloudflare prototype. One Thread Agent is the sole
conversation authority. PlanetScale must not contain a second writable copy of
the thread lifecycle. Cross-thread search and analytics can consume idempotent
projections from a Queue. Export must be designed because Durable Object data
is private to each object and tightly coupled to Cloudflare's storage model.

### PlanetScale authority with Cloudflare transport

```text
Worker or Agent
  -> PlanetScale transaction: message, ThreadEvent, run, outbox
  -> relay or reconciler
  -> Queue or Workflow
  -> live connection coordinator
```

This remains correct, but it preserves nearly all hard distributed-systems
work in the current design. Durable Objects cannot participate in a PlanetScale
transaction. A PlanetScale write followed by a Queue, Workflow, or WebSocket
effect still needs an outbox and idempotent relay. This option can improve
operations and global transport, but it does not satisfy the goal of stopping
the platform build.

## Observability

Cloudflare supplies several useful but separate layers:

- Agents emit structured diagnostics events for RPC, state, message, schedule,
  tool, workflow, and MCP operations. A Tail Worker can export them.
- Workers Logs capture invocation logs, application logs, errors, and
  exceptions.
- Workers automatic traces cover requests, subrequests, bindings, and Durable
  Object operations.
- Workflows expose instance status, step inspection, and aggregate metrics.
- AI Gateway records model request, response, token, cost, duration, and error
  data.

Sources: [Agents observability](https://developers.cloudflare.com/agents/runtime/operations/observability/),
[Workers observability](https://developers.cloudflare.com/workers/observability/),
[Workers traces](https://developers.cloudflare.com/workers/observability/traces/),
[Workflow metrics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/),
and [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).

This is not yet a LangSmith-equivalent semantic trace and evaluation product.
Oz must correlate Agent, model, tool, Action, Workflow, and product outcome IDs,
and it still needs datasets, evaluators, feedback, regression comparisons, and
release gates. Workers automatic tracing and OpenTelemetry export were still
documented as beta, and metrics export through the OpenTelemetry destination
was not supported. [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)

## Vendor lock-in

Lock-in varies by layer:

| Layer                        | Exit cost      | Reason                                                                                                          |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| AI Gateway                   | Low to medium  | URL and headers can be replaced; gateway policy and logs need migration                                         |
| Cloudflare Queues            | Medium         | HTTP producers and pull consumers are portable, but delivery operations and configuration differ                |
| Workers AI                   | Medium to high | Cloudflare model IDs, billing, and inference API                                                                |
| Sandbox and Containers       | Medium         | container images are portable; Sandbox control API, tunnels, backups, and routing are not                       |
| Workflows                    | High           | code is written around Cloudflare step, event, instance, and persistence semantics                              |
| Durable Objects              | High           | identity, placement, single-object concurrency, bindings, alarms, and per-object SQLite define the architecture |
| Agents SDK and `AIChatAgent` | High           | transcript schema, WebSocket protocol, recovery fibers, schedules, and state live inside Durable Objects        |
| PlanetScale Postgres         | Low to medium  | standard Postgres is portable; PlanetScale operations, branches, pooling, and Hyperdrive are provider-specific  |

The Cloudflare Agents SDK is MIT licensed, but open source does not make its
Durable Object runtime and hosted storage portable. The safest seam is the
agent harness: keep model/tool decision logic behind an Oz-owned interface and
keep durable records plain and versioned even when stored in Agent SQLite.

## Production maturity as of 2026-08-08

| Capability                                        | Status supported by first-party source                                    | Assessment                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| SQLite Durable Objects                            | GA since 2025-04-07                                                       | Production foundation, with object-level scaling and placement constraints |
| Queues                                            | GA since 2024-09-26                                                       | Production buffer, at-least-once and best-effort order                     |
| Workflows JavaScript                              | GA since 2025-04-07                                                       | Production durable execution, application idempotency still required       |
| Workers AI                                        | GA                                                                        | Production inference service, model-specific limits apply                  |
| AI Gateway                                        | GA                                                                        | Production model proxy and telemetry layer                                 |
| Containers and Sandboxes platform                 | GA since 2026-04-13                                                       | Platform GA, SDK churn should be isolated                                  |
| Agents SDK                                        | No GA declaration found in reviewed sources; current changelog is v0.20.0 | Treat as pre-1.0 framework risk on top of GA Durable Objects               |
| `@cloudflare/ai-chat`                             | First stable release was v0.1.0 in 2026-02                                | Useful but young, recovery behavior needs destructive testing              |
| Workers automatic traces and OpenTelemetry export | Documented beta                                                           | Do not make it the only production evidence path yet                       |

Sources: [Durable Objects GA](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/),
[Queues changelog](https://developers.cloudflare.com/queues/platform/changelog/),
[Workflows GA](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/),
[Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/),
[AI Gateway GA](https://blog.cloudflare.com/ai-gateway-is-generally-available/),
[Containers and Sandboxes GA](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/),
and [Agents changelog](https://developers.cloudflare.com/changelog/product/agents/).

The underlying platform is mature enough for a production-shaped prototype.
The high-level agent framework is young enough that Oz should not adopt it
without pinning versions, contract tests, migration tests, and eviction/deploy
recovery tests.

## Direct comparison

| Candidate                                         | Best reason to choose it                                                                                                        | Main retained work                                                                        | Decision now                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| LangSmith managed Agent Server                    | Fastest route to stop building a generic agent platform and learn Oz product behavior, with integrated tracing and evaluation   | product semantics, auth, tools, approval safety, provider and commercial-platform choices | **Test first**                                          |
| Cloudflare-native Oz using `AIChatAgent` or Think | Deeply integrated global stateful runtime that can collapse transport, session state, workflow, gateway, and sandbox operations | harness choice, product lifecycle, semantic tracing/evaluation, Cloudflare data model     | **Test second, go for bounded prototype**               |
| Flue reasoning loop inside a Cloudflare Agent     | Keeps a more independent harness while Cloudflare hosts identity and state                                                      | adapter between two lifecycle models, Workers compatibility, duplicated persistence risk  | **No-go until Cloudflare-native baseline exists**       |
| PlanetScale-authoritative Oz on Cloudflare        | Standard central Postgres, managed DB operations, Cloudflare transport                                                          | outbox, relay, dedupe, run claims, replay, reconciliation                                 | **No-go for simplification goal**                       |
| Existing Osfo GCP topology                        | Maximum semantic and infrastructure portability                                                                                 | almost every generic platform layer                                                       | **Keep as control, freeze expansion during comparison** |

### Why LangChain-managed goes first

The user's question is whether Osfo has been rebuilding an agent platform. A
managed Agent Server is the cleanest experiment because it directly replaces
the generic assistant, thread, run, persistence, worker, deployment, tracing,
and evaluation surfaces. Cloudflare replaces lower platform layers and then
asks Oz to assemble an agent application on them. Cloudflare may ultimately be
the better long-term substrate, but it is not the fastest falsification of the
current platform-building thesis.

### Why Cloudflare still deserves a prototype

Cloudflare offers a smaller operational surface and a compelling actor-shaped
model for Oz's Single-Thread Agent. If Oz can accept one Agent as the durable
conversation and simplify the product contract to the SDK's transcript,
recovery, schedule, and Workflow concepts, the resulting system can be much
smaller than the current Osfo topology. That is a real alternative, not just a
hosting swap.

## Required prototype

Build one disposable Cloudflare-native Oz slice. Do not port the current
packages first. The slice should contain:

1. One authenticated Principal with one named Thread Agent.
2. `AIChatAgent` or Think with one chosen model through AI Gateway.
3. One read-only tool and one idempotent externally effectful tool requiring
   approval.
4. SQLite-backed transcript plus a minimal append-only product event table.
5. WebSocket reconnect and resumable streaming in two browser tabs.
6. One delayed Agent schedule and one awaited Workflow.
7. One Sandbox-backed code tool that exports an artifact to durable storage.
8. Structured Agent diagnostics plus AI Gateway logs correlated by stable IDs.
9. A read-only PlanetScale control-plane record, with Hyperdrive caching
   disabled on the authorization path.

Run these destructive journeys:

- disconnect and reconnect the browser during a model stream;
- deploy new code during a model stream, with `chatRecovery` both off and on;
- deliver the same user command twice;
- make a tool side effect succeed and then lose its response;
- retry a Workflow step after its remote side effect succeeds;
- redeliver the same Queue message;
- hibernate and evict the Agent between every durable boundary;
- fail PlanetScale and the model provider independently;
- fill or approach the per-Agent storage budget with retained history;
- export the complete Thread without reading private implementation tables
  from outside the Agent.

The prototype passes only if it demonstrates:

- one declared canonical authority for the thread;
- no duplicate external Action after every retry journey;
- deterministic client reconstruction from a stable cursor or an explicit
  decision to adopt Cloudflare's weaker transcript contract;
- recovery that never silently turns an interrupted attempt into a completed
  product outcome;
- bounded queues and visible terminal failures;
- an export path and deletion path;
- materially less application and operations code than the managed LangChain
  slice and the current GCP control.

## Final recommendation

1. Test LangSmith managed first because it delegates the highest layer and most
   directly answers whether Osfo has built too much.
2. Test a Cloudflare-native Oz second, using Cloudflare's own chat/harness path,
   not Flue and not a PlanetScale-authoritative port of the current design.
3. If Cloudflare wins, make the Thread Agent the sole conversational authority
   and use PlanetScale only for global control-plane and searchable projection
   data.
4. If Oz cannot accept Cloudflare's Agent transcript, recovery, storage, and
   lock-in, do not replatform halfway. Keep the current portable authority or
   adopt managed Agent Server semantics explicitly.
5. Revisit Flue only after the native Cloudflare baseline. It should compete as
   a cognition module, never as a second lifecycle authority.

The core decision is not GCP versus Cloudflare or Cloud SQL versus PlanetScale.
It is whether Oz wants to own a portable agent platform, adopt a managed Agent
Server, or become a Cloudflare-native Agent Application. Mixing those models
preserves their costs while losing their clarity.

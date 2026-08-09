# Existing agent harness foundations for Oz

Research date and source access date: 2026-08-08

Scope: current official documentation and official repositories for LangChain
Deep Agents and LangGraph, OpenAI Agents SDK, OpenCode SDK, and OpenRouter SDK.
This report distinguishes an agent harness from a model gateway, a persistence
library from durable execution, and hosted inference scale from a deployable
multi-tenant agent runtime.

## Executive conclusion

Oz should not adopt any of these as one indivisible replacement for the whole
product. The strongest initial composition is:

```text
Osfo product shell
  identity, tenancy, channels, policy, billing, product events, UI
                 |
                 v
Oz agent definition and product adapter
                 |
                 v
Deep Agents JS/TS harness
                 |
                 v
LangGraph execution and checkpoints
                 |
                 +--> Managed Deep Agents, for the managed Deep Agents path
                 |
                 `--> Agent Server / LangSmith Deployment, for custom graphs
                 |
                 +--> sandbox provider
                 `--> OpenRouter model gateway, optionally
```

Deep Agents plus LangGraph is the only candidate in this set that can replace
both the hand-written model/tool loop and a material part of the durable runtime.
Its TypeScript package returns a compiled LangGraph, so this choice does not
require moving Oz to Python. LangSmith adds the most complete managed tracing,
evaluation, task queue, persistence, and scaling story, but it is a commercial
platform dependency, not part of the MIT library contract. Current Deep Agents
guides direct production users to the distinct **Managed Deep Agents** product;
custom LangGraph applications use **Agent Server**, operated through
**LangSmith Deployment**. These names are related layers, not synonyms. See the
[Deep Agents TypeScript overview](https://docs.langchain.com/oss/javascript/deepagents/overview),
[Deep Agents production direction](https://docs.langchain.com/oss/javascript/deepagents/quickstart),
and [LangSmith Deployment overview](https://docs.langchain.com/langsmith/deployment).

OpenAI Agents SDK is the best lighter harness alternative. It removes the agent
loop, tools, handoffs, approvals, sessions, sandbox integration, and tracing.
It does not ship an Agent Server equivalent, durable work queue, arbitrary-step
checkpoint runtime, or multi-tenant deployment plane. Oz would continue to own
those layers.

OpenCode is a mature coding-agent application and a valuable behavioral
comparable, but its public SDK is primarily a typed client for an OpenCode
server. It is not a general embeddable agent-runtime SDK today. Its current V2
Effect-native in-process SDK is explicitly beta, private to the OpenCode
workspace, unpublished, and subject to change. Adopting OpenCode whole would
make Oz a hosted coding-agent service and still require Osfo to build durable
execution and tenant isolation.

OpenRouter now has a genuine, Apache-2.0, beta Agent SDK in addition to its
client SDK. It provides a useful lightweight multi-turn loop, tools, approvals,
state accessors, streaming, stop conditions, and lifecycle hooks. Its decisive
strength is still the hosted model gateway: routing, fallbacks, BYOK, policy,
and one interface across hundreds of models. It does not provide a durable
agent task queue, checkpointed worker runtime, native sandbox manager, or
multi-tenant product server. Use it under a harness, not as the sole Oz
foundation.

## Do not conflate these contracts

| Often conflated concepts                        | Actual boundary                                                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session memory and durable execution            | Remembering conversation items does not recover an interrupted tool sequence, fence a stale worker, or make an external side effect idempotent.                                    |
| Serializable pause state and checkpoint runtime | A JSON snapshot can resume a known pause. A checkpoint runtime additionally owns when state commits, which work is replayed, and how a replacement worker continues after failure. |
| Provider portability and gateway independence   | A gateway can switch among many models while still making the application dependent on that gateway. Direct provider adapters preserve a different kind of portability.            |
| Traces and product events                       | Traces diagnose execution. They are not the canonical user-visible thread, approval, artifact, or delivery ledger.                                                                 |
| Sandbox adapter and sandbox service             | A client interface does not provision, isolate, meter, expire, or recover execution environments by itself.                                                                        |
| Subagent call and durable background task       | Calling another agent as a tool is usually nested work. A durable background task also needs identity, status, cancellation, steering, persistence, and recovery.                  |
| Hosted inference scale and application scale    | A model provider can absorb inference traffic while Oz still owns admission, tenant fairness, queues, workers, approvals, streams, and data isolation.                             |

## Capability matrix

Legend: **strong** means the capability is an explicit supported contract;
**partial** means useful primitives exist but Oz must supply material lifecycle
machinery; **absent** means no current official contract was found.

| Capability                        | Deep Agents + LangGraph                                                                              | OpenAI Agents SDK                                                                     | OpenCode SDK/server                                                               | OpenRouter Agent SDK                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent loop or harness             | **Strong**, opinionated long-horizon harness over a customizable graph                               | **Strong**, small Runner loop with tools, handoffs, guardrails, and sessions          | **Strong but coding-specific** in the server; public SDK is a client              | **Strong but lightweight**, beta `callModel` loop                                                                 |
| Model gateway                     | Partial, direct LangChain integrations and optional OpenRouter                                       | Partial, OpenAI native plus custom/beta adapters                                      | Partial, AI SDK and Models.dev provider catalog                                   | **Strong**, this is OpenRouter's primary service                                                                  |
| Durable execution                 | **Strong**, super-step checkpoints, pending writes, interrupts, and Agent Server queue               | Partial, durable serialized `RunState` for pauses but no general checkpoint scheduler | Weak, durable local session data but process-local active runners                 | Partial, caller-provided JSON `StateAccessor`; no durable worker runtime                                          |
| Tools and MCP                     | **Strong**, LangChain tools plus official MCP adapters; Deep Agents Code has native MCP config       | **Strong**, function, hosted, local, and MCP tools across several transports          | **Strong**, coding tools, custom tools, skills, and MCP                           | Partial, typed tools and hosted server tools; remote MCP is a separate package, not an Agent SDK runtime contract |
| Subagents                         | **Strong**, sync task tool; async background subagents are preview                                   | **Strong for nested orchestration**, agents-as-tools and handoffs                     | **Strong for coding sessions**, task tool creates child sessions                  | Partial, beta hosted subagent server tool with restricted nested tools                                            |
| Approval and HITL                 | **Strong**, arbitrary durable interrupts plus tool approval/edit/reject                              | **Strong**, tool approvals and serializable nested interruption state                 | **Strong interactively**, allow/ask/deny permissions; no durable approval service | **Strong**, tool and call approval with persisted pending state                                                   |
| Tracing and evaluations           | **Strongest**, LangSmith traces plus offline and online evaluation                                   | **Strong tracing**, OpenAI evaluation integration and custom processors               | Partial, logs and experimental telemetry; no comparable evaluation plane          | Partial, gateway logs/broadcast plus lifecycle hooks; no comparable agent eval plane                              |
| Sandbox and code execution        | **Strong**, pluggable sandbox backends and local shell option                                        | **Strong but newer**, hosted tools plus beta provider-neutral Sandbox Agents          | Partial, shell runs in the server's workspace unless deployment isolates it       | Weak, a user tool may call a sandbox but the SDK supplies no sandbox service                                      |
| Multi-tenant deployment and scale | **Strongest with managed products**, custom auth, queue workers, Postgres, Redis, horizontal scaling | Absent as an SDK contract; host application owns it                                   | Absent, one Basic Auth server and local data are not tenant isolation             | Gateway workspaces are strong, but agent-loop deployment remains caller-owned                                     |
| Provider portability              | **Strong**, any compatible tool-calling LangChain model                                              | Partial to strong at interface level, with feature skew outside OpenAI                | **Strong**, 75+ providers and local models                                        | Strong within OpenRouter, weak against gateway dependency                                                         |

## 1. Deep Agents, LangGraph, Managed Deep Agents, and Agent Server

### Product boundaries

The current stack has four different responsibilities:

1. **Deep Agents** is the open-source opinionated harness. It adds planning,
   filesystem context, compaction, skills, subagents, memory, permissions, and
   optional shell execution. `createDeepAgent` returns a compiled LangGraph in
   TypeScript. [Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview)
2. **LangGraph** is the open-source graph execution runtime. It provides graph
   state, streaming, checkpoint interfaces, interrupts, subgraphs, and replay
   semantics. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
3. **Managed Deep Agents** is the current managed product path named by the
   Deep Agents production guides. It exposes managed agent, permission, job,
   and MCP resources. It should be evaluated as a product dependency, not
   assumed to be identical to deploying arbitrary Deep Agents source in Agent
   Server. [Managed Deep Agents API](https://docs.langchain.com/langsmith/managed-deep-agents-api/agents/list-agents)
4. **Agent Server** is the deployable run API and execution runtime for custom
   graphs. **LangSmith Deployment** operates Agent Server in Cloud, hybrid,
   self-hosted, or standalone arrangements. It exposes assistants, threads,
   runs, crons, persistence, and a task queue. [Agent Server](https://docs.langchain.com/langsmith/agent-server)

This distinction matters for a proof of concept. A Deep Agents experiment can
start with the OSS TypeScript library. A production-hosting experiment must
separately choose Managed Deep Agents or an Agent Server deployment path and
verify the exact APIs and tenancy controls exposed by that product.

### Harness and provider contract

Deep Agents explicitly calls itself an agent harness. It builds on LangChain's
agent loop and adds long-horizon defaults: `write_todos`, filesystem tools,
context offloading and summarization, a default general-purpose subagent,
skills, persistent memory, and configurable middleware. It accepts any
LangChain chat model that supports tool calling. Official integrations include
OpenAI, Anthropic, Google, Bedrock, Azure, OpenRouter, Fireworks, Ollama, and
open-weight endpoints. [Models](https://docs.langchain.com/oss/python/deepagents/models)

This is genuine provider portability, but it is not guaranteed feature
equivalence. Tool-call formats, multimodal inputs, structured output, cache
semantics, and reasoning controls still vary by model and integration. Harness
profiles are a beta mechanism for adapting prompts and tool behavior to a
provider or model. [Harness profiles](https://docs.langchain.com/oss/python/deepagents/profiles)

### Durable execution

LangGraph saves graph state at each super-step when compiled with a durable
checkpointer. It also stores completed writes from tasks in a failed
super-step, so successful sibling nodes do not have to repeat during recovery.
Threads, checkpoint history, time travel, state inspection, and fault recovery
are explicit runtime concepts. Agent Server supplies checkpoint infrastructure
and a durable task queue around graph runs. [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

This is the strongest durability contract in the comparison, but it does not
make arbitrary external effects exactly once. Code around interrupts and replay
must be idempotent. Model calls and tools with external side effects still need
explicit uncertainty and idempotency policy. Osfo should therefore avoid
mapping a LangGraph checkpoint directly to its canonical product event log.

### Tools, subagents, approvals, and sandboxes

LangChain's official MCP adapters turn MCP tools into ordinary LangChain tools
and support stdio and streamable HTTP, stateless calls, or controlled persistent
sessions. Deep Agents Code adds user and project `.mcp.json` discovery with a
trust gate. [LangChain MCP](https://docs.langchain.com/oss/python/langchain/mcp)

Synchronous Deep Agents subagents run through a built-in `task` tool and isolate
their context from the parent. Custom subagents can use another model, tools,
skills, permissions, or a compiled LangGraph. Async subagents add independent
threads, task IDs, progress, follow-up steering, and cancellation, but remain a
preview feature. [Subagents](https://docs.langchain.com/oss/python/deepagents/subagents),
[async subagents](https://docs.langchain.com/oss/python/deepagents/async-subagents)

LangGraph interrupts can pause at arbitrary code points, persist indefinitely,
surface JSON input, and resume after an external decision. Deep Agents exposes
approve, edit, and reject policies for selected tools. [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

Deep Agents models sandboxes as pluggable filesystem backends with an
`execute` capability. Official integrations include LangSmith, Daytona, Modal,
Runloop, AgentCore, and other providers. Thread and assistant sandbox scoping
are documented. Filesystem permissions only constrain built-in filesystem
tools. They do not police custom tools, MCP servers, or arbitrary shell commands
inside a sandbox, so the sandbox and tool boundary must enforce real policy.
[Sandboxes](https://docs.langchain.com/oss/python/deepagents/sandboxes),
[permissions](https://docs.langchain.com/oss/python/deepagents/permissions)

### Tracing, evaluation, tenancy, and scale

LangSmith provides automatic LangChain and LangGraph traces plus datasets,
experiments, offline regression evaluation, online production evaluation,
human feedback, rules, pairwise comparison, and LLM judges. This is materially
more complete than the other three evaluation offerings. [LangSmith evaluation](https://docs.langchain.com/langsmith/evaluation)

Agent Server has API and queue-worker tiers, PostgreSQL durable state, Redis for
ephemeral streaming and coordination, and independent horizontal scaling.
Custom authentication and authorization handlers can scope threads,
assistants, runs, and crons to an end user. Without those handlers, the server
only sees the API-key owner, so multi-tenancy is not automatic. Managed cloud
removes the most operational work. Standalone or self-hosted modes give control
back but also restore the responsibility for Kubernetes, PostgreSQL, Redis,
scaling, upgrades, and the LangSmith license. [Deployment](https://docs.langchain.com/langsmith/deployment),
[scaling](https://docs.langchain.com/langsmith/agent-server-scale), and
[custom authentication](https://docs.langchain.com/langsmith/custom-auth)

### Oz fit

This is the best candidate for the first bounded Oz replacement experiment.
Do not port every current Osfo lifecycle type into LangGraph. First define a
small Oz agent on Deep Agents, then test:

- one accepted user message and streamed answer;
- one local or MCP tool;
- one approval that survives process replacement;
- one provider change through OpenRouter or a direct adapter;
- one sandboxed artifact;
- one failure resumed from a real durable checkpoint;
- one tenant that cannot read or resume another tenant's thread;
- one LangSmith trace connected back to the Osfo-owned product identity.

## 2. OpenAI Agents SDK

### Harness and provider contract

OpenAI Agents SDK provides a small but capable Runner loop. It calls the model,
executes tools or handoffs, appends results, and repeats until final output or a
turn limit. Its main abstractions are agents, function tools, agents-as-tools,
handoffs, guardrails, sessions, and tracing. [Running agents](https://openai.github.io/openai-agents-python/running_agents/)

Provider abstraction is real: the SDK defines `Model` and `ModelProvider`, can
use OpenAI-compatible endpoints, and supports different providers per agent or
run. Python also includes Any-LLM and LiteLLM integrations. Official docs label
those adapter paths best-effort beta and warn that tool calling, usage,
structured output, and request semantics vary. OpenAI Responses remains the
best-supported path and owns several hosted-only tools. [Models](https://openai.github.io/openai-agents-python/models/)

### Persistence and durability boundary

Sessions persist conversation history across runs. `RunState` is a serializable
snapshot of an interrupted run, including approvals, model responses, usage,
nested agent-tool state, trace metadata, and optional server conversation IDs.
It can be written to a database or queue and restored later, making HITL pauses
durable. [RunState](https://openai.github.io/openai-agents-python/ref/run_state/)

This is useful but narrower than LangGraph checkpointing. The SDK does not ship
a task queue, lease and worker model, arbitrary-step checkpoints, replay
scheduler, thread-concurrency service, or replacement-worker recovery. Oz must
own these or combine the SDK with another durable workflow system. A session is
memory, and a stored RunState is a pause snapshot. Neither alone is a general
run runtime.

### Tools, MCP, subagents, approvals, and sandbox

The Python SDK has one of the strongest tool surfaces: ordinary function tools,
hosted web and file search, code interpreter, image generation, hosted MCP,
hosted or local shell, computer tools, patch tools, and an experimental Codex
tool. MCP supports hosted execution plus local stdio, legacy SSE, and streamable
HTTP, with filtering, retry, caching, tool metadata, and approval policies.
[Tools](https://openai.github.io/openai-agents-python/tools/) and
[MCP](https://openai.github.io/openai-agents-python/mcp/)

Multi-agent composition uses either handoffs, where another agent becomes
active, or agents-as-tools, where a manager retains control. Nested approval
interruptions surface on the outer run and serialize through RunState. This is
excellent nested orchestration, but it is not a background-task server with
task IDs, durable progress, and independent worker ownership.
[Human in the loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)

Current Python releases also contain beta Sandbox Agents with provider-neutral
sandbox clients and resumable sandbox session state. Official providers include
local Unix, Docker, Cloudflare, Daytona, E2B, Modal, Runloop, Vercel, and Blaxel.
OpenAI Responses additionally provides hosted code interpreter and container
shell execution. These are important improvements over older assessments, but
the beta label and language-specific feature differences require a TypeScript
proof before Oz depends on the full surface. [Sandbox concepts](https://openai.github.io/openai-agents-python/sandbox/guide/)

### Tracing, evaluation, tenancy, and scale

Tracing is enabled by default and records Runner, task, turn, model generation,
tool, guardrail, handoff, and custom spans. The default exporter targets the
OpenAI dashboard, while custom processors can replace or supplement it.
Non-OpenAI models can use OpenAI traces with an OpenAI tracing key. Zero Data
Retention organizations cannot use OpenAI-hosted tracing. [Tracing](https://openai.github.io/openai-agents-python/tracing/)

The SDK integrates with OpenAI's evaluation, fine-tuning, and distillation
suite, but the SDK itself does not expose LangSmith's combined datasets,
experiments, online evaluation, and deployment plane.

No official multi-tenant Agent Server equivalent exists in the SDK. An Osfo
worker, FastAPI process, Cloudflare Worker, or other host calls Runner. That
host owns tenant authentication, resource authorization, data partitioning,
admission, fairness, queues, scheduling, retries, deployment, and scaling.

### Oz fit

Choose OpenAI Agents SDK over Deep Agents when Oz intentionally values a small
harness, OpenAI-first capabilities, and application-owned runtime policy more
than built-in durable orchestration. It is a credible prototype foundation, but
it does not satisfy the original goal of stopping the hand-written platform
work as completely as Deep Agents plus LangGraph.

## 3. OpenCode SDK and server

### What the SDK actually is

OpenCode is an open-source coding agent. Its headless `opencode serve` process
owns the agent loop, project access, provider connections, sessions, tools,
MCP, permissions, and events. The public `@opencode-ai/sdk` is generated from
that server's OpenAPI contract. `createOpencode()` starts a local server and
client, while `createOpencodeClient()` connects to an existing server.
[SDK](https://opencode.ai/docs/sdk) and
[server](https://opencode.ai/docs/server/)

The V2 Effect-native `@opencode-ai/sdk-next` documentation is explicit: the
in-process host is beta, private to the OpenCode workspace, not published for
external installation, and its package and API may change. It cannot currently
be treated as a stable embeddable Oz foundation. [V2 SDK](https://opencode.ai/v2/docs/build/sdk)

### Strengths

OpenCode is the closest TypeScript and Effect-shaped comparable. It uses the AI
SDK and Models.dev to support more than 75 providers and local models. Provider
and model IDs, credentials, compatible base URLs, and per-agent overrides are
first-class. [Providers](https://opencode.ai/docs/providers)

Its coding harness includes file read/write/edit, grep and glob, shell, LSP,
web retrieval, skills, custom tools, MCP servers, todo management, compaction,
and specialized primary and subagents. Subagents receive child sessions and
are called with a task tool. Permissions support allow, ask, and deny globally,
per tool input pattern, and per agent. [Tools](https://opencode.ai/docs/tools/),
[agents](https://opencode.ai/docs/agents/), and
[permissions](https://opencode.ai/docs/permissions)

The server provides a useful typed HTTP and event surface for embedding a
coding agent in another client. Sessions and messages persist locally, and the
TUI can reattach or continue a prior session.

### Missing platform contracts

Persisted sessions do not make execution durable. At the inspected official
revision, `SessionRunState` stores active session runners in an in-process
`Map` and cancels them when the service scope closes. A replacement server can
read recorded messages, but no official lease, durable queue, checkpoint,
fence, or crash-continuation contract guarantees recovery of the interrupted
turn. See the reviewed source at
[`session/run-state.ts`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/opencode/src/session/run-state.ts).

The documented server offers HTTP Basic Auth with one server username and
password. That protects the process but does not provide per-tenant identity,
row-level authorization, fair admission, queue isolation, or independently
scalable workers. The documented storage is local application data, and shell
commands execute with the authority of the server environment. Containerizing
OpenCode can isolate a server, but OpenCode does not provision and govern a
sandbox per tenant or run. [Server authentication](https://opencode.ai/docs/server/)
and [storage](https://opencode.ai/docs/troubleshooting/)

OpenCode has logs and experimental telemetry hooks, but no current official
evaluation product comparable to LangSmith. Its permission prompts are strong
for a connected interactive client, but no documented durable approval queue
supports an approval hours later after arbitrary server replacement.

### Oz fit

OpenCode is a strong choice only if Oz is deliberately a hosted coding-agent
product. Even then, run one isolated server or workspace boundary per trusted
tenant context and put Osfo identity, durable admission, and lifecycle around
it. For a general personal agent that acts across messaging, schedules,
connectors, and sandboxes, adopt OpenCode's provider, tool-registry, permission,
skills, and child-session patterns rather than the whole server.

## 4. OpenRouter Client SDK and Agent SDK

### Product boundaries

OpenRouter has two relevant SDK layers:

- client SDKs mirror the hosted API and leave orchestration to the application;
- the beta TypeScript `@openrouter/agent` package adds `callModel`, automatic
  tool execution, multi-turn conversation state, streaming, dynamic parameters,
  and stop conditions. [Agent SDK overview](https://openrouter.ai/docs/agent-sdk/overview)

The Agent SDK should not be confused with community projects named OpenRouter
Agents. The inspected official package is Apache-2.0 and lives in
`OpenRouterTeam/typescript-agent`.

### Harness and state

`callModel` repeats model requests and tool execution until the model finishes
or a stop rule triggers. Stop rules cover steps, a named tool, tokens, cost,
finish reason, or custom logic. Tools use Zod schemas, can stream intermediate
events, share typed context, and run automatically or manually. Lifecycle hooks
can inspect, mutate, approve, block, audit, and record each tool and model turn.
[Stop conditions](https://openrouter.ai/docs/agent-sdk/call-model/stop-conditions)
and [tools](https://openrouter.ai/docs/agent-sdk/call-model/tools)

The `StateAccessor` interface lets the caller load and save plain JSON
`ConversationState`. State includes messages, previous response ID, pending
approvals, unsent tool results, interruption metadata, timestamps, and status.
This supports serverless cold-start continuation and long-lived approvals when
the application supplies Redis, SQL, or another store. It does not define a
transactional task queue, checkpoint frequency, worker leases, fencing, or
recovery of an arbitrary in-flight external tool. [Tool approval and state](https://openrouter.ai/docs/agent-sdk/call-model/tool-approval-state)

### Gateway and provider portability

The hosted gateway is OpenRouter's unique advantage. It normalizes model calls,
routes among providers, orders by price, throughput, latency, or tool
reliability, supports fallbacks and BYOK, and enforces provider, privacy, ZDR,
and budget controls. Workspaces isolate API keys, routing defaults, guardrails,
observability, and budgets for teams or environments. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
and [workspaces](https://openrouter.ai/docs/guides/features/workspaces/overview)

This is broad model portability within one hosted gateway, not gateway
independence. If OpenRouter becomes unavailable or changes semantics, the Agent
SDK has no direct-provider execution path equivalent to LangChain or OpenCode
provider adapters. Oz can contain this dependency behind a model interface.

### Tools, subagents, tracing, and deployment

OpenRouter provides hosted server tools such as web search, web fetch, image
generation, apply patch, advisor, fusion, and a beta subagent. The hosted
subagent delegates a self-contained task to a worker model. It sees only the
task description, retains no cross-task memory, returns only its final outcome,
and can use only OpenRouter server tools. Client-side function tools cannot run
inside it. This is useful delegation, not a general durable multi-agent runtime.
[Subagent server tool](https://openrouter.ai/docs/guides/features/server-tools/subagent)

No native MCP client contract is documented for the Agent SDK. OpenRouter has
a separate `@openrouter/mcp` package for remote MCP servers, while stdio is
explicitly outside that package's scope. An application can also wrap MCP calls
as typed function tools, but it owns connection, discovery, authentication,
filtering, and lifecycle. Likewise, the SDK has no native sandbox service. A
`sandbox_exec` tool in the docs is an example supplied by the application, not
an OpenRouter sandbox. [OpenRouter MCP SDK](https://github.com/OpenRouterTeam/mcp-client)

OpenRouter Observability records gateway generations and can broadcast standard
GenAI spans to other systems. Agent SDK lifecycle hooks expose enough data for
Oz to build turn and tool spans. There is no documented LangSmith-equivalent
agent evaluation and deployment plane. [Broadcast](https://openrouter.ai/docs/guides/features/broadcast/overview)

The hosted gateway scales inference and provides organization workspaces. The
Agent SDK loop and all client tools still run in the caller's process. Osfo
therefore owns tenant-level agent state, admission, queueing, tool workers,
approvals, sandboxes, streams, and recovery.

### Oz fit

OpenRouter is a strong optional model gateway beneath Deep Agents, LangGraph,
OpenAI Agents SDK, or a narrow Oz harness. Its Agent SDK is suitable for a fast
bounded prototype or simple agent loop. Because it is beta and lacks durable
execution, native MCP, sandboxing, and deployment, it should not be the sole Oz
runtime foundation.

## Recommended decision sequence

1. Freeze new custom agent-loop and topology work while evaluating the existing
   harnesses.
2. Build one Deep Agents TypeScript vertical slice. Keep Osfo identity, thread
   ownership, channels, and public product events outside the harness.
3. Run that slice first with direct LangGraph checkpointing, then with the
   current managed product path. Verify whether Managed Deep Agents or Agent
   Server exposes the exact auth, deployment, sandbox, and event surfaces Oz
   needs.
4. Put OpenRouter behind a narrow model-gateway port in the slice. Test provider
   failover, usage, tool-call compatibility, privacy routing, and error mapping.
5. Build the same bounded agent with OpenAI Agents SDK only if the LangChain
   stack proves too broad or the commercial hosting dependency is unacceptable.
6. Treat OpenCode as a separate coding-agent experiment, not the default general
   runtime.
7. Decide which current Osfo components remain only after observing the slice.
   Likely durable product responsibilities are tenant identity, agent definition
   version, thread or task ownership, approval and artifact projection, channel
   delivery, product policy, and an exportable user-visible event contract.

The user-facing aggregate should normally be a thread, task, or workspace, not
an `AgentRun`. A run is bounded execution under a particular agent version and
runtime configuration. A durable product aggregate may include several run
attempts, an approval pause, recovered execution, artifacts, and multiple
deliveries:

```text
Agent definition version
          |
          v
Thread / task / workspace
          |
          +--> accepted input
          +--> run attempt 1
          +--> approval
          +--> recovered run attempt
          +--> artifacts
          `--> channel deliveries
```

## Reviewed official revisions

The local official reference repositories were refreshed before inspection.
Documentation was accessed on 2026-08-08.

| Project                                                                                                                  | Revision       | Notes                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------- |
| [Deep Agents Python](https://github.com/langchain-ai/deepagents/tree/d60560d695e8c436e11dee96965e7a1447409737)           | `d60560d695e8` | Current package version `0.7.5`                             |
| [Deep Agents JS/TS](https://github.com/langchain-ai/deepagentsjs/tree/77e104f26a62ae34afbb1393edf191009d37280c)          | `77e104f26a62` | TypeScript harness used for Oz stack fit                    |
| [LangGraph](https://github.com/langchain-ai/langgraph/tree/fde3068970679184b68d3d068a92c83c966a4888)                     | `fde306897067` | Python monorepo; JS contracts also checked in official docs |
| [OpenAI Agents SDK Python](https://github.com/openai/openai-agents-python/tree/fd4db5609c2fdfb0b5926617878966d13a014517) | `fd4db5609c2f` | Current package version `0.19.4`                            |
| [OpenAI Agents SDK JS/TS](https://github.com/openai/openai-agents-js/tree/ccb85cfada2b0580fb97c5ee110c938c8071f690)      | `ccb85cfada2b` | Current package version `0.14.3`                            |
| [OpenCode](https://github.com/anomalyco/opencode/tree/fe82a1b6ca4f535beb973b0867017e3f639f85ed)                          | `fe82a1b6ca4f` | Current development branch, package version `1.18.15`       |
| [OpenRouter Agent SDK](https://github.com/OpenRouterTeam/typescript-agent/tree/5a7ed03e5acf47e640ec027dbd3c713f115a054a) | `5a7ed03e5acf` | Official beta package, npm `0.8.0`, Apache-2.0              |

## Bottom line

The decision is not "build versus buy" for the entire Osfo product. It is which
layers are differentiated:

- Osfo should own the product aggregate, identity, tenant policy, channels,
  public events, and user experience.
- Deep Agents can own the first agent harness.
- LangGraph plus a current managed LangChain runtime can own checkpoints,
  interrupts, and much of run execution.
- OpenRouter can own model routing if the gateway trade is acceptable.
- A sandbox provider can own isolated compute.
- OpenAI Agents SDK is the best smaller fallback harness.
- OpenCode is a coding-agent product to integrate or study, not a stable general
  runtime SDK to embed today.

That composition lets the project learn from an operating harness now without
closing the door on replacing individual layers later.

# Agent harness architecture comparables for Oz

Research date: 2026-08-08.

## Decision

Oz should stop treating `AgentRun` as the top-level product primitive unless
Osfo deliberately intends to become an agent infrastructure product.

For an agent product, the more stable hierarchy is:

```text
persistent agent identity
  -> conversation
     -> accepted user or system submission
        -> one or more execution attempts
        -> one durable settlement
  -> optional memory across conversations
  -> selected execution environment

long, explicit business process
  -> workflow or graph instance
```

Runs remain useful operational records. They are not usually what the user
owns, resumes, shares, or returns to. Flue, OpenHands, Letta, Mastra, and
LangGraph all make a longer-lived identity, conversation, thread, graph, or
workflow more authoritative than one agent run.

The best current reset candidate is **Flue as the sole agent runtime
authority**, using its Cloudflare target for the first production-shaped
prototype. This recommendation is conditional on Oz accepting Flue's
conversation, submission, model-loop, tool, and recovery semantics. Flue
should not be placed behind Osfo's current authority-free `AgentRuntime` seam.
That would retain two versions of the same machinery and defeat the reason for
adopting a harness.

If durable provider-call intent, provider-neutral canonical records,
independently durable child AgentRuns, and topology-neutral PostgreSQL
authority are non-negotiable product requirements, keep Osfo's current design
and accept that Osfo is building a platform. There is no credible hybrid where
both Osfo and Flue own the same conversation lifecycle.

## Scope and method

This survey inspected official repositories and documentation only. The
repositories were updated before inspection and pinned to these revisions:

| System                                                                                                                        | Revision                                             | Why it is comparable                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Flue](https://github.com/withastro/flue/tree/bf86b8726f5ba189844185fdbeca0e194344ded1)                                       | `bf86b8726f5ba189844185fdbeca0e194344ded1`, v2.0.3   | TypeScript agent application framework with durable submissions, streaming, tools, sandboxes, and Node and Cloudflare targets |
| [OpenHands Agent Canvas](https://github.com/All-Hands-AI/OpenHands/tree/4470813ce58f5ac384e3d367d34518e10106526b)             | `4470813ce58f5ac384e3d367d34518e10106526b`           | Self-hosted control plane for coding agents and automations                                                                   |
| [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk/tree/c7e270aae43a6e9bcc8723d27b85c680ab38e156) | `c7e270aae43a6e9bcc8723d27b85c680ab38e156`           | The current OpenHands conversation, event, lease, LLM, and workspace implementation                                           |
| [Letta Agent SDK](https://github.com/letta-ai/letta-agent-sdk/tree/faf349663f090f94b2ac2fb2c47f44a7caf751b5)                  | `faf349663f090f94b2ac2fb2c47f44a7caf751b5`           | Current TypeScript interface for managed, local, and self-hosted persistent agents                                            |
| [Letta Code](https://github.com/letta-ai/letta-code/tree/5b852822ab3adbfc52f11af4550c6f574e43ef2c)                            | `5b852822ab3adbfc52f11af4550c6f574e43ef2c`, v0.30.11 | Current local harness, persistence, provider, sandbox, and telemetry implementation                                           |
| [Mastra](https://github.com/mastra-ai/mastra/tree/bab06b18923873a584bdfc71a6b4ec7fb4727fb7)                                   | `bab06b18923873a584bdfc71a6b4ec7fb4727fb7`           | Broad TypeScript framework spanning agents, workflows, memory, storage, workspaces, and observability                         |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs/tree/6ac60da74f6b9e29d20b111a7947ac3060f1d2dd)                     | `6ac60da74f6b9e29d20b111a7947ac3060f1d2dd`           | TypeScript graph runtime and checkpoint protocol                                                                              |
| [LangGraph](https://github.com/langchain-ai/langgraph/tree/fde3068970679184b68d3d068a92c83c966a4888)                          | `fde3068970679184b68d3d068a92c83c966a4888`           | Official checkpoint, task, thread, run, and API schemas                                                                       |

The older [`letta-ai/letta`](https://github.com/letta-ai/letta/blob/ff19ffeafeb54bd2a7dc5d4a552f10191732a235/README.md)
repository was not treated as current architecture. Its own README identifies
it as the legacy V1 server and directs new work to the Agent SDK and App
Server.

## Comparison at a glance

| System    | True product primitive                                                                 | Durable authority                                                  | Execution and sandbox                                            | Provider abstraction                 | Traceability                                                             | Best use for Oz                                                              |
| --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Flue      | Agent conversation plus accepted submission                                            | Append-only conversation records and durable submission settlement | Optional conversation-scoped sandbox, local and remote adapters  | Pi model catalog and integrated loop | Canonical product stream plus OpenTelemetry-compatible runtime telemetry | Best candidate to replace Osfo's agent runtime authority                     |
| OpenHands | Coding-agent conversation                                                              | Append-only event log, conversation state, and fenced lease        | First-class local, Docker, VM, Kubernetes, and remote workspaces | LiteLLM                              | Immutable trajectory plus Laminar and OTLP                               | Best if Oz becomes a coding-agent control center                             |
| Letta     | Persistent agent identity with memory                                                  | Agent, memory, and conversation state in Cloud or App Server       | Local permission sandbox or selected remote computer             | Pi and Letta provider registry       | Transcript, memory history, telemetry                                    | Best if long-lived evolving memory is the product                            |
| Mastra    | Application framework, with separate agent, memory thread, and workflow run primitives | Storage domains and workflow snapshots                             | Workspace interface with many sandbox providers                  | AI SDK model router and gateways     | Strong OpenTelemetry-oriented observability                              | Best broad TypeScript toolkit, but requires choosing one canonical primitive |
| LangGraph | Checkpointed graph invocation inside a thread                                          | Checkpoints and pending writes                                     | Not a core concern                                               | LangChain model integrations         | Streams and callbacks, strongest fleet tracing through LangSmith         | Best for explicit state graphs and durable workflows                         |

## 1. Flue

### Primitive and authority

Flue's durable object is an addressable agent conversation. The application
maps an authenticated caller and route to an agent and conversation identity,
then submits work into that conversation. The application still owns identity,
authorization, routing, and product policy. Flue owns what happens after
admission. See its [routing model](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/routing.md)
and [SDK overview](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/sdk/overview.md).

The key durable contract is stronger than a normal in-memory agent loop:

1. A submission is admitted durably before model work starts.
2. One conversation processes admitted submissions in order.
3. Each accepted submission eventually receives one durable `completed`,
   `failed`, or `aborted` settlement.
4. Canonical partial output survives interruption.
5. Recovery classifies what to resume from durable evidence, not from the old
   process.

These guarantees are explicit in Flue's
[durability contract](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/durability.md).
Internally, `Session` integrates conversation folding, the Pi agent loop,
provider streaming, tool execution, compaction, retries, and recovery rather
than exporting a pure next-step function. See
[`session.ts`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/session.ts).

This means Flue offers **at-least-once execution with exactly-once durable
recording and settlement**, not magical exactly-once external effects.
Ordinary interrupted tools become uncertain outcomes instead of being blindly
replayed. Tools that opt into durable steps use stable `step.do` records so
completed steps can be reused.

### Persistence, deployment, and scaling

On Node, SQLite or PostgreSQL stores the canonical stream and submissions, but
one live process must own a conversation. A shared database supports takeover
and recovery, not unconstrained active-active processing. See the
[Node target guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/node-target.md).

On Cloudflare, each conversation maps naturally to a Durable Object. Its local
SQLite database owns the conversation stream and accepted submissions, and
alarms provide wake and recovery. Placement gives one structural writer per
conversation. See the
[Cloudflare target guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/cloudflare-target.md).
That deployment shape is unusually well aligned with Flue's actual authority
model. It is the reason to prototype the Cloudflare target before combining a
Node worker fleet with a separate managed database.

### Sandboxes, providers, and traceability

Sandboxing is optional. Flue can use a virtual ephemeral filesystem, the local
host, or remote providers. A remote sandbox can be keyed to the conversation,
but Flue does not make workspace persistence identical to conversation
persistence. See the [sandbox guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/sandboxes.md).

Model support comes through Pi's model catalog and provider machinery. The
loop, message types, executable tools, model retries, and compaction are
integrated into Flue. This gives Oz provider breadth quickly, but it also means
Flue cannot honestly be described as an authority-free adapter behind Osfo.

Flue separates its canonical conversation records from live runtime
telemetry. It supports OpenTelemetry-style traces and integrations such as
Sentry and Braintrust, while the durable stream remains the source for product
recovery. See the
[observability guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/observability.md).

### Emulate or avoid

Emulate:

- durable admission before work;
- one settlement obligation per accepted submission;
- persist-before-publish streaming with batched fragments;
- recovery from durable facts;
- explicit uncertain outcomes for interrupted side effects;
- conversation-shaped placement on the Cloudflare target.

Avoid:

- writing the same lifecycle to both Flue records and Osfo `ThreadEvent`s;
- wrapping Flue in `AgentRuntime.decide` while Flue still owns its internal
  model and tool loop;
- assuming the Node target is active-active merely because PostgreSQL is
  shared;
- treating conversation state and sandbox state as the same durability domain.

## 2. OpenHands

### Primitive and authority

OpenHands now has two relevant layers. Agent Canvas is a self-hosted developer
control center that can operate OpenHands, Claude Code, Codex, Gemini, and any
ACP-compatible agent across multiple backends. Its user-facing primitive is a
conversation on a selected agent backend, not one OpenHands run. See the
[Agent Canvas README](https://github.com/All-Hands-AI/OpenHands/blob/4470813ce58f5ac384e3d367d34518e10106526b/README.md)
and [architecture](https://github.com/All-Hands-AI/OpenHands/blob/4470813ce58f5ac384e3d367d34518e10106526b/docs/architecture.md).

In the Software Agent SDK, `Conversation` owns the event history, agent state,
workspace, persistence, and execution loop. `Conversation.run()` repeatedly
calls the agent's `step()` until the agent finishes or pauses. The agent step
can invoke the model and tools directly. There is no separate durable run
aggregate between the conversation and the attempt. See
[`local_conversation.py`](https://github.com/OpenHands/software-agent-sdk/blob/c7e270aae43a6e9bcc8723d27b85c680ab38e156/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py)
and [`agent.py`](https://github.com/OpenHands/software-agent-sdk/blob/c7e270aae43a6e9bcc8723d27b85c680ab38e156/openhands-sdk/openhands/sdk/agent/agent.py).

### Persistence and concurrency

The event log is append-only, stores events separately, tracks event and parent
IDs, supports branching, and uses file locks. See
[`event_store.py`](https://github.com/OpenHands/software-agent-sdk/blob/c7e270aae43a6e9bcc8723d27b85c680ab38e156/openhands-sdk/openhands/sdk/conversation/event_store.py).
The agent server adds a lease with owner instance, generation, and expiry so a
new owner can fence an older process. See
[`conversation_lease.py`](https://github.com/OpenHands/software-agent-sdk/blob/c7e270aae43a6e9bcc8723d27b85c680ab38e156/openhands-agent-server/openhands/agent_server/conversation_lease.py).

This is a credible single-conversation recovery model, but local file locking
and network filesystems require care. It is not equivalent to a managed
distributed event store.

### Sandboxes, providers, deployment, and traces

Workspaces are a core abstraction. OpenHands can run against the host, Docker,
VMs, Kubernetes, cloud workspaces, or a remote agent server. This is the
strongest code-execution design in the comparison. Agent Canvas can also
connect to multiple servers and move between local, company, and managed
backends.

The SDK uses LiteLLM for provider normalization and has its own retry behavior.
See [`llm.py`](https://github.com/OpenHands/software-agent-sdk/blob/c7e270aae43a6e9bcc8723d27b85c680ab38e156/openhands-sdk/openhands/sdk/llm/llm.py).
Its immutable trajectory gives useful product evidence, while Laminar and OTLP
provide operational traces. See
[`laminar.py`](https://github.com/OpenHands/software-agent-sdk/blob/c7e270aae43a6e9bcc8723d27b85c680ab38e156/openhands-sdk/openhands/sdk/observability/laminar.py).

### Emulate or avoid

Emulate:

- the conversation as the resumable user object;
- fenced conversation leases;
- explicit separation between a control plane and interchangeable agent
  backends;
- workspace backends as a first-class capability;
- an open protocol, ACP, for harness interchange.

Avoid:

- adopting its Python coding-agent core for a general personal agent product;
- treating local file persistence as distributed durability;
- exposing a dangerous unsandboxed host mode without strong product warnings
  and policy;
- assuming an interchangeable frontend means the backend semantics are
  interchangeable.

OpenHands is the best comparable if Oz becomes a coding-agent fleet or control
center. It is not the best default kernel for a general agent product.

## 3. Letta

### Primitive and authority

Letta makes the persistent agent identity primary. An agent has durable memory
and identity, conversations are threads belonging to that agent, and a session
is the active connection that sends messages, streams events, runs tools, and
handles approvals. The current
[Agent SDK README](https://github.com/letta-ai/letta-agent-sdk/blob/faf349663f090f94b2ac2fb2c47f44a7caf751b5/README.md)
states this hierarchy directly.

This is materially different from Osfo. Letta optimizes for an agent that
persists and changes across conversations. Osfo currently optimizes for
durable runs whose behavior is reconstructed from pinned records. If Oz's
product promise is "the same agent learns who I am and continues over time,"
Letta's primitive is closer to the product than `AgentRun`.

### Persistence and deployment

One TypeScript client targets three backends:

- Cloud, where Letta owns agent state and managed execution;
- local, where an SDK-managed App Server runs on the current computer;
- remote, where the user operates an App Server and computer.

The backend surface covers agents, conversations, messages, streaming, run
lookup, cancellation, and forking. Letta Code's local implementation stores
state and transcripts on disk, and uses git-versioned memory files. See
[`backend.ts`](https://github.com/letta-ai/letta-code/blob/5b852822ab3adbfc52f11af4550c6f574e43ef2c/src/backend/backend.ts)
and [`local-store.ts`](https://github.com/letta-ai/letta-code/blob/5b852822ab3adbfc52f11af4550c6f574e43ef2c/src/backend/local/local-store.ts).
The local queue is process-local, so the local backend should not be mistaken
for a distributed durable kernel.

### Sandboxes, providers, and traceability

Letta Code uses OS-level local permission controls, including Seatbelt on
macOS and bubblewrap on Linux, and can also execute through selected remote or
managed computers. The policy permits broader reads than writes and restricts
sensitive roots. See
[`policy.ts`](https://github.com/letta-ai/letta-code/blob/5b852822ab3adbfc52f11af4550c6f574e43ef2c/src/sandbox/policy.ts).

The local provider layer uses Pi and a registry spanning OpenAI, Anthropic,
OpenRouter, Google, Bedrock, and others. See
[`pi-provider-registry.ts`](https://github.com/letta-ai/letta-code/blob/5b852822ab3adbfc52f11af4550c6f574e43ef2c/src/backend/dev/pi-provider-registry.ts)
and
[`provider-turn-executor.ts`](https://github.com/letta-ai/letta-code/blob/5b852822ab3adbfc52f11af4550c6f574e43ef2c/src/backend/dev/provider-turn-executor.ts).

The current open source system provides transcripts, memory history, debug
statistics, and telemetry. See
[`telemetry/index.ts`](https://github.com/letta-ai/letta-code/blob/5b852822ab3adbfc52f11af4550c6f574e43ef2c/src/telemetry/index.ts).
The inspected current SDK does not demonstrate an OpenTelemetry-first fleet
trace comparable to Mastra or Flue. Claims from the legacy V1 server should
not be carried into the new architecture without current evidence.

### Emulate or avoid

Emulate:

- the separation of persistent agent, conversation, and live session;
- a single client surface across local, self-hosted, and managed backends;
- memory as a visible, inspectable product object;
- portable approval and device reconciliation controls.

Avoid:

- adopting memory-first semantics unless that is Oz's actual product;
- depending on behavior that exists only in Letta Cloud when self-hosting is a
  requirement;
- confusing a local transcript and git-backed memory with a distributed
  durable execution log;
- importing legacy V1 architecture into a current decision.

## 4. Mastra

### Primitive and authority

Mastra is a broad framework rather than one opinionated agent kernel. Its
major primitives are agents, memory resources and threads, workflows and
runs, tools, workspaces, traces, and scores. An agent owns an integrated model
and tool loop. Memory uses a `threadId` for the conversation and a `resourceId`
for the entity that owns memory. A workflow definition produces runs and
snapshots.

See the [agent overview](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/agents/overview.mdx),
[memory overview](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/memory/overview.mdx),
and [workflow overview](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/workflows/overview.mdx).

This breadth is useful, but it leaves the application responsible for deciding
which primitive is authoritative. An agent call, a memory thread, and a
workflow run do not automatically become one canonical ledger.

### Persistence and execution semantics

Mastra separates storage domains for memory, workflows, agents, scoring, and
observability. It supports multiple database backends. Workflow snapshots
capture step status, outputs, execution path, suspension metadata, and retry
state so a workflow can resume. See
[`snapshots.mdx`](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/workflows/snapshots.mdx).

Its built-in workflow engine can be replaced with managed Inngest or an
experimental Temporal runner. See
[`workflow-runners.mdx`](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/deployment/workflow-runners.mdx).
This is strong for long-running explicit workflows. The inspected sources do
not establish a Flue-like promise that each durably accepted conversational
message will receive one settlement after crashes.

### Sandboxes, providers, deployment, and traces

Mastra's workspace cleanly separates filesystem and sandbox capabilities and
supports local and remote providers such as E2B, Daytona, Vercel, and Modal.
See the [sandbox guide](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/workspace/sandbox.mdx)
and [`workspace.ts`](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/packages/core/src/workspace/workspace.ts).

The model router builds on AI SDK model versions, provider/model identifiers,
and model gateways. See
[`router.ts`](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/packages/core/src/llm/model/router.ts).
Deployment supports Node, Bun, Deno, Cloudflare, framework adapters, and hosted
Mastra. See the
[deployment overview](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/deployment/overview.mdx).

Observability is a first-class subsystem with traces, logs, metrics,
OpenTelemetry exporters, storage, and managed backends. See the
[observability overview](https://github.com/mastra-ai/mastra/blob/bab06b18923873a584bdfc71a6b4ec7fb4727fb7/docs/src/content/en/docs/observability/overview.mdx).

### Emulate or avoid

Emulate:

- separate memory, workflow, and observability storage domains;
- a workspace interface that composes filesystems and sandboxes;
- broad AI SDK based model routing;
- first-class traces and evaluation scores;
- pluggable workflow execution backends.

Avoid:

- adopting every Mastra primitive while retaining equivalent Osfo primitives;
- assuming workflow snapshots settle accepted conversational input;
- allowing agents, workflows, and memory threads to compete as product
  authority;
- choosing framework breadth when Oz needs one opinionated durable kernel.

Mastra is the strongest alternative if Oz values TypeScript breadth,
workflows, memory, and observability more than one strict conversation
durability contract.

## 5. LangGraph

### Primitive and authority

LangGraph's open source primitive is a checkpointed graph invocation. A
`thread_id` selects a sequence of checkpoints. In the broader API vocabulary,
an assistant is a versioned graph configuration, a thread holds state and
checkpoints, and a run executes an assistant on a thread. See the official
[SDK schemas](https://github.com/langchain-ai/langgraph/blob/fde3068970679184b68d3d068a92c83c966a4888/libs/sdk-py/langgraph_sdk/schema.py).

This makes a run important, but still subordinate to graph definition and
thread state. The authoritative recovery object is a state checkpoint, not an
immutable product event ledger.

### Persistence and replay semantics

Checkpointers save graph state by superstep. Pending writes retain completed
sibling results so successful work does not need to repeat after a failure.
Official adapters include SQLite, PostgreSQL, MongoDB, and Redis. See the
[checkpoint interface](https://github.com/langchain-ai/langgraph/blob/fde3068970679184b68d3d068a92c83c966a4888/libs/checkpoint/README.md)
and [PostgreSQL implementation](https://github.com/langchain-ai/langgraph/blob/fde3068970679184b68d3d068a92c83c966a4888/libs/checkpoint-postgres/README.md).

Durability can checkpoint synchronously before the next step, asynchronously
while the next step starts, or only when execution exits. Interrupt resumption
restarts the node, so side effects must be placed in checkpointed tasks or be
idempotent. The Functional API's tasks can checkpoint results and add retries
and timeouts. See
[`types.py`](https://github.com/langchain-ai/langgraph/blob/fde3068970679184b68d3d068a92c83c966a4888/libs/langgraph/langgraph/types.py)
and [`func/__init__.py`](https://github.com/langchain-ai/langgraph/blob/fde3068970679184b68d3d068a92c83c966a4888/libs/langgraph/langgraph/func/__init__.py).

### Deployment, providers, sandboxes, and traces

Provider abstraction comes from LangChain chat-model integrations, not the
graph kernel. Sandboxed code execution is also outside the core graph
contract. Deep Agents can add filesystem and subagent tools, but an execution
environment remains a separate integration.

LangGraph exposes streams and callbacks. LangSmith supplies the strongest
managed tracing and deployment story, which is a commercial service rather
than an intrinsic property of the open source checkpointer.

This distinction matters for build-versus-buy. The official open source
[`@langchain/langgraph-api`](https://github.com/langchain-ai/langgraphjs/blob/6ac60da74f6b9e29d20b111a7947ac3060f1d2dd/libs/langgraph-api/README.md)
describes itself as an in-memory implementation. The open source graph and
checkpoint libraries are substantial, but they do not by themselves remove
the need to build or buy distributed admission, scheduling, API serving,
fleet recovery, and tracing.

### Emulate or avoid

Emulate:

- checkpointed, explicit state transitions for graph-shaped work;
- pending writes that preserve successful parallel siblings;
- clear synchronous, asynchronous, and exit durability modes;
- tasks as the boundary around replay-sensitive side effects.

Avoid:

- using a graph for every ordinary conversation;
- treating checkpoint replay as an immutable business audit log;
- assuming LangSmith deployment and tracing are included in the open source
  runtime;
- adding LangGraph beneath an existing Osfo driver unless the graph itself
  becomes the one execution authority.

LangGraph is the best fifth comparable because it tests the opposite design
choice: explicit graph state rather than conversation-first execution. It is a
good fit for durable workflows and constrained agents, not the shortest route
to a general durable conversation service.

## The apparent Flue contradiction

The [2026-08-05 Flue report](./flue-agent-runtime-comparable-20260805.md)
concluded that Flue should not be an Osfo dependency or `AgentRuntime`
adapter. That evidence remains correct. Its recommendation answered this
question:

> Can Flue fit behind Osfo's accepted authority-free runtime seam while Osfo
> keeps canonical lifecycle ownership?

The answer is no. Flue's value comes from owning admission, conversation
records, the Pi model loop, tool calls, recovery, streaming, and settlement.
Removing those responsibilities leaves little useful Flue surface.

The present question is different:

> Should Oz adopt a mature harness as authority so the project stops rebuilding
> those responsibilities?

For that question, the same evidence points toward Flue.

| Choice                                                                                               | Runtime authority                                                     | What happens to Osfo                                                                                  | Honest consequence                                                       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Keep current [ADR 0002](../adr/0002-separate-osfo-semantics-from-agent-applications-and-adapters.md) | Osfo AgentRun driver and canonical ThreadEvents                       | Continue implementing provider intent, attempts, recovery, streaming, tools, fencing, and conformance | Osfo is an agent infrastructure platform, not merely the Oz application  |
| Adopt Flue                                                                                           | Flue conversation, submissions, canonical stream, and integrated loop | Retain only product concepts Flue does not own, or retire Osfo runtime packages                       | Oz moves faster but accepts Flue's semantics and dependency surface      |
| Hybrid double kernel                                                                                 | Both                                                                  | Translate and double-write two lifecycles                                                             | Rejected, conflicting recovery authority and maximum implementation cost |

If Flue is adopted, ADR 0002 must be superseded. It should not remain accepted
while implementation silently violates its central authority boundary.

## Recommended Oz architecture if Flue passes the prototype

```text
Oz product layer
  principals, authorization, triggers, UI, product metadata, business records
                         |
                         | maps product identity to agent/conversation identity
                         v
Flue runtime authority
  admission -> canonical conversation -> model/tool loop -> durable settlement
                         |
            +------------+-------------+
            |                          |
            v                          v
  model providers through Pi     sandbox provider
            |
            v
  Cloudflare Durable Object per conversation
  SQLite canonical records, wake and recovery

Separate workflow authority, only for long explicit processes
  Cloudflare Workflows, Inngest, Temporal, or another selected engine
```

Oz should continue to own:

- principal identity and authorization;
- product-specific agent configuration and policy;
- triggers, schedules, integrations, and user-visible metadata;
- UI projections and product analytics;
- business records whose meaning exists outside one agent conversation;
- mappings to Flue agent and conversation identifiers.

Flue should own:

- canonical conversation records;
- accepted submissions and their settlement;
- execution attempts and recovery;
- model and tool loop policy;
- streaming publication;
- provider-specific message behavior and compaction;
- conversation-scoped sandbox integration.

Oz should not recreate `AgentRun`, `ThreadEvent`, `ModelCall`, and `ToolCall`
records one-for-one beside Flue. If a product fact is needed for policy,
analytics, billing, or compliance, record that product fact by reference to a
Flue identity. Do not build a second replayable runtime ledger.

## Prototype and decision gate

Build one production-shaped vertical slice before rewriting the existing
packages. Use Flue's Cloudflare target and include:

1. one authenticated principal mapped to one agent conversation;
2. one direct user submission and one proactive scheduled submission;
3. streaming output that resumes after client disconnect;
4. one ordinary tool whose interrupted outcome is uncertain;
5. one durable tool using stable step records;
6. a conversation-scoped remote sandbox;
7. a provider switch between at least two supported vendors;
8. worker termination or redeploy during model streaming and during a tool;
9. reconstruction, durable settlement, and no duplicate visible output;
10. canonical product history plus operational traces.

The decision is binary after the slice:

- **Adopt Flue** if Oz's user-visible semantics survive these cases and the
  missing capabilities can live cleanly in the product layer. Supersede ADR
  0002 and stop building the duplicate Osfo runtime.
- **Keep Osfo** if the slice fails a documented product requirement that
  cannot be added outside Flue without competing authority. Record that
  requirement explicitly and accept the platform-building scope.

Do not reject Flue merely because it does not implement contracts that Osfo
invented for its own proposed platform. Reject it only when the difference
changes an Oz user outcome, security property, portability requirement, or
operating constraint.

## Final ranking

1. **Flue**, first choice for replacing the custom agent runtime. Its durable
   conversation and Cloudflare placement are closest to Oz's likely needs.
2. **Mastra**, first alternative when framework breadth, workflows, memory,
   AI SDK model routing, and observability matter more than a single strict
   submission-settlement contract.
3. **Letta**, first choice only if persistent evolving agent memory is Oz's
   defining product primitive.
4. **OpenHands**, first choice only if Oz is primarily a coding-agent control
   center or wants ACP-compatible backend interchange.
5. **LangGraph**, first choice for explicit graph and workflow execution, or
   when adopting managed LangSmith is acceptable. It is not the shortest
   conversation-first foundation.

The most important decision is not which SDK has the longest feature list. It
is which system is allowed to be authoritative. Selecting one authority is
what actually removes the wheel Osfo is currently rebuilding.

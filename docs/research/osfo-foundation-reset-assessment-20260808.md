# Osfo foundation reset assessment

Research date: 2026-08-08

Status: strategic assessment, not a new architecture decision

## Executive conclusion

The project should pause expansion of the custom Osfo execution platform.

The work completed so far is coherent, unusually well evidenced, and valuable.
It is not wasted. It established a strong reliability vocabulary and proved
several hard distributed-systems properties. The problem is that Osfo made
those properties its implementation responsibility before Oz proved its
product.

The result is a platform-first project:

```text
product hypothesis still forming
  -> custom conversation protocol
  -> custom durable run model
  -> custom admission and queue topology
  -> custom worker ownership and fencing
  -> custom provider protocol adapter
  -> custom workflow, tool, action, and sandbox contracts
  -> custom infrastructure and qualification system
```

This was a rational response to the original OpenPoke scale exercise and the
decision to make Osfo a portable semantic foundation. It is the wrong default
if the present goal is to ship Oz while learning how established agent
harnesses and managed platforms support a TypeScript agent product at scale.

The recommended next move is a harness-first reference slice using the
LangChain stack and managed Agent Server infrastructure. A Cloudflare-native
slice is the strongest alternative if the team is willing to adopt Durable
Objects and Workflows as the product's authority model. Flue is the most
interesting TypeScript-native durable harness and deserves a focused fit check,
especially on its Cloudflare target. OpenAI Agents SDK is a good harness but
does not remove enough runtime and operations work. OpenCode and OpenRouter are
useful lower-layer comparables, not complete foundations.

Do not decide PlanetScale yet. PlanetScale is a managed PostgreSQL choice, not
an application deployment or agent-runtime platform.

## Clarified destination constraints

Subsequent product grilling resolved constraints that change how the candidate
ranking must be interpreted:

- Oz is the product. Osfo is not a v1 agent-builder product.
- Osfo v1 may remain a TypeScript library around one selected harness. It may
  translate that harness into Effect and add reusable Oz-needed behavior, but
  it does not promise painless harness portability or duplicate the selected
  harness's runtime.
- Oz is also a deliberate engineering learning vehicle. The selected
  foundation should teach transferable, industry-relevant agent architecture
  without making Oz reimplement a generic harness or distributed runtime.
- Oz is TypeScript and Effect-based. The selected harness must have a credible
  TypeScript integration boundary. Python-first Hermes is explicitly excluded
  because its size, language, and ownership model conflict with that goal.
- Oz launches through WhatsApp and requires Apple Messages as its second
  channel. The project accepts early WhatsApp suspension risk, while durable
  user state must survive channel replacement.
- The first WhatsApp message creates a Provisional Oz Identity. Later email
  verification claims it as an Oz Account, and Stripe webhooks project paid
  entitlements.
- Each user has durable isolated identity, memory, files, skills, triggers, and
  connected accounts. Per-user compute is temporary and isolated; shared
  channel ingress and trigger dispatch remain continuously available.
- Cost is a first-class selection dimension across channels, models, storage,
  memory retrieval, sandboxes, workflow execution, observability, and owned
  operational gaps.

The Osfo library contract is provisional until the winning harness prototype
shows whether the module has real depth. If removing `@osfo/agent` would spread
Effect translation, product context injection, tracing normalization, and
policy across callers, the module earns its place. If it would remove only
forwarding code, Oz should integrate the harness directly and extract Osfo only
after repeated behavior appears.

## Scope and evidence

This assessment reviewed:

- both closed Wayfinder maps and their 51 Wayfinder-labelled issues;
- all 94 repository issues, including the 21 open implementation and
  qualification issues;
- the 56 merged pull requests and 212 commits on `main`;
- the accepted v1 architecture, ADRs, domain glossary, and current production
  delivery issue;
- the PostgreSQL dispatch, AgentRun lifecycle, and Pub/Sub worker prototypes;
- the current TypeScript implementation, package graph, GCP infrastructure,
  demo, and evidence catalog;
- the existing Executor, OpenCode, Restate, Rig, OpenAI, graph-flow, and Flue
  comparable studies;
- current primary-source research on LangChain, Deep Agents, LangGraph,
  LangSmith Deployment, Cloudflare Agents, Cloudflare Workflows, OpenAI Agents
  SDK, OpenCode, OpenRouter, Flue, Mastra, Letta, OpenHands, GCP, Temporal, and
  PlanetScale.

The two closed maps remain the best low-resolution record:

- [Wayfinder: Osfo v1 scalable agent primitives](https://github.com/heyimcarlos/osfo/issues/1)
- [Wayfinder: Select the AgentRun dispatch topology](https://github.com/heyimcarlos/osfo/issues/25)

The current implementation authority is
[Deliver production Osfo v1 and the Oz reference application](https://github.com/heyimcarlos/osfo/issues/149).

## Terminology correction

The current glossary uses **Adapter** for external conversation integrations
and **Model Adapter** for OpenRouter, OpenAI, Anthropic, or another model
protocol. The new question uses "adapter" for model providers. A new decision
map should keep these categories distinct:

| Category                  | Examples                                              | What it replaces                                      |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Model provider or gateway | OpenAI, Anthropic, OpenRouter                         | Model access and routing                              |
| Agent harness             | Deep Agents, OpenAI Agents SDK, Flue, Mastra          | Model and tool loop, subagents, context behavior      |
| Durable agent runtime     | LangGraph, Agent Server, Flue runtime                 | Checkpoints, threads, runs, waits, recovery           |
| Application platform      | LangSmith Deployment, Cloudflare Agents and Workflows | Hosting, state placement, queues, scaling, operations |
| Messaging Adapter         | Telegram, WhatsApp, SMS                               | External conversation transport                       |
| Agent Application         | Oz                                                    | Product policy, identity, tools, user experience      |

OpenRouter is not an agent SDK in this comparison. PlanetScale is not an
application platform. Treating either as one would leave the hard runtime work
inside Osfo.

## What the project actually built

### Decision and domain system

The first Wayfinder turned a vague reliable-agent platform idea into a precise
domain model. It defined Thread, ThreadEvent, ThreadCursor, AgentRun,
ModelCall, ToolCall, Action, WorkflowInstance, Child AgentRun, RunCode,
artifacts, approvals, fences, retries, and uncertainty. It also separated Osfo
from Oz and from provider-specific integrations.

The durable result is documented in:

- [`CONTEXT.md`](../../CONTEXT.md)
- [`docs/specs/osfo-v1.md`](../specs/osfo-v1.md)
- [`ADR 0001`](../adr/0001-use-transactional-outbox-pubsub-delivery.md)
- [`ADR 0002`](../adr/0002-separate-osfo-semantics-from-agent-applications-and-adapters.md)

### Prototype program

The prototypes answered real questions rather than merely demonstrating happy
paths:

1. The PostgreSQL dispatch prototype exercised open arrivals, fairness,
   fencing, overload, worker loss, and recovery.
2. The AgentRun lifecycle prototype exercised Cloud SQL, Temporal Cloud,
   model providers, tools, approval, sandbox execution, artifacts, process
   loss, load, and evidence capture.
3. The Pub/Sub worker-seam program compared push and StreamingPull,
   direct dual-write and transactional outbox, relay fairness, flow control,
   activation latency, and failure recovery.
4. The second dispatch Wayfinder rejected direct dual-write and selected an
   append-oriented transactional outbox, Pub/Sub, StreamingPull workers, point
   claims, leases, and monotonic fences.

These are strong controls for judging another platform. They should be retained
as evidence, not carried forward as mandatory architecture.

### Production-shaped implementation

The TypeScript workspace now contains about 16,400 lines of production source
and about 17,700 lines of tests. It includes:

- durable message admission and immutable receipts;
- canonical Thread events, snapshots, history, signed cursors, and replay to
  live SSE;
- a deterministic Agent Runtime proposal interface;
- AgentRun claims, leases, cancellation, attempt fencing, and recovery;
- bounded admission and Principal-first outbox publication;
- an outbox relay and ordered StreamingPull worker fleet;
- a hand-written OpenRouter Chat Completions streaming adapter;
- durable non-Action ToolCalls and Action approval and reconciliation code;
- a three-tab browser reference journey;
- pinned Terraform, least-authority runtime identities, private networking,
  evidence capture, and development deployment;
- a sealed OpenPoke demo and qualification cockpit.

The generic Agent Runtime itself is only about 100 lines. Most of the project
is the durability, transport, scheduling, provider normalization, deployment,
and evidence substrate around it.

### What is still unfinished

The current umbrella issue still requires OIDC, Child AgentRuns, awaited and
detached workflows, RunCode, context compaction, snapshots, a complete
conformance corpus, production deployment, target and failure qualification,
retained-corpus qualification, cost proof, and aggregate multi-device load.

Production qualification is explicitly `MISSING`. The final `us-east4`
admission matrix failed at the assumed 232 incoming messages per second target.
The target itself comes from an exercise model of 100,000 daily active users,
20 messages per user per day, and a 10x peak factor, not observed Oz demand.

The tracker is also slightly behind the code. ToolCall and Action slices have
merged, while their umbrella issues remain open. That is another signal to stop
and reconcile before continuing the implementation frontier.

## Current repository health

The branch was checked without modifying source:

| Gate                   | Result  | Evidence                                                              |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `bun run format:check` | PASS    | 248 files matched                                                     |
| `bun run lint`         | PASS    | 0 warnings and 0 errors                                               |
| `bun run typecheck`    | FAIL    | root scripts import missing `@osfo/db` and `@osfo/db/testing` exports |
| `bun run test`         | FAIL    | observability catalog expected 759 prototype files but found 397      |
| `bun run db:verify`    | MISSING | not run after the earlier gates failed                                |

The current `main` branch is therefore not merge-ready even before the
strategic reset. These failures should be preserved as known baseline facts,
not repaired as part of the architecture decision.

## What was done well

### Correct separation of authority

The project consistently distinguished durable authority from delivery,
notifications, provider streams, worker processes, and dashboards. The
transactional outbox, fenced claims, persist-before-delivery rule, and explicit
unknown outcomes are sound distributed-systems patterns.

### Honest evidence

The project reports `PASS`, `FAIL`, and `MISSING` separately. It does not turn
development evidence into production qualification. The final admission
failure is preserved rather than hidden.

### Product-safe external effects

The Action model recognizes that approval, authorization, dispatch, and
outcome certainty are separate. This is product-relevant knowledge that most
agent harnesses do not completely solve.

### Reusable test scenarios

Multi-device resume, worker loss, duplicate delivery, relay failure, retained
history, provider uncertainty, and sandbox export are useful acceptance
scenarios for any future foundation.

## Where the project overreached

### It optimized a platform before validating the product

In six days the repository accumulated 94 issues, 56 merged pull requests, 212
commits, two architecture maps, three major prototype programs, a production
IaC topology, and an extensive qualification framework. Oz still does not have
its final product identity, onboarding, tools, workflows, or observed workload.

The platform work was driven by the 100,000 DAU exercise and reliability
ambition, not by product usage. This is premature optimization at the system
boundary, even though the individual engineering decisions are careful.

### The original seam forced reinvention

The architecture required the Agent Runtime to propose one step without doing
I/O, while Osfo recorded every operation before an executor could run. This is
a strong authority model, but most agent harnesses intentionally own the
model-tool loop. Making them fit behind that seam either fails or reduces them
to provider libraries.

The old question was:

> Which library can fit inside Osfo's authority model?

The new question should be:

> Which mature runtime can become authority, and which small set of Oz product
> contracts must remain outside it?

That change is what unlocks meaningful deletion.

### Reliability became the product by accident

The current architecture treats canonical events, receipts, cursors, run
attempts, outbox obligations, publication fairness, workflow identities, and
evidence manifests as stable product-independent semantics. Some are valuable.
Many are implementation details that an adopted runtime should own.

### Managed primitives did not reduce platform ownership

Cloud Run, Pub/Sub, Cloud SQL, and Temporal Cloud are managed services, but they
are low-level services. Osfo still owns the run server, queue handoff, worker
fleet, recovery rules, provider adapter, event protocol, scaling policy, and
most operations. Managed infrastructure is not the same as a managed agent
platform.

## The right product primitive

`AgentRun` should not be the top-level product primitive.

For an Oz-style conversational product, the durable user-facing aggregate is a
Thread or Task owned by an Agent Definition and optionally a Workspace:

```text
Agent Definition and version
  -> Thread or Task
       -> messages and durable product events
       -> approval state
       -> artifacts and workspace references
       -> zero or more runtime runs and attempts
```

A run is an execution occurrence. It can pause, retry, resume, or be replaced.
It matters for tracing and operations, but it should not dictate the product's
entire topology.

If Osfo remains an agent-builder product, its primary product entity should be
an **Agent Definition** with versioned configuration, models, tools, policies,
and deployment selection. If Oz remains a single long-lived personal agent,
its primary entity is a **Thread** or **Agent instance**. The new Wayfinder must
settle which product is actually being built before selecting infrastructure.

## Comparable ranking

Scores use domain fit, TypeScript fit, production maturity, architecture
clarity, infrastructure relevance, testing quality, and documentation signal.
The score answers "how much useful platform can this remove for Oz?", not
general framework quality.

| Rank | Candidate                                          | Score | Best use                                                                                                            | Critical mismatch                                                                  |
| ---: | -------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
|    1 | Deep Agents or LangGraph plus managed Agent Server | 32/35 | Delegate harness, threads, runs, checkpoints, queues, deployment, tracing, and evals                                | Commercial platform dependency and opinionated graph semantics                     |
|    2 | Cloudflare Agents plus Workflows                   | 30/35 | Collapse stateful session compute, real-time transport, scheduling, and durable work                                | Full Cloudflare authority and data-model lock-in, not a complete harness by itself |
|    3 | Flue, especially on Cloudflare                     | 29/35 | TypeScript-native durable conversations, accepted submissions, streaming, recovery, tools, and provider portability | Young project, concentrated runtime, and deployment ownership constraints          |
|    4 | Mastra                                             | 27/35 | Broad TypeScript agent, workflow, storage, workspace, and observability framework                                   | Several overlapping primitives and a less explicit accepted-work contract          |
|    5 | OpenAI Agents SDK                                  | 24/35 | Small, high-quality loop, tools, handoffs, approvals, and tracing                                                   | Does not supply a durable multi-tenant agent server or deployment platform         |
|    6 | OpenCode SDK                                       | 19/35 | Provider normalization and coding-agent patterns                                                                    | Coding-product specialization and process-local coordination                       |
|    7 | OpenRouter SDK or API                              | 12/35 | Provider gateway and routing                                                                                        | Model access only, no agent lifecycle or platform                                  |

The detailed source work lives in:

- [Managed agent deployment foundations](managed-agent-deployment-foundations-20260808.md)
- [Cloudflare foundation assessment](cloudflare-agent-foundation-20260808.md)
- [Existing agent harness foundations](oz-existing-agent-harness-foundations-20260808.md)
- [Agent harness architecture comparables](agent-harness-architecture-comparables-20260808.md)
- [Existing Osfo agent-platform comparables](osfo-agent-platform-comparables-20260807.md)
- [Existing Flue comparable](flue-agent-runtime-comparable-20260805.md)

The studies expose a real trade-off rather than one unanimous winner. The
architecture-comparable study ranks Flue as the closest technical replacement
for Osfo's durable conversation runtime. The deployment study ranks managed
Agent Server as the largest reduction in infrastructure and operations. This
assessment puts the managed LangChain slice first because it tests an
established harness and delegates the most generic platform work. Flue on
Cloudflare becomes the strongest first choice if TypeScript-native durable
conversation semantics and control over the harness matter more than maximum
operational delegation. The new Wayfinder must rescore both against Effect
integration, learning value, and total cost before selection.

## Candidate conclusions

### Deep Agents, LangGraph, and LangSmith

This is the leading first experiment because it removes the most layers at
once. Deep Agents provides an opinionated harness. LangGraph provides durable
checkpointed execution and arbitrary interrupts. Agent Server provides
assistants, threads, runs, crons, persistence, queues, streaming, and worker
recovery. LangSmith Deployment operates the platform and adds traceability and
evaluation.

The experiment must use native assistant, thread, and run concepts. Wrapping
the platform with every existing Osfo object would preserve complexity rather
than test deletion.

Current product naming needs care. LangGraph is the open-source runtime,
LangSmith Deployment is the managed Agent Server platform, and current Deep
Agents hosting may be offered through Managed Deep Agents rather than as a
plain LangSmith Deployment target. The prototype must validate the exact
commercial product and data-region fit.

### Cloudflare Agents and Workflows

Cloudflare is credible, but it answers a different question. Each Agent is a
globally addressable Durable Object with SQLite, serialized execution, RPC,
WebSockets, scheduling, and hibernation. Workflows provide durable steps,
retries, sleeps, and external-event waits.

This can replace much of the current transport, queue, worker, state-placement,
and workflow topology. It also moves product authority into Cloudflare's
object identity and storage model. It should be selected only if that coupling
is acceptable and product queries, export, regional data, action safety, and
agent-harness behavior pass a focused prototype.

Cloudflare Agents alone does not prevent another round of harness
implementation. Pair it with an established harness such as Flue,
`@cloudflare/think`, or another evaluated loop.

### Flue

Flue now provides a much closer version of what Osfo tried to build: durable
addressable conversations, accepted submissions, one durable settlement,
append-only conversation records, recovery, partial-output handling, tools,
subagents, provider routing, and Node and Cloudflare targets.

The existing Flue study rejected fitting Flue behind Osfo's pure next-step
proposal seam. That conclusion remains correct for the old seam. It does not
answer the new question of making Flue the authority and deleting Osfo's
competing lifecycle. Flue's youth, large integrated session implementation,
test evidence, and active-active ownership model remain material risks.

### OpenAI Agents SDK

The SDK has strong agents, tools, handoffs, guardrails, approvals, sessions,
tracing, and emerging sandbox support. It can replace the model-tool loop. It
does not operate durable multi-tenant queueing, general crash recovery,
scheduling, application workers, or deployment. Choosing it would preserve a
large part of the current Osfo substrate.

Use it if Oz deliberately becomes OpenAI-first and bounded, or if the team
wants to keep application lifecycle ownership. Do not choose it to achieve the
largest reduction in custom platform code.

### OpenCode and OpenRouter

OpenCode is a strong source for provider normalization, streamed turns, tool
registries, and coding-agent behavior. Its coordinator is not the general
durable multi-tenant platform Oz needs.

OpenRouter gives provider access and routing. It can sit beneath almost any
harness. It cannot own agents, threads, tools, recovery, deployment, or product
semantics.

### PlanetScale

PlanetScale can replace Cloud SQL if Osfo still owns PostgreSQL authority. It
delegates cluster operations, HA, backups, failover, pooling, and database
observability. It does not replace application compute, Pub/Sub, Temporal,
Agent Server, or the custom lifecycle.

Its transaction-pooled PgBouncer does not support the current
`LISTEN/NOTIFY` and session-advisory-lock use. Direct connections or topology
changes would still be needed. Decide it only after the harness and platform
decision.

## Recommended architecture direction

The recommended target is deliberately smaller:

```text
Oz product
  owns identity, authorization, Agent Definitions, product policy,
  approvals for external effects, entitlements, UI, and product events
      |
      v
adopted agent platform
  owns thread and run execution, checkpoints, tool loop, subagents,
  queueing, streaming, worker recovery, tracing, and evaluation
      |
      v
model and tool providers
  OpenRouter, OpenAI, Anthropic, MCP, sandbox provider
```

Osfo should initially be a thin product contract library, or disappear as a
separate reusable layer until a second Agent Application proves that reuse is
real. Oz should not be forced to demonstrate a hypothetical platform.

Keep only contracts that are clearly product differentiators:

- tenant identity and authorization;
- versioned Agent Definition and product policy;
- exact external Action intent, approval, and user-facing receipt;
- product-visible Thread or Task events when the selected platform's native
  stream is insufficient;
- artifact ownership and access;
- billing, entitlements, abuse controls, and user experience.

Delegate by default:

- model and tool loop;
- provider normalization where the harness already supports it;
- context management and compaction;
- subagent orchestration;
- run checkpoints, waits, retries, and recovery;
- run queue and workers;
- run tracing and evaluation;
- deployment and scaling of the agent runtime.

## Migration approach

### 1. Freeze the current frontier

Pause feature work on the custom AgentRun platform. Continue only security,
data-preservation, and comparison-enabling fixes. Do not add another queue,
autoscaler, scheduler, database optimization, provider adapter, or production
qualification lane before the foundation comparison.

### 2. Preserve the current implementation as a control

Do not delete it during evaluation. Tag the current source, record the known
gate failures, and keep the sealed evidence. The control supplies scenarios
and a cost and complexity baseline.

### 3. Build one native LangChain managed slice

Use native Agent Definition or assistant, thread, run, checkpoint, interrupt,
tool, and trace concepts. Prove:

```text
login
  -> one Thread
  -> streamed model turn
  -> ordinary tool
  -> externally effectful Action requiring approval
  -> forced worker interruption and resume
  -> trace and evaluation inspection
```

Measure owned code, platform configuration, failure behavior, latency, cost,
provider portability, and semantic gaps. Do not seek API parity.

### 4. Build a Cloudflare slice only as an independent replatform test

Use one Durable Object Agent as the aggregate and one Workflow for durable
background work. Test WebSocket or SSE delivery, hibernation, concurrent
messages, action idempotency, approval waits, state export, and regional data
requirements. Use an existing harness rather than writing another loop.

### 5. Run a Flue fit check

This can be smaller than the two platform slices. Confirm whether Flue's
accepted-submission, recovery, action, provider, and Cloudflare deployment
contracts can satisfy the same journey without retaining Osfo's competing run
authority.

### 6. Choose by deletion, not feature count

The winner is the option that lets the project delete the most undifferentiated
code while preserving the product's indispensable behavior. Score:

- product behavior and iteration speed;
- lines and modules Oz still owns;
- operational roles and failure modes;
- durable recovery and action uncertainty;
- trace and evaluation quality;
- provider and sandbox portability;
- data export and lock-in;
- latency and cost at an observed, modest workload;
- security and multi-tenancy.

### 7. Reconcile the tracker after selection

Close or supersede implementation issues whose responsibility moves to the
selected platform. Reframe retained issues around product behavior, not
internal Osfo parity. Write a new ADR only after the prototype produces a real
trade-off decision.

## Proposed Wayfinder frontier

The architecture reset is large enough for a new Wayfinder map. Its proposed
destination is:

> Select and document the smallest credible foundation for Oz that delegates
> generic agent execution and operations, identifies the product contracts Oz
> must retain, and leaves no unresolved structural decision before a focused
> product implementation plan.

The first decision tickets should be:

1. Define whether the destination is an Oz product or an Osfo agent-builder
   platform.
2. Define the product aggregate: Agent Definition, Agent instance, Thread, or
   Task.
3. Prototype the native LangChain managed journey.
4. Prototype the Cloudflare Agent and Workflow journey if Cloudflare authority
   remains acceptable.
5. Test Flue as the durable harness authority.
6. Decide which external Action and approval guarantees are indispensable.
7. Select the foundation and record the deletion boundary.
8. Reconcile the existing implementation and qualification ticket graph.

Per the Wayfinder workflow, the map should be created only after the human
confirms its destination. The first two tickets are human decisions. The
platform comparisons and prototypes cannot decide whether Oz or an agent
builder is the intended product.

## Final recommendation

Stop building Osfo as a general agent platform from infrastructure primitives.

Use the current implementation as evidence and a control. Start with one
managed LangChain reference slice because it tests the largest credible
delegation of harness, runtime, queues, deployment, tracing, and evaluation.
Keep Cloudflare as a separate, more opinionated platform candidate. Test Flue
as the strongest TypeScript-native durable harness. Do not let OpenRouter,
PlanetScale, or the OpenAI Agents SDK appear to remove layers they do not own.

The next decision is not a technical vendor choice. It is whether the project
is primarily:

1. Oz, a product built on an existing agent platform, or
2. Osfo, a reusable agent-builder platform whose platform semantics are the
   product.

The recommendation is option 1. Learn an established harness by building Oz.
Reconsider extracting Osfo only after a second real application proves which
semantics are genuinely reusable.

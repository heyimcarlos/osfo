# Managed agent deployment foundations for Osfo and Oz

Research date: 2026-08-08  
Status: primary-source comparison  
Scope: LangSmith Deployment, Cloudflare Agents and Workflows at a high level,
the accepted GCP Cloud Run, Pub/Sub, and Temporal Cloud topology, and
PlanetScale Postgres as a database substitution.

## Executive finding

These products do not compete at one layer.

```text
agent application and product semantics
  -> agent harness and run API
  -> durable workflow and queueing
  -> application compute
  -> database
```

- **LangSmith Deployment** is the closest option to delegating an agent
  application platform. Its managed Cloud option operates Agent Servers,
  persistence, task queues, deployment infrastructure, CI/CD, observability,
  and evaluation. It is the strongest candidate for a deliberately small Oz
  reference implementation whose purpose is to stop building infrastructure
  and learn the product.
- **Cloudflare Agents plus Workflows** is a broader application replatform, not
  a drop-in open-source agent harness. It delegates globally distributed
  session compute, per-agent durable state, real-time connections, scheduling,
  and durable multi-step execution, but Oz still supplies the agent behavior,
  policy, authorization, and external-effect semantics.
- **The current GCP topology** combines managed infrastructure primitives. It
  does not provide a managed agent application. Cloud Run operates containers,
  Pub/Sub buffers delivery, and Temporal Cloud operates the Temporal Service,
  while Osfo still owns its agent loop, run persistence, outbox, workers,
  reconciliation, scaling policy, and product semantics.
- **PlanetScale Postgres** is a managed database. It can replace Cloud SQL and
  delegate PostgreSQL cluster operations, but it cannot replace Cloud Run,
  Pub/Sub, Temporal, LangGraph, an agent harness, or Osfo's lifecycle code.

The practical recommendation is to run a bounded **LangSmith Cloud reference
slice** before approving more custom Osfo runtime work. Keep the present GCP
implementation as comparison evidence, not as an assumed production
foundation. Study Cloudflare as a separate full-stack replatform. Evaluate
PlanetScale only in a database decision after the agent-platform direction is
chosen.

## Category map

| Candidate                                  | Product category                                         | It can operate                                                                                                            | It does not decide for Oz                                                                                          |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| LangSmith Cloud with Agent Server          | Managed agent deployment platform                        | Agent Server compute, built-in Postgres persistence, task queue, deployment infrastructure, CI/CD, tracing and evaluation | Product identity, authorization, prompts, tools, model selection, action safety, user-visible event semantics      |
| LangSmith Hybrid                           | Managed control plane plus customer-operated data plane  | LangSmith UI, APIs, deployment orchestration, observability storage                                                       | Kubernetes data plane, Agent Servers, Postgres, Redis, networking, application behavior                            |
| Standalone Agent Server                    | Self-hosted agent application server                     | Standard assistants, threads, runs, crons, persistence, and queue API                                                     | Hosting, load balancing, database, operational control plane, product behavior                                     |
| Cloudflare Agents plus Workflows           | Managed edge application runtime plus durable execution  | Durable Object compute and storage, routing, WebSockets, scheduling, durable workflow steps, retries, waits               | Agent design, product contracts, tool and action correctness, cross-system semantic authority                      |
| Cloud Run plus Pub/Sub plus Temporal Cloud | Managed compute, broker, and workflow-service primitives | Containers, message delivery, Temporal history and task coordination                                                      | Agent harness, AgentRun authority, outbox, worker implementation, application autoscaling policy, product behavior |
| PlanetScale Postgres                       | Managed PostgreSQL database                              | Cluster deployment, replication, failover, backups, pooling, database metrics                                             | Application compute, queue consumer, agent or workflow execution, lifecycle schema and queries                     |

This category separation matters because replacing Cloud SQL with PlanetScale
does not reduce the amount of agent-runtime code. Replacing an Osfo worker with
an Agent Server or Cloudflare Agent can.

## What Osfo currently owns

The accepted topology commits a receipt, canonical Thread facts, AgentRuns,
capacity reservations, and outbox obligations in PostgreSQL. A relay publishes
minimal identities to one ordered Pub/Sub subscription. A fixed StreamingPull
fleet point-claims AgentRuns, executes under a lease and monotonic epoch, then
commits a fenced outcome before acknowledgement. PostgreSQL remains lifecycle
authority and Pub/Sub remains the delivery buffer.
([ADR 0001](../adr/0001-use-transactional-outbox-pubsub-delivery.md),
[v1 deployment contract](../specs/osfo-v1.md#deployment-contract))

Temporal is presently a narrower boundary. Temporal owns a
`WorkflowInstance`'s internal execution history, while Osfo owns its identity,
start intent, AgentRun and Thread correlation, typed outcome, and canonical
promotion. Temporal cannot write AgentRun state or ThreadEvents directly.
([workflow boundary](../specs/osfo-v1.md#tool-action-workflow-and-sandbox-boundaries),
[domain definition](../../CONTEXT.md#workflowinstance))

This is coherent and explicit, but it means Osfo operates an agent platform on
top of lower-level services. The accepted ADR records successful correctness
and recovery evidence, but full `us-east4` production qualification remains
missing after admission failed in the final matrix. That evidence supports
keeping this implementation as a control. It does not support assuming that
more custom topology work is the fastest path to the product.
([ADR 0001 evidence](../adr/0001-use-transactional-outbox-pubsub-delivery.md#evidence))

## LangSmith Deployment and Agent Server

### Current official naming

The current product name is **LangSmith Deployment**. LangChain announced the
rename from **LangGraph Platform** in October 2025. Its runtime is **Agent
Server**, and current documentation says that Agent Server exposes APIs for
assistants, threads, runs, cron jobs, and a persistent store. The older name
still appears in Kubernetes resource names and older material, but LangChain
deprecated the `langgraphPlatform` configuration key in self-hosted LangSmith
after version 0.12.0 in favor of `config.deployment`.
([official rename](https://changelog.langchain.com/announcements/langsmith-self-hosted-v0-12),
[Agent Server](https://docs.langchain.com/langsmith/agent-server),
[enable LangSmith Deployment](https://docs.langchain.com/langsmith/deploy-self-hosted-full-platform))

The useful vocabulary is therefore:

```text
LangGraph or LangChain application code
  -> Agent Server runtime and API
  -> LangSmith Deployment hosting and control plane
  -> LangSmith observability and evaluation
```

Calling the whole system "LangGraph Platform" obscures which parts are an
open-source graph library, an application server, and a managed product.
Current LangChain documentation also calls Deployment framework-agnostic, but
non-LangGraph frameworks are adapted through the LangGraph Functional API or a
wrapper SDK. It is not a neutral container host for an unchanged arbitrary
harness. Current code-first Deep Agents documentation points to the separate
**Managed Deep Agents** offering.
([LangSmith Deployment overview](https://docs.langchain.com/langsmith/deployment))

### What Cloud delegates

LangSmith Cloud is fully managed. LangChain operates the platform, Agent
Servers, application infrastructure, updates, scaling, maintenance, and CI/CD.
The deployment can be connected to GitHub or built and deployed with the
LangGraph CLI. Production deployments include managed highly available storage
and automatic backups. The product also combines deployment management with
LangSmith tracing, evaluation, and Studio.
([Cloud architecture](https://docs.langchain.com/langsmith/cloud),
[deploy on Cloud](https://docs.langchain.com/langsmith/deploy-to-cloud))

Agent Server is materially closer to Osfo than a model SDK. It deploys one or
more graphs with Postgres persistence and a task queue. Run data is stored in
Postgres. Its API surface already has assistants, threads, thread runs,
stateless runs, crons, and long-term store endpoints. The runtime can separate
API and queue-worker tiers and can recover in-progress runs after a missed
heartbeat. Durable data is stored in Postgres, while Redis carries ephemeral
coordination and streaming data.
([Agent Server architecture](https://docs.langchain.com/langsmith/agent-server),
[Agent Server API](https://docs.langchain.com/langsmith/server-api-ref),
[scalability and resilience](https://docs.langchain.com/langsmith/scalability-and-resilience))

This is the largest credible reduction in owned Osfo infrastructure among the
compared options. A reference Oz implementation could delegate the generic
assistant, thread, run, persistence, queue, deployment, and trace surfaces and
retain only the product-specific parts.

The standalone documentation describes the PostgreSQL-backed run queue as
exactly once. That is not a promise that an arbitrary external tool side effect
will occur exactly once. Oz still needs idempotency or reconciliation wherever
a remote effect can succeed before its result is durably recorded.
([standalone Agent Server](https://docs.langchain.com/langsmith/deploy-standalone-server))

### What Hybrid and self-hosting do not delegate

LangSmith supports Cloud, Hybrid, and Self-hosted modes. Hybrid keeps the
control plane and observability data in LangChain's cloud, but the customer
operates a Kubernetes data plane containing listeners, Agent Servers,
Postgres, Redis, and agent workloads. Full self-hosting puts the complete stack
in the customer's infrastructure. Both are Enterprise offerings.
([platform setup comparison](https://docs.langchain.com/langsmith/platform-setup),
[Hybrid architecture](https://docs.langchain.com/langsmith/hybrid))

A standalone Agent Server can also run without the LangSmith control plane and
is documented as production-ready, but the customer owns its deployment, load
balancer, backing services, and operations. Standalone therefore reduces
agent-server implementation, not infrastructure operations. Current production
guidance uses Kubernetes and warns against scale-to-zero serverless hosting
because queued work and scale-up reliability can fail.
([standalone Agent Server](https://docs.langchain.com/langsmith/deploy-standalone-server))

If the goal is to stop operating infrastructure and learn the product, Cloud
is the informative LangSmith comparison. Choosing Hybrid or full self-hosting
at this stage would retain much of the operational work the project is trying
to avoid.

### What Oz would still own

Managed Agent Server does not supply Oz's product definition. Oz must still
choose and constrain:

- authentication, tenant and principal identity, authorization, and quotas;
- prompts, model providers, tools, subagent topology, and user experience;
- approval and uncertain-outcome handling for externally effectful Actions;
- the mapping between Agent Server threads and the product's user-facing
  conversations;
- retention, data classification, export, billing, abuse controls, and support
  behavior.

Adopting Agent Server also means deciding whether its assistants, threads, and
runs become product authority or remain behind an Oz translation boundary. A
thin translation that preserves every existing Osfo semantic object can erase
most of the simplification. The reference slice should test how much product
truth can safely be delegated, not reproduce the current architecture inside a
managed container.

## Cloudflare at the correct level

Cloudflare's Agents SDK is a stateful application runtime built on Durable
Objects. Each Agent instance has a durable identity, local SQLite storage,
single-threaded execution, RPC and WebSocket connections, state broadcasting,
and scheduling. Scaling comes from sharding across many independently
addressed Agent instances rather than increasing concurrency inside one
instance.
([Agents overview](https://developers.cloudflare.com/agents/),
[Agent class internals](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/),
[Durable Object scaling pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/))

Cloudflare Workflows is a separate durable-execution product. A Workflow
persists the result of each `step.do`, retries failed steps, sleeps, and waits
for external events. Waiting instances do not count toward active concurrency,
and external event waits can be configured for up to 365 days. Workflows has
its own step, storage, concurrency, retention, and creation-rate limits, so it
should be evaluated as a durable execution contract rather than assumed to be
unbounded.
([Workflows overview](https://developers.cloudflare.com/workflows/),
[workflow guide](https://developers.cloudflare.com/workflows/get-started/guide/),
[workflow limits](https://developers.cloudflare.com/workflows/reference/limits/),
[external events](https://developers.cloudflare.com/workflows/build/events-and-parameters/))

Together these services can replace a large part of the current GCP runtime:

```text
Cloudflare Agent Durable Object
  -> durable session identity and local SQL
  -> real-time client connection and scheduling
  -> optional Cloudflare Workflow for multi-step durable work
  -> external models and tools
```

They do not amount to taking an existing open-source agent harness and putting
it on a neutral host. The application adopts Cloudflare's identity, storage,
execution, and deployment model. That can be a good simplification, but it is
a replatform decision with a different consistency and data model, not a
Cloud Run hosting substitution. A dedicated Cloudflare study should test one
complete Oz journey, including session identity, concurrent messages,
streaming, approval, recovery, action idempotency, export, and regional data
requirements.

## The current GCP and Temporal foundation

Cloud Run is a fully managed container platform, but its resource types are
still generic compute. Services autoscale on requests and can scale to zero.
Worker pools run continuous pull-based processes, have no load-balanced URL,
and do not natively autoscale. A worker-pool subscriber therefore needs a fixed
instance count or a separately operated autoscaler.
([Cloud Run resource types](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run),
[worker-pool deployment](https://docs.cloud.google.com/run/docs/deploy-worker-pools),
[autoscaling from zero](https://docs.cloud.google.com/run/docs/about-instance-autoscaling))

Pub/Sub delegates durable message delivery, flow control, and redelivery, but
not application authority. Google recommends the high-level asynchronous
StreamingPull client for pull subscribers. Ordering is per key, and the normal
contract remains at-least-once. Pull subscriptions can enable regional
exactly-once delivery, but the subscriber still has to persist processing
progress until acknowledgement succeeds. This does not eliminate Osfo's need
for idempotent, fenced application outcomes.
([pull subscriptions](https://docs.cloud.google.com/pubsub/docs/pull),
[message ordering](https://docs.cloud.google.com/pubsub/docs/ordering),
[exactly-once delivery](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery))

Temporal Cloud delegates operation of the Temporal Service, including its
persistence, availability, and scaling. Workflow and Activity code still runs
in customer-operated Workers. Temporal explicitly describes this boundary as
"your code runs in your environment." Temporal Cloud therefore removes a hard
durable-execution service, but it does not host the agent application or erase
worker deployment and versioning work.
([Temporal Cloud](https://temporal.io/cloud))

The current stack is best when Osfo's exact lifecycle, action, event, and
deployment semantics are themselves the product and must remain portable. It
is the weakest choice when the immediate goal is to learn what Oz should be,
because every generic platform layer remains an Osfo design and operations
problem.

## PlanetScale Postgres is a database decision

PlanetScale Postgres is a fully managed PostgreSQL-compatible database. Its HA
architecture uses one primary and two replicas across availability zones, with
automated health monitoring, replication, failover, backups, point-in-time
recovery, configuration management, and database metrics. Every database
includes a local PgBouncer, and dedicated primary or replica PgBouncers are
available for additional connection resilience and capacity.
([PlanetScale Postgres](https://planetscale.com/docs/postgres),
[Postgres architecture](https://planetscale.com/docs/postgres/postgres-architecture),
[backups](https://planetscale.com/docs/postgres/backups),
[PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer))

PlanetScale supports a GCP `us-east4` deployment region and GCP Private Service
Connect. This makes a same-region private database substitution technically
plausible for the current `us-east4` Cloud Run deployment. Private Service
Connect keeps traffic on Google's network, but it has PlanetScale and GCP data
transfer charges and must be configured explicitly.
([PlanetScale regions](https://planetscale.com/docs/plans/regions),
[GCP Private Service Connect](https://planetscale.com/docs/postgres/connecting/private-connections/gcp-private-service-connect),
[Postgres pricing](https://planetscale.com/docs/postgres/pricing))

PlanetScale would delegate:

- PostgreSQL cluster provisioning and maintenance;
- replication, health detection, failover, and backups;
- connection pooling infrastructure and some connection continuity;
- database logs, metrics, branches, and operational controls.

Osfo would retain:

- every schema, migration, transaction, query, and index decision;
- the AgentRun state machine, leases, fencing, outbox, selector, relay, and
  reconciliation;
- Pub/Sub, Cloud Run services and worker pools, Temporal Workers, and all
  application scaling;
- PostgreSQL MVCC, vacuum, lock, hot-row, and queue-churn behavior;
- application-level availability during failover and connection loss.

There are also concrete migration costs. PlanetScale application connections
use database roles and credentials rather than the current Cloud SQL IAM
database-authentication contract. Its managed PgBouncers use transaction
pooling, which does not support `LISTEN/NOTIFY` or session advisory locks. The
current topology uses `LISTEN/NOTIFY` for relay and ThreadEvent wake hints, so
those listeners would need direct port 5432 connections or a redesigned wake
path.
([PlanetScale connection options](https://planetscale.com/docs/postgres/connecting),
[PgBouncer limitations](https://planetscale.com/docs/postgres/connecting/pgbouncer#limitations-of-transaction-pooling),
[current database contract](../specs/osfo-v1.md#postgresql-and-database-administration-boundary))

PlanetScale's Postgres branches are isolated databases, not zero-copy
application branches with automatic schema merges. Current documentation says
schema changes must be applied manually to each Postgres branch and there is
no automated merge. Branching should therefore not be counted as a replacement
for Osfo's reviewed Drizzle migrations and expand-contract release process.
([PlanetScale Postgres branching](https://planetscale.com/docs/postgres/branching))

It also does not currently provide automatic CPU or memory scaling or a
generally available horizontal-sharding layer for Postgres. Write scale remains
concentrated on one regional primary, and applications must explicitly route
eligible reads to replicas. Default included backup retention is two days
unless a longer custom policy is configured. These are database constraints,
not agent-platform features.
([Postgres compatibility](https://planetscale.com/docs/postgres/postgres-compatibility),
[Postgres sharding status](https://planetscale.com/docs/postgres/sharding),
[replicas](https://planetscale.com/docs/postgres/scaling/replicas),
[backups](https://planetscale.com/docs/postgres/backups))

## Ownership comparison

Legend: **delegated** means the vendor operates the capability, **provided**
means a platform primitive exists but Oz still owns its use, and **owned**
means Osfo or Oz must implement and operate it.

| Capability                                    | LangSmith Cloud                                                        | Cloudflare Agents + Workflows                          | Current GCP + Temporal Cloud                                   | PlanetScale substitution in current GCP              |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- |
| Agent Server and run API                      | **Delegated**                                                          | **Provided**, application-specific Agent class         | **Owned**                                                      | **Owned**                                            |
| Thread or session persistence                 | **Delegated**, Agent Server Postgres                                   | **Delegated**, per-Agent Durable Object storage        | **Owned**, Cloud SQL schema and repositories                   | **Owned**, same schema on managed Postgres           |
| Run queue and worker coordination             | **Delegated**                                                          | **Provided**, Agent queues and Workflows               | **Owned**, outbox, Pub/Sub topology, worker fleet              | **Owned**                                            |
| General durable workflows                     | Graph/run-specific platform behavior                                   | **Delegated** Workflows service, logic still owned     | **Delegated** Temporal Service, Workers still owned            | Unchanged                                            |
| Application compute operations                | **Delegated**                                                          | **Delegated**                                          | **Delegated infrastructure**, fleet policy and processes owned | Unchanged                                            |
| Database operations                           | **Delegated**                                                          | **Delegated** platform storage                         | **Delegated** Cloud SQL                                        | **Delegated** PlanetScale                            |
| Tracing and evaluation                        | **Delegated and integrated**                                           | Platform observability, product evaluation still owned | **Owned or separately integrated**                             | Unchanged                                            |
| Product identity and authorization            | **Owned**                                                              | **Owned**                                              | **Owned**                                                      | **Owned**                                            |
| Tools, Actions, approvals, uncertain outcomes | **Owned**                                                              | **Owned**                                              | **Owned**                                                      | **Owned**                                            |
| Deployment portability                        | Agent graph code is portable, managed server semantics are not neutral | Cloudflare-coupled runtime and storage                 | Highest infrastructure choice and semantic portability         | Standard Postgres improves database portability only |
| Migration magnitude from current code         | High, with potential large deletion                                    | Very high replatform                                   | None                                                           | Medium database and authentication migration         |

## Decision recommendation

### 1. Test the managed-agent hypothesis first

Build one narrow Oz journey on LangSmith Cloud, using Agent Server's native
assistant, thread, and run model instead of recreating Osfo's AgentRun API. The
slice should cover one interactive turn, one tool, one externally effectful
Action with approval, streaming, process recovery, and trace inspection. Its
decision question is:

> Which existing Osfo semantics are indispensable product differentiation,
> and which disappear when a mature Agent Server owns them?

Success means less custom authority and operations, not API-for-API parity.

### 2. Keep Cloudflare as a separate full-replatform candidate

Cloudflare deserves a dedicated prototype because it can collapse transport,
session compute, durable state, scheduling, and workflows into one platform.
It should not be mixed into the LangSmith experiment. Their deepest unknowns
are different: LangSmith tests adoption of an agent application platform,
while Cloudflare tests adoption of a distributed application runtime and data
model.

### 3. Freeze expansion of the current GCP topology during the comparison

The current implementation is valuable evidence and a control. Continue only
work needed to make the comparison fair, preserve data, or close safety bugs.
Do not add more schedulers, autoscalers, queue topologies, or database
optimizations until the managed reference slice shows which layers remain
necessary.

### 4. Decide PlanetScale independently and later

Compare PlanetScale with Cloud SQL only if the retained architecture still
needs an Osfo-owned PostgreSQL authority and database operations are a measured
problem. Run the same retained-history, outbox, failover, listener,
connection-pool, private-network, cost, and migration qualification. Do not use
PlanetScale as evidence for or against LangSmith or Cloudflare, because it
answers a different question.

## Bottom line

The user's instinct is correct that Osfo has been building several layers that
can now be bought as managed capabilities. The sharpest immediate comparison
is not "GCP versus PlanetScale." It is:

```text
own an agent platform from primitives
  versus
adopt a managed Agent Server and build Oz as the product
```

LangSmith Cloud is the most direct experiment for that question. Cloudflare is
the most ambitious replatform. PlanetScale is a credible Cloud SQL alternative,
but only after the project decides that an Osfo-owned PostgreSQL lifecycle is
still worth keeping.

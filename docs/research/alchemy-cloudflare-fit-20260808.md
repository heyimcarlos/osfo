# Alchemy fit for a Cloudflare-first Oz

Research date: 2026-08-08

## Decision

Adopt Alchemy for the Oz acceptance prototype, with a narrow ownership boundary:

- Alchemy owns infrastructure declaration, deployment state, Cloudflare resource wiring, and typed runtime bindings.
- Cloudflare Think remains the candidate agent harness. Oz should not adopt the newer `Alchemy.Agent` surface for v1 because Alchemy describes it as its newest surface and says that parts of the runtime are still landing.
- The Think-derived account class should remain a normal exported Cloudflare Durable Object class. Alchemy should provision its Worker and Durable Object binding without requiring the class to inherit from Alchemy's Effect-native Durable Object class.
- Oz domain packages own identity, channel bindings, account state, memory policy, triggers, approvals, billing policy, and tool contracts. These packages should not expose Alchemy resource types.
- Pin Alchemy to an exact version and qualify upgrades through deployment acceptance tests.

This is a good speed-first choice, not a low-risk mature choice. Alchemy's repository explicitly says the project is alpha and breaking changes should be expected. Its latest published release at the time of research is `v2.0.0-beta.70`, published August 6, 2026. The project is Apache-2.0 licensed. [Alchemy repository](https://github.com/alchemy-run/alchemy), [v2.0.0-beta.70 release](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.70)

The official source inspected for this report was commit [`3fb98ada2ad0e280d94c03052edacd2107fe4610`](https://github.com/alchemy-run/alchemy/tree/3fb98ada2ad0e280d94c03052edacd2107fe4610). Its package requires Effect `>=4.0.0-beta.105` or stable Effect 4, while Osfo currently pins `4.0.0-beta.103`. Alchemy adoption therefore begins with a controlled Effect upgrade and the repository's complete test gates. [Alchemy package metadata](https://github.com/alchemy-run/alchemy/blob/3fb98ada2ad0e280d94c03052edacd2107fe4610/packages/alchemy/package.json)

## Why Alchemy fits Oz

Alchemy calls its model "Infrastructure as Effects." A deployment is a TypeScript Effect program. Cloud resources are Effects, providers are Effect Layers, and bindings connect provisioned resources to runtime code with inferred types. Infrastructure code and Worker runtime code can therefore share schemas, contracts, and libraries without introducing a second configuration language. [What is Alchemy?](https://alchemy.run/what-is-alchemy/), [Infrastructure as Effects](https://alchemy.run/infrastructure-as-effects/), [Alchemy documentation index](https://alchemy.run/llms.txt)

That model fits the selected Oz direction:

```text
Oz domain services
    |
    v
Cloudflare adapter and composition roots
    |
    +--> Think agent harness
    +--> Durable Objects, D1, R2, Queues, Workflows
    +--> temporary Container or Sandbox compute
    |
    v
Alchemy deployment graph and typed bindings
```

Alchemy should not cause Oz to translate every external API into a custom Effect abstraction. Alchemy supports both Effect-native Workers and ordinary async Workers. `Cloudflare.InferEnv` can infer the environment type for an async handler, while Effect-native bindings provide typed Effect clients. This gives Oz an incremental adoption path. [Worker resource](https://alchemy.run/providers/cloudflare/workers/worker/), [Infrastructure as Effects](https://alchemy.run/infrastructure-as-effects/)

## Maturity assessment

| Signal             | Evidence                                                                                                                                                                                                                                                       | Assessment for Oz                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stability          | The repository says Alchemy is alpha and breaking changes are expected. The current release line is a `2.0.0-beta`. [Repository](https://github.com/alchemy-run/alchemy), [latest release](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.70) | Pin exact versions. Treat upgrades as migrations, not routine dependency bumps.                                                                        |
| Project age        | The public repository was created in October 2025 and remains under active development. [Repository](https://github.com/alchemy-run/alchemy)                                                                                                                   | There is little long-term operational history.                                                                                                         |
| Cloudflare breadth | Alchemy reports expanding its Cloudflare provider from 22 to 230 resources in one week. [Cloudflare Resource Factory](https://alchemy.run/blog/2026-07-02-cloudflare-resource-factory/)                                                                        | Resource breadth is excellent for prototyping, but rapid generated expansion increases the need for live qualification of the exact resources Oz uses. |
| Verification       | Alchemy reports 288 test files, about 700 live tests, and 720 SDK patches, with generated resources tested against real Cloudflare APIs. [Cloudflare Resource Factory](https://alchemy.run/blog/2026-07-02-cloudflare-resource-factory/)                       | Stronger evidence than generated schemas alone, but it does not replace Oz acceptance tests.                                                           |
| Team size          | Alchemy describes a team of three behind the rapid provider expansion. [Cloudflare Resource Factory](https://alchemy.run/blog/2026-07-02-cloudflare-resource-factory/)                                                                                         | Bus factor and support capacity are material adoption risks.                                                                                           |
| Licensing          | Apache-2.0. [Repository](https://github.com/alchemy-run/alchemy)                                                                                                                                                                                               | The code can be audited, forked, or patched if necessary.                                                                                              |

The maturity tradeoff is acceptable for Oz because v1 is deliberately optimizing for learning and speed. It would not yet be acceptable to make Alchemy types part of Osfo's stable public API.

## Execution and state model

An Alchemy stack evaluates a resource graph, calculates a plan, and reconciles resources through provider implementations. Plans classify changes as create, update, replace, delete, or no-op. Reconciliation is designed to converge: deterministic names and live reads allow a later deployment to continue after a partial failure. [Resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle/)

```text
alchemy.run.ts
    |
    v
Stack + resource Effects
    |
    v
Plan: create | update | replace | delete | no-op
    |
    v
Provider reconciliation against Cloudflare APIs
    |
    v
Resource state + typed outputs and bindings
```

The local state store writes resource JSON under `.alchemy/`, separated by stack and stage. State contains resource identity, inputs, outputs, status, and binding information. For a team or CI, Alchemy recommends `Cloudflare.state()`, which provisions a state-store Worker backed by Durable Object SQLite. Its authentication token and encryption key are held in Cloudflare Secrets Store. The state store is bootstrapped once and shared across stacks and stages. In CI, Alchemy retrieves state credentials through a short-lived edge-preview Worker. [State store](https://alchemy.run/state-store/)

Oz should use remote Cloudflare state from the first shared prototype. Local state is suitable only for an isolated personal experiment. The state store is part of the deployment control plane, not user memory or product data.

### Effect timing

Alchemy has two relevant execution phases:

1. The outer initialization Effect runs during deployment and again on a Worker cold start. This is where runtime configuration and bindings are resolved.
2. The inner request Effect runs for each request or event.

This distinction matters for secrets. If an `effect/Config` value is resolved during Worker initialization, Alchemy can discover it and create a Cloudflare `secret_text` binding. If code resolves it only inside a request handler, deployment does not see the dependency and cannot bind it automatically. [Secrets](https://alchemy.run/environments/secrets/)

## Resource map for Oz v1

| Oz need                                               | Recommended Cloudflare and Alchemy resource | Why                                                                                   |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| WhatsApp webhook, account onboarding, APIs            | Worker                                      | Global HTTP ingress and Effect composition root.                                      |
| One canonical account agent                           | Durable Object with SQLite                  | Per-account serialization, isolated durable state, alarms, and typed RPC.             |
| Account directory, billing state, indexes             | D1                                          | Relational data that must be queried across accounts.                                 |
| Files, generated documents, large artifacts           | R2                                          | Durable blob storage without putting large payloads into Workflows or account SQLite. |
| Deferred email, document, webhook, and ingestion jobs | Queue                                       | At-least-once background delivery with retries and dead-letter handling.              |
| Crash-safe multi-step work                            | Workflow                                    | Checkpointed steps, retries, sleep, rollback, and external events. Use selectively.   |
| Temporary code or document execution                  | Container or Sandbox                        | Isolated, non-permanent Linux compute created for a task.                             |
| Model routing and observability                       | AI Gateway                                  | Central provider authentication, logging, caching, and rate controls.                 |
| Product and infrastructure secrets                    | Worker secret bindings plus Secrets Store   | Per-application secrets and live-rotated shared infrastructure secrets.               |
| Dashboard and authenticated utility pages             | `Website.Vite` or `Website.StaticSite`      | Worker-hosted frontend with the same domain and binding model.                        |
| DNS, TLS, and routes                                  | Zone, DNS, custom domain, Worker routes     | Declarative product endpoint ownership.                                               |

Alchemy's Cloudflare provider documents more than 230 resources across compute, storage, messaging, networking, security, AI, observability, and other categories. Oz should still provision only the minimum acceptance stack. [Cloudflare provider reference](https://alchemy.run/providers/cloudflare/)

### Provisioning versus runtime ownership

Alchemy should provision:

- Worker scripts, static assets, compatibility settings, routes, and typed bindings;
- the account-agent Durable Object class binding and its Cloudflare class migrations;
- D1, R2, Queues, selected Workflows, Container Applications, and AI Gateway;
- infrastructure secrets, custom domains, DNS records, stage names, and remote deployment state;
- CI preview resources and observability resources that are part of the Cloudflare account.

Oz runtime code must still implement:

- WhatsApp signature validation, deduplication, onboarding, identity, account claiming, and replies;
- Think configuration, model and tool policy, skills, approvals, compaction, and harness behavior;
- the canonical thread, per-account SQLite reads and writes, internal SQL migrations, and alarms;
- authorization, billing entitlements, cost budgets, retries, and idempotency;
- Supermemory, Gmail, Stripe, and WhatsApp API clients and webhooks;
- document generation and the lifecycle of each temporary Sandbox task;
- deletion, export, correction, and recovery behavior for user data.

Alchemy creates and connects infrastructure. It does not supply these product semantics, and it has no reason to become the application service layer for third-party SaaS APIs.

## Bindings and type inference

Bindings are the strongest reason to choose Alchemy over a configuration-only IaC tool. Passing a resource into a Worker environment expresses both the deployment dependency and the runtime capability. Effect-native handlers receive typed clients. Async handlers can derive their environment through `Cloudflare.InferEnv`, which keeps the native Cloudflare programming model available. [Worker resource](https://alchemy.run/providers/cloudflare/workers/worker/), [Infrastructure as Effects](https://alchemy.run/infrastructure-as-effects/)

Recommended boundary:

```text
packages/*
    domain schemas, policies, interfaces
    no Alchemy resource values or Cloudflare binding types

apps/ingress, apps/agent-run-worker
    Effect programs and Cloudflare adapters
    binding clients translated into domain interfaces

alchemy.run.ts or a small infrastructure package
    resources, stages, domains, secrets, and composition
```

Do not create a generic Osfo wrapper for every Alchemy resource. That would reproduce the infrastructure framework inside Osfo. Translate only the bindings that cross into durable Oz domain interfaces.

### Think and the single Promise-to-Effect bridge

Think's account agent must inherit from the class required by the Cloudflare harness. TypeScript cannot also make it inherit from Alchemy's Effect-native Durable Object class. Alchemy supports this case through its ordinary async Worker path: export the Think-derived class from the Worker module, declare a `Cloudflare.DurableObject` binding whose `className` matches that export, and derive the native environment with `Cloudflare.InferEnv`. Alchemy then owns the binding and class-migration metadata without owning the agent implementation. [Async Worker Durable Object binding](https://alchemy.run/providers/cloudflare/workers/durableobject/#binding-in-an-async-worker)

That provisioning support is not the same as Effect runtime integration. Alchemy's Effect binding clients, request scopes, and Layers do not automatically execute inside a raw Think subclass. Oz must provide them explicitly.

Use one adapter module at the account-agent boundary:

```text
Cloudflare or Think callback
    |
    v
AccountAgentRuntime.runPromiseExit(effect, event context)
    |
    +--> fresh Effect Scope for this fetch, RPC, alarm, or message
    +--> Oz service Layers implemented over native env bindings
    +--> finalizers attached to DurableObjectState.waitUntil
    |
    v
OzAgent.run(...) in packages/agent-runtime
```

The adapter may own a `ManagedRuntime` built from activation-safe, pure services. It must not cache request-scoped promises, I/O handles, or a Scope across Cloudflare events. Every callback gets a fresh execution scope, explicit typed failure mapping, and interruption/finalizer handling. This mirrors the I/O-context discipline Alchemy had to add to its own Worker and Durable Object bridges, but a raw Think class bypasses those bridges. [Alchemy beta.41 runtime rewrite](https://alchemy.run/blog/2026-05-20-beta-41/)

This is the only Promise-to-Effect transition Oz should need in the account-agent runtime. Native D1, R2, Queue, AI Gateway, and other bindings can be implemented as small Effect services behind that adapter. Do not translate Think's internal lifecycle, state machine, or tool loop into a parallel Effect runtime.

### Initial repository shape

Keep the Alchemy graph small and keep provider-specific code at composition roots:

```text
alchemy.run.ts
    Stack, providers, remote state, and exported URLs

infra/alchemy/
    data.ts             D1 and R2 resources
    messaging.ts        Queues and future Workflows
    ai.ts               AI Gateway and provider secrets
    edge.ts             Workers, bindings, domains, and routes

apps/ingress/src/cloudflare/
    worker.ts           WhatsApp HTTP trust boundary

apps/agent-run-worker/src/cloudflare/
    AccountAgent.ts     exported Think-derived Durable Object class
    AccountAgentRuntime.ts
                        the single Promise-to-Effect adapter

apps/web/
    existing Oz account and connection surfaces

packages/agent-runtime/
    OzAgent service and harness boundary, no Alchemy resource types

packages/session/
    canonical thread event contracts, no Cloudflare bindings

migrations/
    d1/                 deploy-time global schema migrations
    account-agent/      runtime per-object SQLite migrations

test/alchemy/
    live stack lifecycle acceptance tests using Alchemy's Vitest adapter
```

This follows Alchemy's recommendation to keep `alchemy.run.ts` as the Stack composition root while respecting Osfo's existing application and package boundaries. Resources that share a lifecycle can live in one concern module. [Alchemy file layout](https://alchemy.run/project-structure/file-layout/)

## Workers, frontend hosting, and Pages

Alchemy supports low-level Workers and Pages resources, but its higher-level frontend resources, `Cloudflare.Website.Vite` and `Cloudflare.Website.StaticSite`, deploy frontend assets through Workers. These resources are thin Worker wrappers and inherit Worker options such as environment bindings, custom entrypoints, and domains. Vite, TanStack Start, React Router, Vue, SolidStart, and static Astro are documented paths. [Frontends](https://alchemy.run/cloudflare/frontend/frontends/), [Pages provider source](https://github.com/alchemy-run/alchemy/tree/3fb98ada2ad0e280d94c03052edacd2107fe4610/packages/alchemy/src/Cloudflare/Pages)

Use a Worker-hosted Vite or static site for the small Oz account and connection surfaces. There is no v1 reason to introduce Pages as a separate deployment model.

Worker version previews have an important limitation: a preview version cannot host a locally defined Durable Object class or Workflow class. Routes, custom domains, and cron triggers are also script-level resources rather than version-level preview resources. This makes a code-only preview insufficient for the complete Oz topology. [Worker resource](https://alchemy.run/providers/cloudflare/workers/worker/)

## D1

Alchemy can create a D1 database, bind it to Workers, and apply numbered SQL migrations from a `migrationsDir` during deployment. Applied migrations are skipped, and the tracking format is compatible with Wrangler. Alchemy also documents Drizzle integration for generating migrations. Effect-native code can use a typed client, while the native D1 binding remains available as an escape hatch. [D1](https://alchemy.run/cloudflare/data/d1/)

For Oz, D1 should hold data that must be queried across accounts, such as the account directory, channel bindings, subscription state, provider connections, and task indexes. Per-account conversational state should remain in the account Durable Object so that the canonical interaction path stays serialized.

## Durable Objects and migrations

A Durable Object provides a globally unique instance for a name, transactional SQLite storage, typed RPC, streaming, and alarms. Its physical location is chosen at the first request; a location hint influences creation but cannot move an existing object. [Durable Objects](https://alchemy.run/cloudflare/compute/durable-objects/)

Alchemy adds useful lifecycle support:

- A Durable Object class can move between Workers through `transferredFrom`, preserving its namespace data.
- Cross-script bindings introduce deployment-order constraints.
- Removing a Durable Object class defaults to deletion.
- A pure class move requires two deployments.
- Adoption and class renaming should be separated into two deployments: first adopt the existing class name, then rename it.

[Alchemy Durable Object resource](https://alchemy.run/providers/cloudflare/workers/durableobject/)

Cloudflare warns that deleting a Durable Object class permanently deletes its namespace and stored data. There is no trash or undo. A class configured with SQLite storage cannot later change to another storage backend. [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

Alchemy manages Cloudflare class lifecycle migrations. It does not remove the need to migrate the SQL schema inside each account object. Cloudflare recommends running internal schema migrations in the constructor under `blockConcurrencyWhile`, using a migration library or a dedicated migration table. `PRAGMA user_version` is not supported. [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

For Oz, every Durable Object release that changes stored state needs two independently reviewed migration plans:

1. The Cloudflare class or namespace migration managed by Alchemy.
2. The SQLite schema and data migration performed inside the object.

Before the prototype is accepted, Oz must prove that account state survives an ordinary update, a class rename, and a cross-Worker transfer.

Alchemy's `Cloudflare.Workers.scheduleEvent` layers multiple scheduled events over a Durable Object's single native alarm using SQLite. This is a natural v1 primitive for per-account reminders. [Durable Objects](https://alchemy.run/cloudflare/compute/durable-objects/)

## R2

Alchemy creates and binds R2 buckets with typed, access-scoped clients. R2 is the right home for uploaded files, generated PDFs and presentations, temporary artifacts that outlive compute, and exports. [R2](https://alchemy.run/cloudflare/data/r2/)

Store metadata and authorization references in D1 or the account object. Do not put large binaries into Durable Object SQLite or Workflow step output.

## Queues

Cloudflare Queues provide at-least-once background delivery. Alchemy supports typed Effect producers and consumers, retries, and dead-letter queues. [Queues](https://alchemy.run/cloudflare/messaging/queues/)

Oz consumers must be idempotent because duplicate delivery is part of the contract. Queues fit non-interactive work such as email delivery, webhook processing, file ingestion, artifact generation, and retryable connector synchronization.

## Workflows

Cloudflare Workflows provide durable, checkpointed execution with named steps, retry and timeout policy, sleep, rollback, and external events. Alchemy exposes these as typed classes and bindings. [Alchemy Workflows](https://alchemy.run/cloudflare/compute/workflows/), [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)

Do not model every Oz reminder as a Workflow. The current paid-plan limits include up to 50,000 concurrently active instances, an account creation rate of 300 instances per second, 100 instances per second per Workflow, sleeps up to 365 days, configurable runs up to 25,000 steps, a 1 MiB event and non-streaming step-output limit, and 30-day completed-instance retention. State storage is capped at 1 GB on paid plans. [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)

Cloudflare begins charging for Workflow steps and storage on August 10, 2026. That makes a Durable Object alarm scheduler the more economical default for simple reminders, with Workflows reserved for work that genuinely needs crash-safe multi-step checkpoints. [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

## Containers and Sandbox

Alchemy's Container resources can build from an Effect program, a Dockerfile, or a prebuilt image. Alchemy builds and pushes images to Cloudflare's registry and wires the Container to a Durable Object or Container Application. Typed RPC is supported. Protocol compatibility must be preserved while old and new revisions overlap during rollout. [Alchemy Containers](https://alchemy.run/cloudflare/compute/containers/)

Cloudflare Sandbox, generally available as of April 2026, provides isolated Linux environments with command execution, files, processes, and exposed services. It is a strong fit for temporary Oz document and code execution because the environment does not need to remain continuously running. [Containers and Sandbox GA](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [Sandbox overview](https://developers.cloudflare.com/sandbox/), [Container limits](https://developers.cloudflare.com/containers/platform-details/limits/)

The Sandbox SDK has already had a 2026 API deprecation cycle. Oz should pin the SDK and hide it behind one narrow task-compute interface. [Sandbox 2026 deprecation guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/)

Containers should not be part of the first inbound message path. Provision the binding in the prototype only when validating one concrete task that needs Linux execution.

## Secrets

Use two secret paths:

1. Worker `secret_text` bindings for application-specific third-party credentials. Resolve `effect/Config` during Worker initialization so Alchemy can discover and bind them.
2. Cloudflare Secrets Store for shared infrastructure credentials that need live rotation. Runtime reads see rotations without a Worker redeployment.

[Alchemy secrets](https://alchemy.run/environments/secrets/), [Secrets Store](https://alchemy.run/cloudflare/security/secrets-store/)

Cloudflare currently permits one Secrets Store per account. Alchemy adopts an existing store and does not delete it when a stack is destroyed. That is a sensible safety property, but it also means the store is account infrastructure rather than a disposable preview resource. [Secrets Store](https://alchemy.run/cloudflare/security/secrets-store/)

User-supplied model keys require an application-level encryption, authorization, audit, and revocation design. Do not create one Cloudflare secret resource per Oz user without first validating scale and operational limits.

## Domains

Alchemy can manage Cloudflare zones, DNS records, Worker routes, and custom domains. A Worker custom domain can manage DNS and certificate issuance, and `workersDev` can be disabled. Existing zones, routes, or records require explicit adoption when Alchemy does not own them. Zones retain on destroy by default unless deletion is explicitly requested. [Custom domains](https://alchemy.run/cloudflare/networking/custom-domains/)

Use a dedicated development subdomain and a production zone policy that retains zones and critical records. A stack destroy must never be able to remove the account's primary zone.

## Local development

`alchemy dev` runs Workers locally in `workerd` with hot reload. KV, R2, D1, and Queues can be emulated locally, and D1 migrations are applied. Durable Objects also run in `workerd`, although placement hints have no local effect. Resources without local emulation are automatically deployed to a personal cloud stage. `Alchemy.remote()` can opt an otherwise emulatable resource into live cloud use. [Local development](https://alchemy.run/environments/local-development/), [Durable Objects](https://alchemy.run/cloudflare/compute/durable-objects/)

This hybrid behavior is convenient and dangerous. A developer may believe a test is local while Alchemy provisions paid or externally visible resources. Oz should require:

- a dedicated development Cloudflare account or tightly scoped account policy;
- unique developer stages;
- visible stage and resource tags or names;
- a documented list of locally emulated versus remotely deployed resources;
- budget alerts for Containers, Sandbox, Workflows, AI, and externally called providers.

## Testing

Alchemy's recommended integration-test pattern deploys a real isolated stack once per suite, runs assertions against live resources, and destroys the stack afterward. It provides harnesses for Bun and Vitest. [Testing](https://alchemy.run/testing/), [Testing a stack](https://alchemy.run/testing/testing-a-stack/)

Oz should use the Vitest adapter because the repository standard is Effect Vitest. The practical test pyramid is:

- unit tests for domain decisions and schemas;
- local `workerd` tests for Worker, Durable Object, D1, R2, and Queue behavior;
- a small live Cloudflare acceptance suite for deployment lifecycle, remote-only resources, domains, permissions, and destroy behavior.

Running every test against a live personal stage would be slower, less deterministic, and more expensive than necessary.

## CI and previews

Alchemy documents per-pull-request stages such as `pr-123`, each with isolated copies of stack resources. CI can deploy the stage, comment a preview URL, and destroy it when the pull request closes. A separate administrative stack can provision a scoped Cloudflare API token into GitHub Actions. The administrative profile is intentionally powerful and should be used only for credential bootstrap. [Continuous integration](https://alchemy.run/environments/ci/)

For Oz, a complete stack per pull request may multiply D1 databases, Queues, Workflows, Containers, domains, and remote development resources. Use three preview levels:

1. UI or Worker code preview for every pull request where no stateful class is required.
2. Full isolated Cloudflare stage only on a label, acceptance branch, or nightly run.
3. Production promotion from a pinned, already-qualified artifact.

Remote Cloudflare state is required for CI so that deploy and close jobs agree on resource ownership. Preview cleanup should be monitored, not assumed.

## Destroy, adoption, and recovery

`alchemy destroy` calculates a deletion plan for the selected stack and stage, asks for approval, and deletes resources in dependency order. `--dry-run` shows the plan. [Destroy command](https://alchemy.run/cli/destroy/)

If state is lost, Alchemy can recover owned resources through provider reads. Foreign resources require `--adopt` or explicit `adopt(true)`. State inspection can list or read individual entries. Clearing Alchemy state does not delete cloud resources, and a later deployment can re-import discoverable owned resources. [Adopting resources](https://alchemy.run/cli/adopting-resources/), [Inspecting state](https://alchemy.run/cli/inspecting-state/)

Recovery is only as good as each provider's read and ownership semantics. Some singleton resources that cannot carry ownership tags may be adopted more permissively. Oz therefore needs a rehearsed recovery drill, not just a claim that state can be rebuilt.

During migration, every physical resource must have one infrastructure owner. Do not let Terraform, Wrangler, the dashboard, and Alchemy reconcile the same Worker, domain, bucket, or database concurrently. Stop the previous owner for a resource, inspect the live configuration, then adopt it into Alchemy in a dedicated non-destructive deployment.

Recommended safeguards:

- Run and review destroy dry-runs in CI before any production destruction.
- Retain production D1 and R2 resources. Set `emptyOnDestroy: false` on production R2 even when retention is also configured, so a policy mistake cannot silently drain the bucket. Alchemy otherwise empties a bucket before deleting it. [Alchemy R2 destroy behavior](https://alchemy.run/blog/2026-05-12-beta-37/)
- Do not assume a generic retain policy protects a Durable Object class binding. Alchemy treats removing the class as a namespace migration, and class deletion destroys its data. Reject any production plan that removes or renames the account-agent class without an approved data-preserving procedure. Retaining the host Worker on whole-stack destroy can provide an additional guard, but it does not replace migration review during updates.
- Export or back up critical user data independently of Alchemy state.
- Never combine adoption, class rename, and destructive migration into one release.
- Require an explicit production stage and account check before destroy.

Alchemy state recovery and Oz data recovery are separate. Rebuilding a lost Alchemy state record can rediscover a Worker or bucket, but it cannot restore user data after a Durable Object namespace, D1 database, or R2 object has actually been deleted.

## AI Gateway and the harness boundary

Alchemy can provision AI Gateway with logging, caching, rate limiting, and authentication, and it offers an Effect AI model Layer. [AI Gateway](https://alchemy.run/cloudflare/ai/ai-gateway/), [Effect AI](https://alchemy.run/cloudflare/ai/effect-ai/)

For Oz, Alchemy should provision AI Gateway but should not become the agent harness. The current decision is to qualify Cloudflare Think for model adapters, tool loops, and agent execution. Introducing both Think and Alchemy's Effect AI abstraction into the first tool loop would obscure which layer owns provider behavior.

Alchemy also documents an `Alchemy.Agent` release surface, but describes it as new and notes that parts of its runtime are still landing rather than presenting it as a turnkey reference architecture. The inspected `Agent` source still contains an unimplemented runtime body. Do not use it for Oz v1. Revisit it only after the Think acceptance prototype. [Releasing an agent](https://alchemy.run/cloudflare/ai/release-agent/), [`Alchemy.Agent` source](https://github.com/alchemy-run/alchemy/blob/3fb98ada2ad0e280d94c03052edacd2107fe4610/packages/alchemy/src/AI/Agent.ts)

## Lock-in and limitations

| Risk                                  | Consequence                                                                                                          | Mitigation                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Alpha and beta churn                  | Resource signatures, state behavior, or runtime helpers can change.                                                  | Pin exact versions, review release notes, and qualify upgrades through a staging deployment.                          |
| Current Effect version mismatch       | Alchemy requires Effect beta.105 or stable 4, while Osfo is on beta.103.                                             | Upgrade Effect as an explicit prerequisite and run all existing repository gates before the infrastructure prototype. |
| Alchemy-owned state format            | Alchemy state is not Terraform state. Switching IaC tools requires import or reconstruction.                         | Keep an inventory of Cloudflare resource IDs and test state-loss recovery.                                            |
| Runtime coupling                      | Effect-native binding clients and Alchemy resource values can spread into domain code.                               | Translate bindings at composition roots and keep package contracts platform-neutral.                                  |
| Raw Think runtime boundary            | Alchemy can provision the Think class binding but does not automatically install Effect scopes and Layers inside it. | One reviewed `AccountAgentRuntime` adapter, with event-scope and I/O-context acceptance tests.                        |
| Cloudflare platform coupling          | Durable Objects, Workflows, Queues, and Sandbox are Cloudflare-specific semantics.                                   | Accept this intentionally for v1 speed. Keep identity, memory policy, tools, and billing independent of those types.  |
| Generated provider breadth            | A documented resource may have less field experience than an older hand-written provider.                            | Live-test only the subset Oz uses and report upstream defects with minimal reproductions.                             |
| Hybrid local development              | Some resources deploy remotely during a supposedly local session.                                                    | Isolated development stages, scoped credentials, resource inventory, and budget alerts.                               |
| Destructive Durable Object migrations | Class deletion permanently deletes namespace data.                                                                   | Two-stage migration procedures, retention where possible, backups, and explicit approval.                             |
| Full-stack preview multiplication     | Per-pull-request stateful resources can increase cost and cleanup risk.                                              | Tier previews and reserve full stages for acceptance runs.                                                            |
| Sandbox API churn                     | Task compute adapter may break on SDK upgrade.                                                                       | Pin the SDK and expose one small Oz task-compute interface.                                                           |

The clean exit strategy is not a second generic infrastructure wrapper. It is a clean dependency direction:

```text
Oz domain contracts
    ^
    |
Cloudflare and Alchemy adapters
    ^
    |
Alchemy resource graph
```

Cloudflare resources remain standard Cloudflare resources even if Alchemy is removed. The migration cost is reconstructing deployment state and replacing Alchemy-specific binding and runtime conveniences.

## Acceptance prototype

Alchemy is accepted for Oz v1 only if one prototype proves all of the following:

1. Osfo upgrades to an Alchemy-compatible Effect version without breaking existing runtime behavior or repository gates.
2. A WhatsApp-shaped webhook reaches the ingress Worker and routes to an exported Think-derived account Durable Object provisioned through Alchemy's raw binding path.
3. The `AccountAgentRuntime` bridge enters Effect exactly at the Think callback boundary and provides all Oz services without relying on Alchemy's Effect-native Durable Object inheritance.
4. Concurrent requests, alarms, failures, interruption, hibernation, and object reconstruction do not reuse request-scoped promises or cross Cloudflare I/O contexts. Event finalizers complete through `DurableObjectState.waitUntil`.
5. A second deployment with no code or configuration change produces a no-op plan.
6. D1 migrations apply once and remain compatible with the repository's migration workflow.
7. Durable Object SQLite state survives an ordinary Worker update, a class rename, and a cross-Worker transfer.
8. An internal Durable Object SQL schema migration upgrades both a newly created account and an old account that wakes after deployment.
9. A reminder is stored and delivered through the Durable Object scheduling layer without a dedicated Workflow.
10. One true multi-step task survives a Worker restart through Workflows, with large artifacts stored in R2.
11. One temporary Sandbox or Container task starts, writes an artifact to R2, stops, and leaves no permanent per-user compute allocation.
12. `alchemy dev` documents which resources are local and which are live, and no unexpected cloud resource is created.
13. A CI preview stage deploys and destroys without residual resources.
14. A lost-state exercise can rediscover owned resources and requires explicit adoption for unowned resources.
15. A destroy dry-run retains critical zones and user data while deleting disposable preview infrastructure. A deliberately removed account-agent class must fail the safety gate.
16. Secret rotation works without embedding plaintext in state, source, logs, or generated configuration.
17. An Alchemy version upgrade can be tested against the complete lifecycle before production adoption.

## Final recommendation

Alchemy is the best current fit for a Cloudflare-first Oz because it removes a large amount of deployment and binding work while reinforcing the Effect learning objective. Its value is the typed connection between infrastructure and runtime, not an invitation to replace Oz's product model with Alchemy abstractions.

Proceed with Alchemy for the acceptance prototype. Keep it behind application composition roots, keep Think as the harness candidate, use Durable Object alarms for ordinary triggers, reserve Workflows for durable multi-step execution, and treat every production Durable Object migration as a high-risk data operation. The prototype must qualify deployment, update, recovery, and destruction, not only the happy-path first deploy.

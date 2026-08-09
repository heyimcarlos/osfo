# Oz Cloudflare repository architecture comparables

Date: 2026-08-08

## Decision frame

- Target project: Oz, a WhatsApp-first personal Agent with one canonical Thread
  and one private, scale-to-zero Agent per Principal.
- Current stack: TypeScript, Effect, Drizzle, PostgreSQL, GCP, Pub/Sub, separate
  ingress, relay, and AgentRun worker processes.
- Target stack: TypeScript, Effect, Cloudflare Workers, Think, Durable Object
  SQLite, D1, R2, Supermemory, and Alchemy.
- Domain and scale: consumer multi-tenant agent product, initially small but
  designed to add many independently isolated users.
- Hard constraints: optimize v1 delivery speed, keep Osfo as a deep harness
  integration module, avoid rebuilding the harness, preserve per-user data
  isolation, and keep product code Effect-native where it adds value.
- Key questions:
  - Should Oz remain one Cloudflare application or split by ingress, execution,
    identity, and onboarding?
  - Should D1 and Durable Object persistence remain in `packages/db`?
  - Where should Cloudflare-specific database adapters live?
  - Should Oz use Drizzle, Effect SQL, or both at runtime?
  - How much directory separation is useful before it becomes ceremony?

## Ranked comparables

| Rank | Source         | Score | Best match                                                                                                           | Mismatch                                                                                          | Use for                                                                              |
| ---: | -------------- | ----: | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
|    1 | Executor       | 33/35 | Effect application composition on Cloudflare with D1, R2, Durable Objects, Drizzle, and one Worker host              | It supports multiple host products and its session Durable Object still uses a shared D1 database | Cloudflare application shape, host adapters, Effect Layers, database locality, tests |
|    2 | Alchemy        | 31/35 | Effect-native Cloudflare resource composition and monorepo stack structure                                           | Pre-stable and not an Agent Harness                                                               | Infrastructure ownership, resource naming, deployment graph, live tests              |
|    3 | OpenCode       | 29/35 | Mature TypeScript agent with Effect services, Drizzle, SQLite, sessions, skills, accounts, and provider integrations | Its main Agent is local-first rather than one Durable Object per hosted user                      | Feature locality, session and persistence modules, Effect service granularity        |
|    4 | AnswerOverflow | 26/35 | Production Effect application with a shared database package, application-owned runtime composition, and test Layers | Convex and Discord differ from Cloudflare D1 and Think                                            | Shared package criteria, ManagedRuntime composition, integration ownership           |

Scoring criteria: domain fit, target stack fit, production maturity,
architecture clarity, infrastructure and operations relevance, testing quality,
and documentation and maintainability signal. Each criterion is scored from zero
to five.

## Repository architecture extracts

### Executor

- Repository: [UsefulSoftwareCo/executor at f674fb80](https://github.com/UsefulSoftwareCo/executor/tree/f674fb80eebd597f922edd5ec21b8035ab195a78)
- Why it is comparable: it is the closest reference for one Effect application
  deployed to Cloudflare with D1, R2, Durable Objects, a code execution
  substrate, HTTP APIs, and a frontend.
- Tree and file division:
  - `apps/host-cloudflare/src/worker.ts` is the Worker entrypoint and exports
    both Durable Object classes.
  - `apps/host-cloudflare/src/app.ts` performs one application composition call
    and injects host-specific Layers.
  - `apps/host-cloudflare/src/auth/` owns Cloudflare Access verification.
  - `apps/host-cloudflare/src/account/` owns the Cloudflare account adapter.
  - `apps/host-cloudflare/src/db/d1.ts` owns the D1-specific database adapter.
  - `apps/host-cloudflare/src/mcp/` owns the MCP HTTP and Durable Object bridge.
  - `apps/host-cloudflare/wrangler.jsonc` binds D1, R2, Worker Loader, assets,
    and Durable Object namespaces to the same Worker.
- Entrypoint: a small `worker.ts` validates configuration, delegates MCP traffic
  to the native Cloudflare edge seam, and sends remaining traffic through the
  Effect web handler.
- Package and module boundaries: shared application behavior and database
  semantics live in packages. Cloudflare binding conversion remains in the
  Cloudflare host application.
- Configuration and environment: the binding shape is declared once in
  `src/config.ts`. Runtime code receives Cloudflare `env` and builds the
  application once per isolate.
- Data and persistence:
  - D1 is adapted through `drizzle-orm/d1` in the application.
  - The shared database schema and high-level database assembly come from
    `@executor-js/api/server` and `@executor-js/fumadb`.
  - R2 is selected through a blob-store seam for values too large for D1.
  - The D1 adapter explicitly disables interactive transactions and limits
    batches to the platform's parameter limit.
- Testing: `apps/host-cloudflare/src/worker.e2e.node.test.ts` runs the complete
  Worker with local D1 and R2. Database migration behavior has focused tests
  beside the adapter.
- Practices to emulate:
  - One product Worker may own many routes and platform callbacks while still
    delegating behavior to focused internal modules.
  - Keep the Worker entrypoint small.
  - Keep Cloudflare binding conversion in the application composition root.
  - Test the real Cloudflare-specific assembly as one system.
  - Treat D1 transaction and parameter constraints as design inputs.
- Practices not to copy:
  - Executor needs parallel cloud, self-hosted, local, and Cloudflare hosts. Oz
    has one selected v1 host, so it does not need the same adapter generality.
  - Executor's session Durable Object opens the global D1 database. Oz wants
    the Agent's private operational state in that Agent's own SQLite store.

### Alchemy

- Repository: [alchemy-run/alchemy at 3fb98ada](https://github.com/alchemy-run/alchemy/tree/3fb98ada2ad0e280d94c03052edacd2107fe4610)
- Why it is comparable: it is the selected infrastructure system.
- Tree and file division:
  - `alchemy.run.ts` is the discoverable Stack composition root.
  - `examples/cloudflare-worker-async/src/worker.ts` demonstrates one Worker
    exporting a Durable Object class and handling fetch and queue callbacks.
  - `examples/cloudflare-worker-async/alchemy.run.ts` declares D1, R2, Queue,
    Durable Object, and Worker resources together.
  - `examples/cloudflare-tanstack-rpc-drizzle/` demonstrates a monorepo frontend
    and backend connected through typed resources.
- Configuration and environment: `Cloudflare.InferEnv` derives runtime binding
  types from resource declarations.
- Testing and deployment: Alchemy's Vitest adapter deploys the Stack and tests
  live outputs. The documentation recommends one Stack first and multiple
  Stacks only when lifecycle or deployment cadence diverges.
- Practices to emulate:
  - Keep `alchemy.run.ts` limited to Stack name, providers, state, wiring, and
    outputs.
  - Group resources that change and destroy together.
  - Use stable Durable Object class names from the first deployment.
- Practices not to copy:
  - Do not use Alchemy's unfinished Agent abstraction.
  - Do not force the Think-derived Durable Object class to inherit from an
    Alchemy Effect Durable Object class.

### OpenCode

- Repository: [anomalyco/opencode at 38e10eb1](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2)
- Why it is comparable: it is a mature TypeScript agent product using Effect,
  Drizzle, SQLite, provider adapters, skills, sessions, compaction, and multiple
  user interfaces.
- Tree and file division:
  - `packages/core/src/database/` owns the SQLite client, schema, migration
    runner, and generated migrations.
  - `packages/core/src/session/` owns session history, messages, compaction,
    context epochs, projection, runners, and session-scoped repositories.
  - `packages/core/src/account/`, `skill/`, `tool/`, and `permission/` are
    cohesive product capabilities inside the owning package.
  - `packages/console/core/src/account.ts`, `billing.ts`, `subscription.ts`, and
    `schema/*.sql.ts` keep modest capabilities as files rather than creating a
    directory for every noun.
  - `packages/effect-drizzle-sqlite/` is a substantial custom bridge between
    Drizzle and Effect SQLite.
- Data and persistence: the database service configures SQLite and applies
  migrations as part of Layer construction. Session repositories depend on a
  database service instead of opening the database independently.
- Testing: tests mirror domain modules and replace services with narrow Layers.
- Practices to emulate:
  - Keep schemas, migrations, and repositories close to the capability that
    owns their invariants.
  - Use feature directories after a capability contains several collaborating
    modules, not before.
  - Keep one service interface per useful product capability, not one service
    for every third-party method.
- Practices not to copy:
  - `packages/core` is much broader than the deep Osfo module should become.
  - OpenCode's custom Drizzle to Effect adapter is substantial. Oz should use
    official Effect Cloudflare SQL packages rather than recreate it.

### AnswerOverflow

- Repository: [AnswerOverflow at 1b94e8f6](https://github.com/AnswerOverflow/AnswerOverflow/tree/1b94e8f6642bdaad4d41e8972facc29bbb4d356c)
- Why it is comparable: it shows application-owned Effect composition over
  reusable database, agent, API, and observability packages.
- Tree and file division:
  - `apps/discord-bot/src/core/runtime.ts` assembles the application Layer and
    creates one ManagedRuntime.
  - `apps/discord-bot/src/services/` contains product-specific services that
    have earned independent modules.
  - `packages/database/` owns the shared Convex contracts, generated bindings,
    persistence functions, storage adapters, migrations, and test Layers.
  - `packages/agent/` is a separately consumable agent component with a defined
    public export map.
- Practices to emulate:
  - Keep reusable database behavior in a package when several applications or
    surfaces consume it.
  - Compose concrete infrastructure once at the application root.
  - Keep test Layer construction separate from production runtime wiring.
- Practices not to copy:
  - Its database package is large because it serves several applications and
    owns Convex server functions. Oz should keep `packages/db` narrower.
  - Its long-running Node runtime lifecycle does not map directly to Durable
    Object activation and hibernation.

## Language and platform guidance

### Official Effect Cloudflare SQL packages

- Source: [Effect at df431ae7](https://github.com/Effect-TS/effect/tree/df431ae72e6deeb67ce80e05674a8fd4313ba6fc/packages/sql)
- Relevant packages:
  - `packages/sql/d1/src/D1Client.ts` exposes an Effect `D1Client`, generic
    `SqlClient`, prepared statement cache, tracing, and atomic `batch` support.
    It explicitly does not provide interactive transactions or streaming.
  - `packages/sql/sqlite-do/src/SqliteClient.ts` accepts full
    `DurableObjectStorage`, supports Cloudflare-managed transactions, and
    exposes the generic Effect `SqlClient`.
  - `packages/sql/sqlite-do/src/SqliteMigrator.ts` applies ordered migrations
    against each Durable Object's private SQLite database and records them in
    that object's migration table.
- Local implication: Oz does not need to build a Drizzle to Effect runtime
  adapter. Runtime repositories can use Effect SQL directly. Drizzle may remain
  a schema and SQL migration generation tool if it materially improves the
  workflow.
- Caveat: these packages are on the Effect 4 beta line. Oz already accepts that
  release risk through Alchemy and should upgrade the workspace as one atomic
  dependency change.

### Cloudflare Durable Object rules

- Source: [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
  accessed 2026-08-08.
- Relevant practices:
  - Model one Durable Object around one atom of coordination, including a
    user's data or a tenant workspace.
  - Route stateless traffic through a Worker and stateful operations through
    typed Durable Object RPC.
  - Run local SQLite migrations before serving requests.
  - Use alarms for per-entity scheduled work and make handlers idempotent.
- Local implication: one `OzAgent` per stable `AgentId` is the right unit. The
  Worker should authenticate and resolve identity, then invoke the Agent.
- Cloudflare's Agent state documentation explicitly permits application code to
  create and query additional tables in an Agent's SQLite database. Think and
  Session already use that same database for messages, context, workspace
  files, configuration, and search. Oz-owned tables are therefore a supported
  platform shape, but Think's Session APIs remain experimental. The acceptance
  prototype must prove table-name isolation and migration compatibility with the
  exact Think version Oz pins.

### D1 versus Durable Object SQLite

- Source: [Access Durable Objects storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
  accessed 2026-08-08.
- Relevant practice: D1 is a managed cross-application database with external
  access and tooling. Durable Object SQLite colocates logic and private data for
  one coordinated entity.
- Local implication: D1 owns cross-Agent product lookup and account state. The
  private Agent Store remains in the `OzAgent` Durable Object.

### Alchemy file layout

- Source: [Alchemy file layout](https://alchemy.run/project-structure/file-layout/),
  accessed 2026-08-08.
- Relevant practice: keep one `alchemy.run.ts` composition root and group
  resources by shared lifecycle.
- Local implication: keep Alchemy resource declarations under
  `infra/cloudflare/` and keep product runtime code under `apps/oz/`.

## Recommended shape

### Revised directory layout

```text
alchemy.run.ts

infra/cloudflare/
    data.ts
    ai.ts
    oz.ts
    web.ts
    background.ts

apps/oz/
    src/
        worker.ts
        env.ts
        router.ts

        agent/
            oz-agent.ts
            runtime.ts
            layer.ts

        account/
            identity.ts
            onboarding.ts
            claim.ts
            recovery.ts
            service.ts

        channels/
            whatsapp/
                webhook.ts
                verification.ts
                client.ts

        persistence/
            product-d1.ts
            agent-sqlite.ts
            layers.ts

        integrations/
            supermemory.ts
            stripe.ts
            gmail.ts

        background/
            queue-consumer.ts
            workflows.ts

    test/
        worker.e2e.test.ts

packages/agent/
    src/index.ts
    src/internal/think.ts
    src/internal/context.ts
    src/internal/tools.ts
    src/internal/skills.ts

packages/db/
    migrations/product/
    migrations/agent/
    src/product/
        account-repository.ts
        channel-binding-repository.ts
        subscription-repository.ts
        schema.ts
    src/agent/
        trigger-repository.ts
        skill-repository.ts
        knowledge-sync-repository.ts
        schema.ts

packages/api/
packages/session/
packages/ui/
```

### Runtime ownership

```text
Cloudflare binding objects
    -> apps/oz/src/persistence/*
        -> Effect D1Client or SqliteClient Layers
            -> packages/db repositories
```

`packages/db` never reads global Cloudflare `env`, creates a Durable Object, or
provisions infrastructure. It owns durable data behavior. `apps/oz` translates
the current Worker or Durable Object binding into the Effect SQL Layer required
by that behavior.

### Identity and onboarding

Identity and onboarding belong in one `account/` capability but remain separate
modules:

- Identity answers who is acting, which `AgentId` they control, and whether a
  Channel Binding is valid.
- Onboarding decides what conversational step comes next before the person has
  completed Account Claim or subscription setup.
- Claim performs the durable Provisional Oz Identity to Oz Account transition.
- Recovery changes or replaces credentials and Channel Bindings.

Start with files in one directory. Create nested directories only after one of
these modules gains several internal collaborators.

### Database technology

- Use `@effect/sql-d1` for Product Database runtime access.
- Use `@effect/sql-sqlite-do` for Agent Store runtime access and per-object
  migrations.
- Use Drizzle only for schema declaration or migration generation if it reduces
  work. Do not build a custom Drizzle to Effect runtime adapter for v1.
- Explicitly test D1 atomic batches, the 100 bound-parameter limit, and the
  absence of interactive transactions.
- Treat Think-owned SQLite tables as private. Oz migrations use separately
  named tables and never mutate Think's internal schema.

### Testing

- Unit tests beside repositories and product services with test Layers.
- One Worker integration test covering webhook to D1 lookup to `OzAgent` RPC.
- Durable Object migration tests proving new, repeat, upgrade, and rollback
  failure behavior.
- One live Alchemy Stack acceptance test covering D1, R2, Worker, Durable
  Object, queue, secrets, and web outputs.

## Options

| Option                                                                   | Points | When to choose                                                         | Risks                                                                              | First slice                                                    |
| ------------------------------------------------------------------------ | -----: | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A. One `apps/oz`, package-owned persistence behavior, app-owned bindings |   9/10 | Oz v1 and one selected Cloudflare platform                             | One deployable has a wider blast radius                                            | WhatsApp webhook through D1 identity lookup into one `OzAgent` |
| B. One `apps/oz`, all database code inside the application               |   7/10 | Very small prototype expected to be discarded                          | Persistence behavior becomes coupled to Worker routing and harder to test or reuse | Put D1 and SQLite repositories in `apps/oz/src/persistence`    |
| C. Separate API, identity, Agent, and background deployables             |   5/10 | Independent teams, security domains, or release cadences already exist | Cross-script bindings, deployment ordering, more failure modes, slower learning    | Split Worker routing from Agent host immediately               |

## Final recommendation

- Recommended option: A.
- Why: it preserves the speed of one Cloudflare product application while
  keeping persistent invariants and harness integration in deep modules.
- What to do first: upgrade Effect, establish the Alchemy Stack, and prove one
  WhatsApp-shaped message can resolve a stable `AgentId`, reach one `OzAgent`,
  write its private SQLite state, and return through the Worker.
- What to defer: multiple Worker applications, a generic persistence adapter,
  a custom Drizzle runtime bridge, generic background queues, and nested feature
  directories without multiple files.
- What would invalidate the recommendation:
  - Oz needs multiple runtime hosts, not only Cloudflare.
  - Identity and Agent execution require different security or release domains.
  - D1 cannot satisfy account and Channel Binding consistency requirements.
  - Think requires exclusive control of the Durable Object SQLite database and
    cannot coexist safely with Oz-owned tables.

## Sources

- [UsefulSoftwareCo/executor at f674fb80](https://github.com/UsefulSoftwareCo/executor/tree/f674fb80eebd597f922edd5ec21b8035ab195a78),
  accessed 2026-08-08.
- [alchemy-run/alchemy at 3fb98ada](https://github.com/alchemy-run/alchemy/tree/3fb98ada2ad0e280d94c03052edacd2107fe4610),
  accessed 2026-08-08.
- [anomalyco/opencode at 38e10eb1](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2),
  accessed 2026-08-08.
- [AnswerOverflow at 1b94e8f6](https://github.com/AnswerOverflow/AnswerOverflow/tree/1b94e8f6642bdaad4d41e8972facc29bbb4d356c),
  accessed 2026-08-08.
- [Effect at df431ae7](https://github.com/Effect-TS/effect/tree/df431ae72e6deeb67ce80e05674a8fd4313ba6fc/packages/sql),
  accessed 2026-08-08.
- [Cloudflare Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
  accessed 2026-08-08.
- [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
  accessed 2026-08-08.
- [Cloudflare Agent state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/),
  accessed 2026-08-08.
- [Cloudflare Session memory](https://developers.cloudflare.com/agents/concepts/conversation-state-and-memory/),
  accessed 2026-08-08.
- [Alchemy file layout](https://alchemy.run/project-structure/file-layout/),
  accessed 2026-08-08.

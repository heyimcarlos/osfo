# OpenCode v2 Effect architecture audit

Date: 2026-08-20

## Conclusion

OpenCode v2 is a strong reference for Osfo, but it is not a template to copy
whole. Its most useful transferable ideas are the module shape, explicit
runtime composition, domain-owned persistence, transaction ownership, scoped
state, and real-implementation tests. Its custom `LayerNode` graph, event-sourced
Session runtime, plugin replay system, embedded SQLite error policy, and package
layout solve OpenCode-specific problems.

The earlier audit used OpenCode `dev` at `ad192a5`, not the requested `v2`
lineage. Current `origin/v2` is `ebc2504ef375a085abb408f6e6727815fb7552f8`.
That changes several conclusions:

- `specs/v2/instructions.md` is no longer current guidance. Dax introduced the
  document, Kit made one later schema-helper edit, and Kit deleted it while
  consolidating the v2 specifications. It remains useful historical design
  evidence, not an instruction file to transplant.
- Current v2 has no `Daemon`, `defaultLayer`, `layerNoDependencies`, or
  `layerWithoutDependencies`. The usual production boundary is a private raw
  layer behind an exported `node` in OpenCode's custom graph.
- Current v2 explicitly bans `import * as`, mechanically enforces that rule in
  selected source roots, and uses named imports for self-exported namespaces.
  Later runtime compatibility work introduced narrow namespace-import
  exceptions. Osfo should adopt the ban and require a documented, lint-suppressed
  exception when a package/runtime boundary genuinely leaves no sound named
  import.
- A service does not have to own mutable state. Current v2 also admits services
  for independently replaceable workflows, runtime placement, lifecycle,
  authority, and shared capabilities. A plain named Effect remains preferable
  when behavior is internal to another owner and needs no independently
  injectable identity.
- OpenCode colocates domain table declarations and queries with Core behavior.
  It does not support a repository service per table or a claim that all schema
  must live in a separate database package.
- At the versions now pinned by Osfo, the error helper is
  `Schema.TaggedError`, not `Schema.TaggedErrorClass`. Kit's installed skill is
  stale on this API name, and its own source-selection rule says the pinned
  Effect source wins.

## Fixed sources and authority

This audit treats source at a fixed revision as primary evidence:

| Source                     | Fixed revision or version                                                                                     | Role                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| OpenCode `origin/v2`       | [`ebc2504e`](https://github.com/anomalyco/opencode/tree/ebc2504ef375a085abb408f6e6727815fb7552f8)             | Current architecture, tests, package instructions, and specs |
| OpenCode history           | Explicit `origin/v2` ancestry and linked pull requests                                                        | Evolution and authorship                                     |
| Effect                     | [`648f566`](https://github.com/Effect-TS/effect/tree/648f566dd259898e7697c7fcb796183ccbc474ab)                | Current APIs and official examples                           |
| Kit's Effect skill         | [`0cace2a`](https://github.com/kitlangton/skills/tree/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect) | Opinionated Effect usage guidance                            |
| OpenCode Effect dependency | `4.0.0-rc.110`                                                                                                | API vintage of the audited v2 snapshot                       |
| Osfo Effect dependency     | `4.0.0-rc.111`                                                                                                | API authority for implementation in Osfo                     |

The OpenCode dependency versions are recorded in its fixed root manifest
([`package.json`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/package.json#L41-L89)).

The OpenCode archive at `/tmp/opencode-v2-audit.jkMSrr` was inspected without
modification. Its root guide identifies `v2` as the default branch and directs
work away from `dev`
([root `AGENTS.md`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/AGENTS.md#L1-L7)).
All package `AGENTS.md` files were checked for relevant constraints. The root,
Schema, AI, CLI, plugin, and tool guides contain the architecture-relevant
rules; the application, desktop, UI, website, and test guides concern their own
UI, localization, or package workflows.

## The status of `specs/v2/instructions.md`

The historical document did describe the attractive shape under discussion:
schemas and branded IDs, typed errors, a small `Interface`, a
`Context.Service`, a layer with private state, an explicitly provided layer,
self-exported namespaces, small container verbs, hooks before mutation, events
after mutation, and plugin-owned policy
([last version before consolidation](https://github.com/anomalyco/opencode/blob/7854f5b9f7f019122052ce958972986d953f8f87/specs/v2/instructions.md#L1-L121)).

It was not written by Kit as a statement of his general Effect philosophy. Dax
created the substantial service-shape text in commit
[`8643c07`](https://github.com/anomalyco/opencode/commit/8643c0721eaffb052cf851a5d33d1d721647db5c).
Kit later changed one schema helper in
[`7854f5b`](https://github.com/anomalyco/opencode/commit/7854f5b9f7f019122052ce958972986d953f8f87),
then deleted the file in
[`d54038b`](https://github.com/anomalyco/opencode/commit/d54038b9d20f8df7955ffd3ae4e99bce31b50aaf)
through [PR #36186](https://github.com/anomalyco/opencode/pull/36186).

The current specs index says specifications preserve behavior that is hard to
recover from code, while contributor guardrails belong in `AGENTS.md`. It also
warns that historical documents may contain obsolete names and rejects
implementation checklists as specifications
([current specs policy](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/specs/v2/README.md#L1-L40)).

The right use of the deleted file is therefore:

- retain it as design history explaining Catalog, Agent, Config, and plugin
  lifecycle choices;
- validate every pattern against current source and tests;
- do not copy it into Osfo as current OpenCode policy;
- record Osfo's own accepted rules in Osfo's `AGENTS.md` and ADRs.

## Current service shape

### The common module pattern

Current Core overwhelmingly uses a recognizable module facade:

```text
export * as Domain from "./domain"

schemas, ids, and expected errors
Interface
Service extends Context.Service<Service, Interface>
private implementation layer
exported node with explicit dependencies and lifetime
```

`Catalog` is representative. It self-exports its namespace, defines its draft
and interface, exposes `Service`, keeps its raw layer private, constructs private
state, returns `Service.of(...)`, and exports a location-scoped node
([`catalog.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/catalog.ts#L1-L84),
[`catalog.ts` operations and node](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/catalog.ts#L137-L269)).
`Agent` uses the same shape
([`agent.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/agent.ts#L1-L65),
[`agent.ts` implementation and node](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/agent.ts#L65-L134)).

A mechanical scan across Core, CLI, and Server found 90 `Context.Service`
declarations in 87 files; 86 of those files use a canonical namespace
self-export, 82 export an `Interface`, and 77 export a `node`. This is a strong
repository convention, not an Effect requirement.

The raw `layer` is usually private because OpenCode's public composition unit is
the node. There are deliberate exported-layer seams for alternate runtime or
test consumers, including Config test control, an injected database client, a
no-op Session execution implementation, and a configurable PTY ticket TTL
([Config](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/config.ts#L64-L103),
[Database](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/database/database.ts#L46-L75),
[Session execution](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/execution.ts#L47-L55),
[PTY ticket](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/pty/ticket.ts#L33-L56)).

This supersedes the old `defaultLayer` vocabulary. The private-layer and
default-layer cleanup reached current v2 through squash commit
[`8c94e90`](https://github.com/anomalyco/opencode/commit/8c94e9005ffe55a51aa664a47bbe58bb58b4ddb0)
in [PR #34788](https://github.com/anomalyco/opencode/pull/34788). Similar
source-branch commits `5a23bdc` and `6636683` are not ancestors of current v2
and are therefore not evidence for its direct history.

The admired CLI `Daemon` example is also historical. Current v2 deleted it in
[`1de3c6e`](https://github.com/anomalyco/opencode/commit/1de3c6e4a62091f2ab9fc93c13d3e4495f264d17),
so it should not anchor Osfo's current service convention.

### When current v2 admits a service

Current source does not support a single rule that a service must own mutable
state. It admits a `Context.Service` when callers need a stable capability that
is independently consumable or replaceable, or when runtime composition needs
to assign that capability a lifetime, authority, or placement.

| Shape                                | Current examples                                         | Why the shape fits                                                                                   |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Stateful container service           | `Catalog`, `Agent`, `Config`, `ToolRegistry`             | Shared state, scoped registration, transforms, or reload behavior                                    |
| Resource or lifecycle service        | `Database`, `Plugin`, filesystem watcher, PTY            | Acquisition, release, adapter selection, or runtime ownership                                        |
| Shared persistence capability        | `SessionStore`                                           | Many independent consumers need durable lookup and execution-claim operations                        |
| Replaceable workflow service         | `SessionTitle`, `SessionTransfer`                        | Small caller-facing workflow is independently injected and placed even without private mutable state |
| Plain named Effects                  | `SessionHistory`, `SessionRevert`, Session inbox helpers | Behavior belongs to Session and needs no separate injected identity                                  |
| Registration layer without a service | `SessionProjector`                                       | Boot-time projection registration and scoped worker, with no caller-facing capability                |
| Plain Effect factory                 | `State.create`, `PluginHost.make`                        | Construction is useful, but the product does not consume a separate service identity                 |

`SessionTitle` is particularly important. Its interface has one operation,
`generateForFirstPrompt`, yet it is a service with an exported location node
because it is a replaceable, dependency-capturing workflow
([`session/title.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/title.ts#L34-L39),
[`session/title.ts` layer and node](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/title.ts#L126-L155)).
`SessionTransfer` similarly exposes only `export` and `import` while owning a
global workflow and its dependencies
([`session/transfer.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/transfer.ts#L32-L147)).

By contrast, `SessionHistory` exports transaction-aware named Effects rather
than a service
([`session/history.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/history.ts#L70-L135)).
`SessionRevert` exports `stage`, `clear`, and `commit` Effects that Session
composes into its own API
([`session/revert.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/revert.ts#L57-L111)).
`SessionProjector` is a private `Layer.effectDiscard` that registers projections
and forks a scoped stream worker, without inventing a projector service
([`session/projector.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/projector.ts#L394-L709)).

The transferable admission test is:

1. Do independent callers consume this as a named capability?
2. Must a composition root replace or select its implementation?
3. Does it own shared state, a resource, a lifecycle, authority, or runtime
   placement?
4. Would giving it a service identity make a real boundary explicit, or only
   add indirection around one owner's workflow?

Use a service when one of the first three answers is materially yes and the
boundary is useful to callers. Keep a named Effect or private layer when the
fourth answer is only indirection. Number of methods and mutable state are
evidence, not admission rules.

For Osfo Onboarding, this means the name alone does not decide the shape.
Onboarding earns a service if transports or other workflows independently call
it as one capability, if its implementation must be replaceable, or if it owns
an onboarding authority or lifecycle. If it only coordinates lower-level
owners inside one caller and needs no independent runtime identity, keep it as
a named workflow. Its use case may still be domain-important without becoming
a `Context.Service`.

### Operation names

The historical advice to prefer a dumb container API still fits reloadable
state containers. Current Catalog exposes focused `provider` and `model`
operations such as `get`, `all`, `available`, and `default`, plus explicit
`transform` and `reload`; Agent uses `get`, `resolve`, `select`, `list`,
`transform`, and `reload`
([Catalog interface](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/catalog.ts#L44-L59),
[Agent interface](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/agent.ts#L45-L52)).

It is not a universal CRUD rule. Workflow and infrastructure services expose
domain operations: `SessionTransfer.export/import`,
`SessionTitle.generateForFirstPrompt`, and Bus operations such as `publish`,
`subscribe`, `project`, `replay`, and `claim`
([Bus interface](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/bus.ts#L132-L165)).
Osfo should prefer the smallest vocabulary that tells a caller what the domain
does, not force every service into generic CRUD verbs.

## State, plugins, and events

The current plugin architecture preserves the historical principle that policy
belongs outside dumb containers, but the mechanism has evolved. The selected
Catalog design uses replayable, location-scoped transforms that rematerialize
private state when registrations change. Policy is applied last, and a rebuild
emits one update after the new value is committed
([selected Catalog design](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/specs/v2/catalog-config-plugin-lifecycle.md#L191-L323)).

The shared state helper registers transforms in a scope, removes them with a
scope finalizer, updates internal state, and only then invokes finalization
([`state.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/state.ts#L14-L27),
[`state.ts` commit and registration](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/state.ts#L78-L178)).
Kit fixed the commit ordering in
[`1f2c59a`](https://github.com/anomalyco/opencode/commit/1f2c59a1b6370cf03be54705fb5322325dfea40a)
through [PR #38983](https://github.com/anomalyco/opencode/pull/38983): observers must
see committed state when the event is published.

Plugin activation owns child scopes, replacement, restoration on failed
replacement, and cleanup
([`plugin.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/plugin.ts#L26-L162)).
`PluginHooks` is now a separate, narrow extension service for AI SDK, Session,
shell, and tool hook domains. It registers scoped callbacks and triggers them
sequentially
([`plugin/hooks.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/plugin/hooks.ts#L39-L96)).
This is not a reason for ordinary Osfo mutations to acquire plugin hooks.

Bus owns OpenCode's durable aggregate protocol. It runs projections, an
optional local commit, sequence advancement, and event insertion in one
transaction, then wakes streams and observers after the transaction commits
([`bus.ts` transaction](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/bus.ts#L218-L380),
[`bus.ts` notification](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/bus.ts#L373-L416)).
Core owns event meaning, persistence, and projection, while Server owns public
selection, encoding, and delivery
([event architecture](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/specs/v2/event-stream-architecture.md#L19-L35)).

The transferable rules are smaller than this machinery:

- let the invariant owner commit state;
- notify observers only after commit;
- bind registration and background work to an owning scope;
- keep plugin policy outside a core container when plugins actually own that
  policy.

Do not add transforms, hooks, replay, or an event-sourced commit protocol to
Osfo without the matching product requirement.

## Layer composition, placement, and scope

OpenCode's production composition unit is its custom `LayerNode.Node`. A node
records an implementation layer, explicit dependencies, a service identity,
and a lifetime tag. Its constructor checks that declared dependencies satisfy
the layer's requirements
([`layer-node.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/util/src/effect/layer-node.ts#L9-L31),
[`layer-node.ts` dependency checks](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/util/src/effect/layer-node.ts#L71-L105)).

Compilation detects cycles, recursively supplies dependencies with
`Layer.provide`, caches repeated nodes, and exposes only selected roots rather
than all transitive dependencies
([`layer-node.ts` compiler](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/util/src/effect/layer-node.ts#L250-L282),
[runtime tests](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/test/effect/layer-node/layer-node.test.ts#L40-L159)).
Replacement checks service output, errors, name, lifetime, and dependency
closure; compile-time tests cover missing dependencies and invalid placement
([type tests](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/test/effect/layer-node/layer-node-types.test.ts#L40-L141)).

The graph distinguishes `global` and `location` nodes. Location nodes may
depend on global nodes, while global nodes may not depend on location nodes
([`app-node.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/util/src/effect/app-node.ts#L3-L13)).
The location service graph is explicitly grouped, hoists global dependencies,
uses `Layer.fresh` for each location, and caches each location graph for 60
minutes
([`location-services.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/location-services.ts#L58-L158)).
Server middleware supplies the selected cached location context around the
request
([`server/location.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/server/src/location.ts#L49-L59)).

Long-lived work follows Effect scope ownership. Session projection and cleanup
workers use `Effect.forkScoped`, watcher scopes are closed with their location,
and event logging installs an unsubscribe finalizer
([Session projector](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/projector.ts#L695-L709),
[tool-output cleanup](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/tool-output.ts#L134-L154),
[location watcher](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/filesystem/location-watcher.ts#L55-L106)).

Osfo should copy the principles, not the graph compiler:

- declare service dependencies at layer construction;
- choose implementations at a composition root;
- expose only intentional roots;
- attach resources and fibers to the layer that owns their lifetime;
- add a custom graph only if Osfo develops real multi-placement, replacement,
  and compile-time dependency-closure needs.

Ordinary named Effect layers are sufficient for the current Osfo architecture.

## Database, repository, and transaction ownership

Current OpenCode deliberately moved database ownership into Core in
[`7f571d3`](https://github.com/anomalyco/opencode/commit/7f571d36ea56cc3dd7059cfe82c729fb52b121eb)
through [PR #29068](https://github.com/anomalyco/opencode/pull/29068). A later
change internalized the standalone Effect Drizzle adapter under Core and
deleted its workspace package
([`f6611a1`](https://github.com/anomalyco/opencode/commit/f6611a1f56ff333c6985e3eb03e5e7dfd2686b50)).

The current arrangement is:

```text
Core Database.Service
  owns client acquisition, SQLite configuration, migrations, adapter selection

domain/sql.ts
  owns the domain's Drizzle table declarations

domain service or plain domain module
  owns the queries and transaction-aware helpers
```

`Database.Service` intentionally exposes only `db`; its private acquisition
layer creates and migrates the client, and alternate layers accept a path or an
injected client
([`database.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/database/database.ts#L12-L75)).
Table modules live beside domains, including Session, Project, Credential,
Event, Permission, Workspace, and Worktree.

Most domain services query Drizzle directly inside their private layers.
Credential owns its small interface, mapping, queries, and replacement
transaction
([`credential.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/credential.ts#L30-L134)).
Workspace owns both persistence and connection lifecycle
([`workspace.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/workspace.ts#L28-L117)).
Worktree uses private transaction-aware functions and opens a transaction in
the domain operation that owns reconciliation
([`worktree.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/worktree.ts#L155-L210),
[`worktree.ts` refresh transaction](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/worktree.ts#L279-L324)).

`SessionStore` is the closest repository-shaped service, but it is admitted for
a domain reason. Multiple consumers need Session lookup, projected context,
message lookup, execution claims, release, and recovery accounting
([`session/store.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/store.ts#L14-L46),
[`session/store.ts` SQL layer](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/src/session/store.ts#L50-L132)).
Those operations represent a shared durable authority, not generic CRUD.
Other Session persistence remains plain named functions that accept `db` or a
transaction.

There is no generic transaction service. The operation that owns the invariant
opens `db.transaction` and passes `tx` to its private helpers. Bus is a special
event-sourced owner, not a general repository pattern. Its tests prove that
projectors, local commit state, events, and sequence advancement roll back
together
([Bus rollback tests](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/test/bus.test.ts#L238-L259),
[batch rollback tests](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/test/bus.test.ts#L500-L536)).

OpenCode also demonstrates a boundary leak that Osfo should avoid. Server
middleware imports the raw database and `SessionTable` for placement lookup
([Session location middleware](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/server/src/middleware/session-location.ts#L1-L47),
[form location middleware](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/server/src/middleware/form-location.ts#L1-L55)).
OpenCode's package exports make domain tables accessible, so its colocation is a
convention rather than enforced privacy.

For Osfo, the evidence supports:

- centralize connection construction, migrations, and runtime adapter wiring;
- place product queries with the feature or domain capability that owns their
  invariant;
- create a repository or store service only when persistence itself is a shared,
  replaceable, independently consumed capability;
- let the invariant owner open the transaction;
- avoid giving transports and unrelated services an unrestricted raw ORM escape
  hatch;
- decide separately whether deployment tooling requires table declarations to
  remain in `packages/db`.

OpenCode cannot by itself decide Osfo's package boundary. It does show that the
earlier statement, "OpenCode supports schema in a separate database package and
private feature queries elsewhere," was false. If Osfo retains `packages/db`,
that is an Osfo constraint, not an OpenCode-derived rule.

OpenCode generally turns embedded authoritative SQLite failures into defects.
Osfo should not copy that policy blindly for remote PostgreSQL. Connection
outages and retryable operational failures may need typed handling at HTTP,
queue, or retry boundaries.

## Schema and Drizzle conventions

OpenCode's Schema guide keeps browser-safe contracts free of runtime services,
uses one canonical schema identity, prefers the namespace projection pattern,
and specifies same-name interfaces for public `Schema.Struct` records
([Schema package guide](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/schema/AGENTS.md#L1-L15),
[module shape and public types](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/schema/AGENTS.md#L33-L64)).
The current Agent contract is representative: self-export, branded ID and name,
then a same-name `Info` interface and `Schema.Struct`
([`schema/agent.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/schema/src/agent.ts#L1-L55)).

The root guide requires snake_case Drizzle object keys and omits redundant
column-name strings
([Drizzle style](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/AGENTS.md#L145-L163)).
The error-level AST rule rejects explicit column strings in Core SQL table files
([rule](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/script/ast-grep/rules/no-drizzle-column-name.yml#L1-L22));
its test treats snake_case keys as valid and camelCase keys with explicit names
as invalid
([rule test](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/script/ast-grep/rule-tests/no-drizzle-column-name-test.yml#L1-L14)).
Current Core table declarations follow the written convention. Osfo should
adopt it for new schema and migrate existing camelCase definitions deliberately,
not through a behavior-changing mechanical rewrite.

The most important API correction is expected errors. Current OpenCode and
Effect rc.111 use `Schema.TaggedError`. The official Effect source exports that
helper
([`Schema.ts`](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/packages/effect/src/Schema.ts#L14753-L14788)).
Kit migrated current v2 away from removed Effect APIs, including
`TaggedErrorClass`, in
[`d9b81d2`](https://github.com/anomalyco/opencode/commit/d9b81d2233a5c70f52ae1fbcd4cccef2ea57c7b1)
through [PR #43109](https://github.com/anomalyco/opencode/pull/43109).
Kit's installed skill still says `Schema.TaggedErrorClass`, so the pinned project
source must override that recipe, as Kit's own source-selection rule requires
([skill source hierarchy](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/SKILL.md#L9-L34)).

## Import rules and exceptions

Current v2's written rule is unambiguous:

- never alias imports except a last-resort type collision;
- never use `import * as` or `import type * as`;
- import a module's own namespace export by name, such as
  `import { Project } from "@opencode-ai/core/project"`;
- keep dynamic imports in the narrow branch that benefits from lazy loading
  ([root import guide](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/AGENTS.md#L82-L88)).

This does not ban the canonical module declaration
`export * as Name from "./name"`. The AST rule's own tests distinguish the valid
self-export from the invalid namespace import
([star-import rule test](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/script/ast-grep/rule-tests/no-star-import-test.yml)).

The ban first entered current v2 ancestry through Dax's database move in
[`7f571d3`](https://github.com/anomalyco/opencode/commit/7f571d36ea56cc3dd7059cfe82c729fb52b121eb)
on 2026-05-31 UTC. Kit then added error-level mechanical enforcement and
converted the scoped imports in
[`1401901`](https://github.com/anomalyco/opencode/commit/14019015292f19bddd5665cc7bcdae93744e91ad)
through [PR #35210](https://github.com/anomalyco/opencode/pull/35210).

Current source is not exception-free. The fixed snapshot contains 178 namespace
imports across all tracked TypeScript and TSX files, with 26 under the roots
named by `lint:effect-patterns`
([lint script](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/package.json#L19-L21)).
Most are outside the rule's intended product scope, in tests, UI, or supporting
packages. Some current Core and platform
uses are real runtime compatibility exceptions. Kit's
[`a841fc2`](https://github.com/anomalyco/opencode/commit/a841fc22bba9ad0581c3975828a5fdf11c8d28cc)
through [PR #41918](https://github.com/anomalyco/opencode/pull/41918) moved Node
platform imports to deep namespace modules because the package barrel eagerly
loaded `undici`, Redis, and `node:sqlite`, which is incompatible with workerd.
The reason is recorded beside the centralized imports
([`app-node-platform.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/util/src/effect/app-node-platform.ts#L1-L8)).
At least one other exception uses an explicit AST suppression
([`cross-spawn-spawner.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/util/src/cross-spawn-spawner.ts#L14-L20)).

This evidence supports an Osfo default ban with a waiver, not unrestricted
namespace imports:

```text
Do not use import * as or import type * as.
Import a module's canonical self-exported namespace by name.
Use export * as Name only for the module's intentional canonical namespace.
Permit a namespace import only at a package/runtime interoperability boundary
where named or barrel imports are unsafe or unavailable. Document the concrete
reason at the import and suppress the lint rule narrowly.
```

The official Effect HTTP example also uses named imports exclusively
([`10_basics.ts`](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/10_basics.ts#L7-L18)).
That is consistent style evidence, though a single example is not a library
mandate.

### Enforcement should use Osfo's Oxlint plugin

OpenCode's ast-grep rules are useful specifications, but its wiring is weaker
than Osfo's. OpenCode keeps its ordinary lint, Effect-pattern scan, and lint-rule
tests as separate commands. Its pre-push hook does not run the Effect-pattern
scan, and the audited v2 snapshot fails that scan despite the rules themselves
having passing tests. Osfo already runs one blocking `oxlint --deny-warnings .`
command in CI and loads a repository-owned JavaScript plugin
([root lint configuration](../../.oxlintrc.json),
[plugin entry point](../../tools/oxlint/index.ts),
[CI](../../.github/workflows/ci.yml)). Adding a second ast-grep lint path would
create two enforcement systems without adding coverage.

The side audit compared six OpenCode checks with Osfo's current tree:

| Check                            | Current Osfo evidence                                                                                                                                    | Adoption                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-star-import`                 | 217 imports across 90 files: 157 outside tests and 60 in tests. The earlier count of 207 omitted 10 linted infrastructure imports.                       | Add an Oxlint rule, then enable it as each migration scope reaches zero. Keep `export * as Name` valid and require a narrow, explained suppression for unavoidable package/runtime interop.        |
| `no-import-alias`                | 42 aliased specifiers: 28 value aliases and 14 type aliases. Many compensate for modules without canonical named namespace exports.                      | Convert aliases with the module self-export migration. Permit a dedicated aliased `import type` only for a real type-name collision.                                                               |
| `no-nested-effect-service-yield` | Zero findings. Root guidance already requires binding a service first.                                                                                   | Add and enable immediately, with RuleTester coverage.                                                                                                                                              |
| `no-json-parse-cast`             | Zero findings. Effect TSGo's recommended preset already enables `effecttsgo/prefer-schema-over-json`, and `--deny-warnings` makes its warnings blocking. | Probe the existing rule with the exact invalid case. Add a local rule only if the existing diagnostic misses it.                                                                                   |
| `no-effect-die-string`           | 80 findings, all in tests.                                                                                                                               | Replace strings with `Error` values, then enable the rule for source and tests.                                                                                                                    |
| `no-drizzle-column-name`         | 180 explicit names: 144 camel-case keys and 36 snake-case keys across PostgreSQL and Agent SQLite schema.                                                | Extend the rule to PostgreSQL builders and enable it one schema authority at a time after a behavior-preserving migration. Exclude Better Auth schema until its adapter expectations are verified. |

These counts are migration estimates, not durable policy. The implementation
must re-baseline them with the finished Oxlint rules because filename scope and
AST matching affect the totals.

Each local rule needs valid, invalid, exception, and filename-scope tests before
activation. Start without autofixes. Import and schema changes can require
module-level judgment, and an unsafe fix would turn a style migration into a
runtime change.

## Comparison with Kit's skill and official Effect examples

Kit's service guide presents `Interface`, `Context.Service`, a real
`Layer.effect` implementation, `Service.of`, named `Effect.fn` operations, and
the self-export as one opinionated module style
([service module](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/SERVICES_LAYERS.md#L5-L69)).
It recommends visible layer requirements, scoped long-running work, deliberate
`Layer.provide`, and explicit test implementations
([layer composition](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/SERVICES_LAYERS.md#L71-L119),
[testing](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/TESTING.md#L56-L112)).

Current OpenCode mostly matches that module style, but hides the raw production
layer behind its custom node. That difference follows from OpenCode's graph,
placement, and replacement requirements. Osfo can use Kit's simpler exported
layer shape until it has comparable graph needs.

The official HTTP Users fixture shows a second clean form. `Users` extends
`Context.Service` with an inline interface, privately constructs a SQL model
repository and extra queries, exposes a dependency-requiring SQL layer, then
offers fully provided SQL and memory layers
([`Users.ts`](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/fixtures/server/Users.ts#L32-L182)).
Its handler yields `Users` once, keeps HTTP translation thin, and provides the
service layer at composition
([Users handler](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/fixtures/server/Users/http.ts#L8-L80),
[server composition](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/10_basics.ts#L23-L64)).

The Effect repository also demonstrates a first-class `UserRepository` service
with several layer variants
([Layer composition example](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/01_effect/03_services/20_layer-composition.ts#L20-L69)).
The official examples therefore prove that both arrangements are valid Effect.
They do not choose domain ownership for Osfo. Caller structure, authority,
replacement, lifecycle, and transaction boundaries must make that decision.

## Testing

OpenCode's root guidance says to avoid mocks, test real implementations, and run
tests from package directories rather than the repository root
([testing guide](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/AGENTS.md#L165-L172)).
Core wraps Bun tests with a scoped Effect runner that supplies `TestClock` and
`TestConsole`
([`test/lib/effect.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/test/lib/effect.ts#L1-L53)).

Tests commonly compile the real node graph, replace only external boundaries,
and use `Layer.fresh` when a separate stateful acquisition is required.
Catalog tests exercise reload, debounce through `TestClock`, and event
subscription against the real graph
([`catalog.test.ts`](https://github.com/anomalyco/opencode/blob/ebc2504ef375a085abb408f6e6727815fb7552f8/packages/core/test/catalog.test.ts#L23-L96)).
Persistence tests use real in-memory SQLite and inspect durable rows and rollback
behavior. LayerNode has both runtime replacement tests and compile-time negative
tests.

The official Effect HTTP test uses `@effect/vitest`, an in-memory API client,
the real handler graph, a memory Users layer, and authorization middleware
([`20_testing.ts`](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/20_testing.ts#L1-L100)).
Kit likewise recommends Effect-aware tests, explicit layers, deterministic
primitives, and first-class test services only when reusable stateful control is
needed.

Osfo should retain Effect Vitest. The transferable testing rule is the real
service graph plus the narrowest honest boundary replacement, not OpenCode's
choice of Bun's test runner.

## Corrections to the earlier audit

The following statements in `docs/research/effect-service-guidance.md` need to
be replaced or qualified:

| Earlier conclusion                                                                    | Status after the v2 audit      | Correction                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode was audited at `ad192a5` and Effect beta.83                                  | Wrong branch and stale version | Use `origin/v2` at `ebc2504e`, Effect rc.110                                                                                                 |
| `specs/v2/instructions.md` describes current v2 direction                             | Historical only                | It was deleted in the specs consolidation; use it as design history                                                                          |
| Current CLI `Daemon` is a clean layer example                                         | Wrong for current v2           | Daemon no longer exists                                                                                                                      |
| Catalog and Agent keep raw layers private behind composition                          | Still valid                    | Current v2 makes this the dominant node-based convention                                                                                     |
| `defaultLayer` is stale                                                               | Valid                          | Current packages contain no `defaultLayer`                                                                                                   |
| Namespace imports show the written ban is not meaningful                              | Wrong framing                  | The ban is real and linted, but current source has narrow runtime exceptions and enforcement drift                                           |
| Osfo should preserve namespace imports for namespace-shaped APIs                      | Too permissive                 | Ban namespace imports by default; import canonical self-exported namespaces by name; require a documented waiver for package/runtime interop |
| `Schema.TaggedErrorClass` is the expected-failure helper                              | Wrong at rc.110/rc.111         | Use `Schema.TaggedError`                                                                                                                     |
| Every one-off orchestration should be a plain Effect                                  | Too rigid                      | Small workflows can be services when independently replaceable, consumed, or runtime-placed                                                  |
| A repository service needs independent callers, selection, lifecycle, or authority    | Supported, with nuance         | `SessionStore` is the best current example; call this an inference from source, not explicit OpenCode policy                                 |
| Product SQL is private to the feature by default                                      | Directionally valid            | Current OpenCode often does this, but its exports and two server middleware paths leak raw table access                                      |
| `packages/db` owning all schema while feature code owns queries is OpenCode-supported | Wrong attribution              | OpenCode colocates domain tables and SQL behavior in Core; a separate Osfo schema package is an Osfo decision                                |
| Plugin hooks and events are OpenCode-specific, not universal Effect rules             | Valid                          | Current transform and Bus architecture makes the warning stronger                                                                            |
| The Effect Users example permits a service to hide its SQL repository                 | Valid                          | Official Effect also shows a first-class repository; neither example decides ownership                                                       |
| Kit's skill should guide Effect APIs                                                  | Valid with source hierarchy    | Pinned Effect source overrides the stale `TaggedErrorClass` recipe                                                                           |

## Proposed corrections to Osfo guidance

These are proposed policy edits only. This audit does not implement them.

1. Replace the root import section's current namespace-import permission with a
   default ban on `import * as` and `import type * as`. Keep
   `export * as Name from "./name"` for canonical module namespaces. Require a
   nearby reason and narrow lint suppression for a package/runtime interop
   exception. Enforce the rule through Osfo's existing Oxlint plugin after each
   migration scope reaches zero; do not add ast-grep as a second lint system.
2. Replace every Osfo guidance reference to `Schema.TaggedErrorClass` with
   `Schema.TaggedError`, and state that Osfo's pinned Effect source overrides
   recipes in installed skills.
3. Define service admission in terms of independent consumption, implementation
   selection, shared state/resource/lifecycle, authority, or runtime placement.
   Explicitly say that mutable state and method count are not requirements.
4. Prefer a plain named Effect or private layer when behavior belongs to one
   service and does not need an independently injectable identity. Record
   registration-only layers as a legitimate shape.
5. Standardize new service modules on schemas and expected errors, `Interface`,
   `Service`, a real implementation layer, `Service.of`, named `Effect.fn`
   operations, and a canonical self-export. Let the composition convention
   decide whether the raw layer is public or private.
6. Remove `defaultLayer`, `make`-for-every-service, and
   `layerWithoutDependencies` vocabulary. Export alternate layers only for a
   concrete runtime, adapter, or test consumer.
7. Keep HTTP handlers thin: bind the service once, translate transport input and
   output, and provide service implementations at composition.
8. Replace directory-taxonomy rules such as generic `services/`,
   `integrations/`, and parallel `db/` implementations with domain ownership.
   The module that owns the invariant should own the product query and
   transaction.
9. Keep database connection construction, migrations, adapters, and test
   infrastructure centralized. Re-evaluate whether each Osfo table declaration
   must remain in `packages/db`; do not move it solely to imitate OpenCode.
10. Admit a repository/store service only when it is an independently consumed,
    replaceable, authority-bearing capability. Do not create one per table.
11. Use snake_case Drizzle object keys and omit redundant SQL column strings for
    new schema. Plan any existing schema conversion separately so runtime names
    and migrations do not change accidentally.
12. Let the invariant owner open the database transaction, and publish external
    notifications only after commit. Do not copy OpenCode's Bus commit protocol
    unless Osfo deliberately adopts the same event-sourced invariant.
13. Keep long-running work in an owning Layer scope. Use `Effect.forkScoped` or
    an explicitly managed child scope and verify finalization.
14. Retain Effect Vitest and test real implementations with explicit layers,
    deterministic Effect facilities, and a disposable database. Add first-class
    test services only when reusable stateful control justifies them.
15. Cite the deleted `specs/v2/instructions.md` only as historical OpenCode
    evidence. Put accepted Osfo decisions in root/package `AGENTS.md` and ADRs,
    not in a new personality-derived global skill.
16. Port the useful OpenCode syntax checks into the existing Oxlint plugin in
    debt-aware stages. Enable zero-debt rules first, migrate star imports and
    aliases with canonical namespace modules, and migrate Drizzle definitions
    one authority at a time. Probe Effect TSGo before duplicating its JSON rule.

## Sources read

- OpenCode fixed snapshot at `ebc2504ef375a085abb408f6e6727815fb7552f8`:
  all `AGENTS.md` files; all current `specs/v2` documents; representative Core,
  Server, Schema, CLI, and Util source; service, layer-node, database, Bus,
  Catalog, Session, plugin, state, import-rule, Drizzle-rule, and transaction
  tests; package manifests and lint scripts.
- OpenCode explicit `origin/v2` history for the instructions file, service layer
  privacy, default-layer removal, database move, Session store, event commit,
  lint rules, account removal, Drizzle internalization, and workerd platform
  imports, including the linked pull requests above.
- Kit's Effect skill at `0cace2ae0bd65e0cb03ab12860b62ae5e043f0df`:
  `SKILL.md`, `SERVICES_LAYERS.md`, `SCHEMA.md`, and `TESTING.md` in full.
- Effect at `648f566dd259898e7697c7fcb796183ccbc474ab`:
  the HTTP basics walkthrough, Users service, Users handlers, HTTP tests, layer
  composition example, and current Schema source.
- Osfo's current `package.json`, package instructions, and
  `docs/research/effect-service-guidance.md` for the local comparison.

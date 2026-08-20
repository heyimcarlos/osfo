# Effect service guidance

Date: 2026-08-20

> Superseded by
> [`opencode-v2-effect-architecture.md`](./opencode-v2-effect-architecture.md),
> which audits the actual OpenCode `v2` branch and current Effect rc.111 source.
> Keep this file only as the record of the earlier comparison.

## Recommendation

Retire the old `effect-service-design` skill. Its `make`,
`layerWithoutDependencies`, ready-made production `layer`, and mandatory
application-port/concrete-adapter split pull code away from the simpler module
shape we want.

Use Kit Langton's Effect skill as the Effect v4 implementation guide. It is
better evidence of Kit's preferences than trying to reconstruct them from
OpenCode. Do not turn OpenCode's v2 plugin architecture into a universal Effect
rule.

Do not reinstall a generic coding-standards skill for this repository. Adapt the
useful TypeScript rules in root `AGENTS.md`, then keep service admission,
persistence ownership, and Drizzle conventions in the nearest package
instructions. This keeps Osfo's architectural choices in the repository and
avoids another global source that can conflict with the codebase.

## What Kit's skill actually says

Kit's skill is a broad Effect v4 working guide, not a clean-architecture guide.
Its root file covers source selection and routes an agent to focused references
for schemas, services and layers, config, scheduling, caching, streams, HTTP
clients, and tests. It explicitly gives project conventions and the pinned
Effect source priority over the skill
([SKILL.md, lines 9-34](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/SKILL.md#L9-L34)).

For a service module, it recommends this public shape
([SERVICES_LAYERS.md, lines 5-69](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/SERVICES_LAYERS.md#L5-L69)):

```text
schemas and errors
Interface
Service extends Context.Service
layer = Layer.effect(Service, Effect.gen(...))
Service.of({ named Effect.fn methods })
export * as Domain from "./domain"
```

The self-export is presented as one opinionated module style, not an Effect
requirement. The skill warns about the resulting `Domain.Domain === Domain`
self-reference and says to use another style when the toolchain does not support
it.

The rest of the skill is concrete Effect practice:

- Keep Layer requirements visible and use `Layer.provide` only where a module
  truthfully chooses the implementation
  ([SERVICES_LAYERS.md, lines 71-119](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/SERVICES_LAYERS.md#L71-L119)).
- Use `Effect.fn` for public and non-trivial internal service operations, typed
  `Schema.TaggedErrorClass` failures, and Schema decoding at untrusted
  boundaries
  ([SKILL.md, lines 36-50](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/SKILL.md#L36-L50)).
- Keep long-lived work in the owning Layer scope
  ([SERVICES_LAYERS.md, lines 89-110](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/SERVICES_LAYERS.md#L89-L110)).
- Use first-class test services only for reusable, stateful test control. Static
  test implementations can use `Layer.succeed`; tiny partial mocks stay local
  ([TESTING.md, lines 56-112](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/TESTING.md#L56-L112)).
- Use Effect facilities for config, retry, caches, streams, HTTP clients, and
  deterministic tests instead of hand-written substitutes. The branch files
  give the exact selection rules.

## What Kit's skill does not say

Kit's skill does not prescribe any of these:

- an exported `make` for every service;
- `layerWithoutDependencies` plus a fully provided production `layer`;
- `defaultLayer`;
- a persistence `Context.Service` for every application service;
- application-owned ports beside every workflow;
- separate `services/`, `integrations/`, `db/`, or adapter directories;
- in-memory production state as the default;
- OpenCode-style plugin hooks and events for ordinary applications;
- a repository per table;
- a rule that every effectful workflow earns a `Context.Service`.

The service example yields `SqlClient` inside a `UserRepo` layer and exposes that
Layer's requirement. There is no second persistence port or exported factory
([SERVICES_LAYERS.md, lines 9-37](https://github.com/kitlangton/skills/blob/0cace2ae0bd65e0cb03ab12860b62ae5e043f0df/skills/effect/references/SERVICES_LAYERS.md#L9-L37)).

The missing piece is service admission. The skill says how to build an
application service after deciding one exists. It does not give a strong test
for deciding whether a workflow, projection, repository, or state owner should
be a service.

## How the three references fit together

### Effect's HTTP Users fixture

The HTTP example is an official Effect example. Its handler yields `Users` once
and calls small methods
([HTTP handler](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/fixtures/server/Users/http.ts#L8-L79)).
The current `Users` service uses an inline contract, a private SQL repository,
private extra queries, and static SQL and memory Layers
([Users service](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/51_http-server/fixtures/server/Users.ts#L32-L182)).

This is compatible with Kit's guidance. Both use `Context.Service`,
`Layer.effect`, `Effect.fn`, `Service.of`, thin callers, and private
implementation details. They differ in packaging:

```text
Effect fixture                 Kit/OpenCode module style
Users class                    Users module namespace
inline contract                Users.Interface
static layer members           Users.layer export
named class import             self-exported module import
```

The fixture proves that a public feature service may privately own SQL access.
It does not prove that every repository should be private. Effect's own Layer
composition guide also demonstrates a first-class `UserRepository` service
([Layer composition example](https://github.com/Effect-TS/effect/blob/648f566dd259898e7697c7fcb796183ccbc474ab/ai-docs/src/01_effect/03_services/20_layer-composition.ts#L20-L69)).
These are examples of the mechanism, not a framework rule for domain ownership.

### OpenCode v2

The v2 instructions target one specific migration. Core services are meant to
be hot-reloadable, in-memory state containers, while plugins own provider and
configuration policy
([v2 direction and service shape](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/specs/v2/instructions.md#L5-L35)).
That context explains the dumb container verbs, draft mutation, hooks, and
post-commit events. It is not a general prescription for SQL-backed product
workflows.

Current `Catalog` and `AgentV2` follow the module shape, but their implementation
has moved beyond the document. Their internal `layer` values are private and
they export location-specific nodes or layers
([Catalog](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/packages/core/src/catalog.ts#L47-L64),
[Catalog composition](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/packages/core/src/catalog.ts#L290-L301),
[AgentV2](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/packages/core/src/agent.ts#L35-L45),
[AgentV2 composition](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/packages/core/src/agent.ts#L105-L111)).
`Daemon` exports `layer`, not `defaultLayer`
([Daemon](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/packages/cli/src/services/daemon.ts#L11-L35)).
OpenCode removed remaining default-layer aliases in commit
[`6636683`](https://github.com/anomalyco/opencode/commit/663668332309ff1327ada2ce65a1f37d588cef32).

Attribution needs care. Dax wrote the v2 instructions in commit
[`8643c07`](https://github.com/anomalyco/opencode/commit/8643c0721eaffb052cf851a5d33d1d721647db5c),
and Dax authored the Daemon implementation. Kit later changed one schema-helper
name in the instructions. Kit contributed substantial parts of current
`AgentV2`, but the document and Daemon are OpenCode team practice, not direct
evidence of Kit's personal rules. Kit's own Effect skill is the primary source
for that claim.

OpenCode's root guide bans `import * as Name`, but its current source still uses
namespace imports throughout Effect and platform modules. That rule does not
describe the codebase consistently. The current Effect HTTP walkthrough uses
named imports from the `effect` and unstable HTTP barrels. This is separate from
the `export * as Name` service-module self-export used by OpenCode and Kit's
skill. Osfo therefore prefers named barrel imports while retaining namespace
imports for namespace-shaped APIs and the canonical service-module self-export.

## Version and API vintage

The evidence spans several Effect v4 snapshots. Osfo now matches the current
Effect tree at rc.111:

| Source                              | Effect version  | Evidence                                                                                                                                |
| ----------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode current tree               | `4.0.0-beta.83` | [`package.json`](https://github.com/anomalyco/opencode/blob/ad192a59b5517fb432bc5f4d27f131d605a22beb/package.json#L58-L68)              |
| Kit skill's deleted typecheck setup | `4.0.0-beta.97` | [`package.json` at publication](https://github.com/kitlangton/skills/blob/d94a9dd7719dff62dffefe83dd9c1bf40b6d1285/package.json#L9-L12) |
| Osfo                                | `4.0.0-rc.111`  | `package.json`                                                                                                                          |

Kit published the skill on 2026-07-15. The initial repository typechecked a
small API sample against beta.97, then removed the package, lockfile, and
typecheck setup later that day in commit
[`3bd6cd4`](https://github.com/kitlangton/skills/commit/3bd6cd47963de306dd9f1a3bbf35c540802f51ba).
The current skill still says to use current v4 APIs, but its repository no longer
declares or checks a package version.

The current Effect tree is `4.0.0-rc.111`. Its SQL-backed Users fixture landed
on 2026-08-13 in commit
[`a0743f2`](https://github.com/Effect-TS/effect/commit/a0743f2b9f20fb5d150f35510e68819f01630bac),
after Osfo's beta.105 tag on 2026-08-07. At beta.105, the same fixture already
had the clean inline `Context.Service` shape, but used private in-memory state
instead of SQL.

The module design transfers cleanly. Individual API recipes must be checked
against Osfo's installed rc.111 source. Kit's own source rule says the same.

## Recommended ownership split

### Effect skill

Keep Kit's installed Effect skill as the source for these concerns:

- current Effect v4 API selection;
- schemas and tagged failures;
- `Context.Service`, Layer construction, scope, and runtime wiring;
- `Effect.fn` conventions;
- config, schedules, cache, streams, HTTP clients, and Effect testing;
- the optional `Interface` / `Service` / `layer` / self-export module style.

Keep Osfo's service-admission and persistence rules in the repository. The
general Effect skill should not choose one application's ownership boundaries.

### Repository coding standards

Root `AGENTS.md` carries the high-frequency TypeScript rules: typed boundaries,
inference, direct control flow, honest helpers, import choices, and comments for
surprising constraints. The Effect skill owns Effect API recipes. Package-local
instructions own Worker service architecture and Drizzle schema conventions.

The former mandatory Application Service, application-owned port, outbound
Adapter, and composition taxonomy stays retired. It forced a separate
persistence interface even when a feature service could privately own its SQL.

### Osfo repository policy

The accepted ADR and nearest project instructions record these rules:

- the exact service-admission test;
- module namespace and self-export convention;
- PostgreSQL access is private to the owning feature service by default;
- a repository becomes a service only when it has independent callers,
  implementation selection, lifecycle, or authority;
- transaction invariants stay with one owner;
- `packages/db` owns schema, migration, Drizzle construction, and test support;
- feature code owns product queries;
- real database tests cover SQL and transaction semantics;
- the Effect version upgrade is separate from architecture migration.

## Risks of copying

1. The OpenCode v2 instructions describe hot-reloadable core containers. Copying
   their hooks, drafts, or in-memory Layers into Onboarding or Billing would solve
   a problem Osfo does not have.
2. `defaultLayer` is stale even inside OpenCode. Current code removed it.
3. OpenCode and Kit's original typecheck use older v4 snapshots than Osfo and
   Effect main. Typecheck every adopted API against Osfo's pinned release.
4. The self-export convention is useful but unusual. Verify Bun, TypeScript,
   lint, test discovery, and package exports before making it mandatory.
5. The official Effect docs show both a private repository inside `Users` and a
   first-class `UserRepository`. Ownership must come from Osfo's callers and
   transaction boundaries, not example-counting.
6. An in-memory replacement is honest only when it preserves observable
   semantics. PostgreSQL locking, uniqueness, retries, and rollback require real
   database tests.
7. Avoid a personality-derived skill. Preserve exact upstream text where useful,
   cite the source, and write Osfo decisions as Osfo decisions.
8. Skill edits will stop new drift but will not fix the current module graph. The
   architecture still needs a staged migration.

## Exact sources read

Every file under Kit's Effect skill at commit
`0cace2ae0bd65e0cb03ab12860b62ae5e043f0df` was read in full:

- `skills/effect/SKILL.md`
- `skills/effect/references/CACHING.md`
- `skills/effect/references/CONFIG.md`
- `skills/effect/references/HTTP_CLIENTS.md`
- `skills/effect/references/SCHEDULING.md`
- `skills/effect/references/SCHEMA.md`
- `skills/effect/references/SERVICES_LAYERS.md`
- `skills/effect/references/STREAMS.md`
- `skills/effect/references/TESTING.md`

Comparison sources:

- Effect commit `648f566dd259898e7697c7fcb796183ccbc474ab`, HTTP Users,
  handler, base service, Layer composition, and Layer testing examples.
- OpenCode commit `ad192a59b5517fb432bc5f4d27f131d605a22beb`, v2
  instructions, Catalog, AgentV2, and Daemon, plus their file histories.
- `/home/ren/.codex/skills/effect-service-design/SKILL.md` and
  `references/AUDIT.md`.
- `/home/ren/.codex/skills/coding-standards/SKILL.md`, especially lines
  265-475 and 710-725.
- Osfo `package.json` and the nearest `AGENTS.md` policy.

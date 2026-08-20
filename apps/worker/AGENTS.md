# Worker architecture

The Worker owns Osfo product behavior and runtime composition. Use these rules
when adding or changing Effect services, feature modules, handlers, persistence,
or Layers in `apps/worker`.

## Service admission

- Introduce a `Context.Service` when the application graph needs a callable
  capability whose implementation or lifetime can be selected, shared, scoped,
  or replaced. Independent callers, authority, state, resources, lifecycle, and
  runtime placement are common reasons.
- Keep behavior as a named `Effect.fn` workflow when it belongs to one owner and
  needs no independent capability identity. Keep pure decisions and
  transformations as ordinary functions.
- Give each invariant and authoritative transaction one owner. A workflow that
  only calls other owners does not become another service boundary.
- Add a service for production ownership and caller needs. Testing alone does
  not justify a pass-through service or repository.

## Service modules

- Put owned schemas, branded identifiers, and expected `Schema.TaggedError`
  failures at the top of the module. Re-export a canonical schema rather than
  defining a second identity when another package owns the wire contract.
- Define a small caller-oriented `Interface` and expose a `Service` class built
  with `Context.Service`. Implement a `layer` that returns `Service.of({ ... })`.
- Name public and non-trivial internal operations with
  `Effect.fn("Domain.operation")`.
- Keep implementation helpers, row codecs, SQL, and state private. Move a large
  private implementation into sibling files within the same feature module.
- Self-export the canonical module namespace with
  `export * as Name from "./name"`. Consumers use `Name.Service`, `Name.layer`,
  and domain operations through that namespace.
- Export an implementation Layer when composition, a real runtime alternative,
  or an honest test consumes it. Keep it private only when another public
  composition value is the intended seam.
- Choose operations from real callers and domain language. Container verbs such
  as `get`, `all`, and `update` fit containers. Workflow owners keep explicit
  domain verbs that reveal their transitions.

## Persistence and transactions

- Keep product SQL private to the feature that owns its behavior and invariants.
  Use a local repository value or private query helpers when no independent
  caller needs the repository.
- Promote persistence to its own service only when it has independent callers,
  runtime implementation selection, its own lifecycle, or separate authority.
- Keep decision and mutation inside one database transaction when correctness
  depends on the locked rows. Provider and network calls stay outside that
  transaction.
- Keep schema, migrations, Drizzle construction, and database test support in
  `packages/db`. Keep product queries and typed application failures here.
- Use real database tests for locking, uniqueness, rollback, and transaction
  behavior. An in-memory service replacement only covers semantics it can
  preserve honestly.
- Publish in-process events only for real observers. Durable post-commit delivery
  requires an outbox or another durable handoff.

## HTTP and composition

- Keep wire schemas and API definitions separate from server implementation.
  Handlers decode transport input, read request context, call one clear service
  or workflow, and map typed failures to responses.
- Keep Layer requirements visible until the composition root chooses an
  implementation. Use named, topologically ordered graph values instead of
  local provisioning scattered through handlers and workflows.
- Acquire the graph in the scope required by the Cloudflare entry point. A
  discoverable graph definition does not imply one process-global request scope.

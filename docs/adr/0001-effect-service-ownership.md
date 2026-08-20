---
status: accepted
---

# Own Effect services by authority

Osfo admits an Effect service when the application graph needs a callable
capability whose implementation or lifetime can be selected, shared, scoped, or
replaced. Independent callers, authority, state, resources, lifecycle, and
runtime placement can justify that identity. Effectful work and atomic invariants
alone do not.

Behavior owned by one module remains an ordinary function or named Effect. The
invariant owner owns its product queries and opens its transaction. Persistence
becomes a separate service only when callers consume it independently or its
implementation, authority, resource, or lifecycle varies at runtime.

Service modules use a caller-oriented `Interface`, a `Context.Service` tag, a
real Layer implementation, named operations, and a canonical namespace export.
Raw Layers stay public when composition or a real alternative consumes them.
See
[`docs/research/opencode-v2-effect-architecture.md`](../research/opencode-v2-effect-architecture.md)
for the source comparison and rejected universal rules.

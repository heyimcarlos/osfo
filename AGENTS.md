# Osfo policy

Stable contracts live here. Product truth lives in `CONTEXT.md`, durable decisions
in `docs/adr/`, and active work in GitHub Issues.

## Collaboration notes

- The user uses speech-to-text; infer likely intent from odd wording, ask only when
  needed.
- You always use the `unslop` skill to reply

## Reference repositories

Repositories under `.reference/` are read-only reference material.

- Before making an important implementation or pattern decision involving a related
  library, inspect the relevant reference repository and compare its source, tests,
  and examples.
- For library API truth, check the installed version first, then version-matched
  official source, documentation, and migration notes. Use reference applications
  to compare working patterns, not to override the installed API or upstream
  guidance.
- Do not edit, format, or generate files under `.reference/` unless explicitly asked.
- Do not import from `.reference/`. Application code must use its normal package
  dependencies.
- When given a Git URL for a missing reference, clone it into `.reference/`. Update
  an existing reference from its configured remote before relying on it.

## Package ownership

- `packages/api`: shared Effect HTTP contracts implemented by the Worker and
  consumed by clients. It owns paths, wire schemas, public transport errors,
  OpenAPI annotations, and middleware requirements, not product behavior.
- `packages/ui`: shared React DOM, Tailwind CSS, and shadcn/ui components,
  styles, hooks, and UI utilities. Every consumable path has an explicit
  package export. Keep Osfo-specific behavior in `apps/web`.
- `packages/auth`: private Better Auth policy and its request-scoped factory.
  Keep runtime configuration, database connections, and provider adapters in
  `apps/worker`.
- `packages/db`: private PostgreSQL schema, migrations, Drizzle construction,
  and database test support. Keep Cloudflare bindings, Effect integration,
  typed application failures, and product operations in `apps/worker`.
- `apps/worker`: Osfo product behavior, Cloudflare runtime composition, provider
  adapters, and authority-specific PostgreSQL, Agent SQLite, and R2 modules.
- `apps/web`: Osfo-specific web behavior and the browser composition root.
- Extract a workspace package only after a second consumer or supported public
  interface proves the seam.

## Engineering boundaries

- This is an Effect-first repository. Represent application effects, expected
  failures that need composition, resource lifetimes, concurrency, retries, and
  integration boundaries with Effect. Adapt Promise, callback, and throwing APIs
  once in the module that owns the external library. Keep total pure calculations
  as ordinary TypeScript values and functions.
- Preserve runtime behavior during lint, typing, or test structure changes.
- Use public package exports; never cross package boundaries with relative
  imports.
- Public PRs, commits, generated files, and documentation contain no private
  names, internal context, customer-derived data, or AI attribution.

## Code style

### TypeScript

- Keep logic at the call site until extraction creates reusable behavior, hides a
  complex boundary, or names a real concept.
- Let exported contracts and genuinely clarifying annotations carry explicit
  types. Rely on inference for local implementation details.
- Keep `any`, non-null assertions, and unchecked casts out of application code.
  Decode unknown input or prove it with a complete guard. When an interoperability
  boundary requires a cast that TypeScript cannot express, contain it in the
  owning adapter or constructor and document the runtime proof with `SAFETY:`.
- Prefer `const`, early returns, and direct property access. Reassignment,
  `else`, and destructuring should make the code clearer before they earn a place.
- Prefer `map`, `filter`, `flatMap`, and other collection operations when they
  express the transformation more directly than a loop.
- Keep the main export readable as the happy path. Put substantial validation or
  boundary helpers below it, close to their caller.
- Comment constraints and surprising behavior. Let the code explain ordinary
  assignments and control flow.

### Imports and modules

- Prefer named imports from package barrels when they expose the required names
  cleanly.
- Use `export * as Name from "./name"` for modules that intentionally expose one
  canonical namespace. Import that namespace by name at call sites.
- Do not use `import * as` or `import type * as`. A package or runtime
  interoperability exception requires a narrow lint suppression and a concrete
  reason beside the import.
- Keep imported names unchanged. When two type names genuinely collide, use an
  alias in a dedicated `import type` declaration.
- Keep dynamic imports inside the narrow branch that needs them when they avoid
  loading a heavy optional module on startup.

### Effect

- In Effect generators, bind services to named variables before calling methods.
  Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Die with an `Error` value so defects retain a message and stack. Do not pass a
  string or template literal directly to `Effect.die`.
- Recover expected failures through the typed error channel. Reserve
  `try`/`catch` for throwing or Promise boundaries.
- Keep total parsing helpers, transformations, and option building synchronous.
  A pure fallible decoder may return `Result` or a domain outcome when failure is
  retained as data, or `Effect` when it belongs to an Effect failure path.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` over manual
  `JSON.parse` wrapped in `Effect.try` for untrusted JSON strings. Choose the
  decoder by the required failure representation. Use `decodeUnknownOption` only
  when diagnostics are intentionally discarded.

## Verification and evidence

- Tests use Effect Vitest. Run scoped tests with `vitest run ...` or the
  package script. Never use `bun test`.
- Use the narrowest meaningful verification while iterating. Merge-ready gates
  are `bun run format:check`, `lint`, `typecheck`, and `test`.
- Format only files owned by the branch with `bunx oxfmt --write <files>`. Run
  `bun run format:check` before a PR.
- User-visible work require the relevant `@osfo/web` test, a production
  build, and inspection in the browser development instance. Record the exact
  commands and observable evidence in the issue or PR.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: root `CONTEXT.md` and `docs/adr/`. See
`docs/agents/domain.md`.

Record mistakes in `MISTAKES.md`, missing capabilities in `DESIRES.md`, and
environment discoveries in `LEARNINGS.md`.

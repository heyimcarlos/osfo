# Osfo policy

Stable contracts live here. Product truth lives in `CONTEXT.md`, durable decisions
in `docs/adr/`, and active work in GitHub Issues.

## Collaboration Notes

- The user uses speech-to-text; infer likely intent from odd wording, ask only when
  needed.

## Reference repositories

Repositories under `.reference/` are read-only reference material.

- Before making an important implementation or pattern decision involving a related
library, inspect the relevant reference repository and compare its source, tests,
and examples.
- Prefer patterns found in these repositories over generated guesses or web search
results.
- Do not edit, format, or generate files under `.reference/` unless explicitly asked.
- Do not import from `.reference/`. Application code must use its normal package
dependencies.
- When given a Git URL for a missing reference, clone it into `.reference/`. Update
an existing reference from its configured remote before relying on it.

## Package Ownership

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
  interface proves the seam. Create `packages/api` only when Worker and web share
  a real wire contract.

## Engineering boundaries

- Preserve runtime behavior during lint, typing, or test structure changes.
- Use public package exports; never cross package boundaries with relative
  imports.
- Public PRs, commits, generated files, and documentation contain no private
  names, internal context, customer-derived data, or AI attribution.

## Code style

### Effect

- In Effect generators, bind services to named variables before calling methods.
Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Do not return `Effect` from helpers unless they actually perform effectful work.
Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption`
over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.

## Verification and evidence

- Tests use Effect Vitest. Run scoped tests with `vitest run ...` or the
  package script. Never use `bun test`.
- Use the narrowest meaningful verification while iterating. Merge-ready gates
  are `bun run format:check`, `lint`, `typecheck`, and `test`.
- Run `bun run format` before a PR and include only files owned by the branch.
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

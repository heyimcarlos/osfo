# Osfo policy

Stable contracts live here. Product truth lives in `CONTEXT.md`, durable decisions
in `docs/adr/`, and active work in GitHub Issues.

## Verification and evidence

- Tests use Effect Vitest. Run scoped tests with `vitest run ...` or the
  package script. Never use `bun test`.
- Use the narrowest meaningful verification while iterating. Merge-ready gates
  are `bun run format:check`, `lint`, `typecheck`, and `test`.
- Changes to migrations, PostgreSQL configuration, or database access also run
  `bun run db:verify` against the digest-pinned real PostgreSQL service.
  In-memory substitutes do not certify PostgreSQL behavior.
- Run `bun run format` before a PR and include only files owned by the branch.
- User-visible web changes require the relevant `@osfo/web` test, a production
  build, and inspection in the browser development instance. Record the exact
  commands and observable evidence in the issue or PR.
- Report required gates as PASS, FAIL, or MISSING. Never present an omitted or
  skipped gate as passing evidence.

## Collaboration Notes

- The user uses speech-to-text; infer likely intent from odd wording, ask only when
  needed.
- Code is cheap to write: no time estimates, implementation time isn't a blocker.
- Never use em-dashes anywhere. Use commas, colons, parentheses, or separate sentences.
- Always reply in ASD-STE100 Simplified Technical English

## Reference Repositories

Repos in `.reference` (effect, executor, AnswerOverflow, flue, ...) are available
for patterns. Clone a given Git URL into `.reference` and pull latest before using
it.

## Engineering boundaries

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior during lint, typing, or test structure changes.
- Use public package exports; never cross package boundaries with relative
  imports.
- Extract shared logic only for genuinely shared behavior. Avoid generic
  abstractions for one-off duplication.
- Public PRs, commits, generated files, and documentation contain no private
  names, internal context, customer-derived data, or AI attribution.

## Package Ownership

- `packages/ui`: shared React DOM, Tailwind CSS, and shadcn/ui components,
  styles, hooks, and UI utilities. Every consumable path has an explicit
  package export. These artifacts are not native-mobile components.
- `packages/session`: closed, versioned canonical ThreadEvent schemas and
  constructors shared by transport, persistence, and future client folds. It
  contains no process wiring or PostgreSQL access.
- `packages/api`: schema-first HTTP endpoint groups, generated client behavior,
  handlers, and Effect-native domain interfaces. It contains no Node process
  construction, database access, or Agent Application configuration.
- `packages/db`: Drizzle schema and migrations, PostgreSQL connection ownership,
  database adapters, and database integration test support. It exposes domain
  interfaces rather than raw database clients. Migrations do not contain product
  behavior.
- `apps/{web, ingress, agent-run-worker}`: product composition roots.

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

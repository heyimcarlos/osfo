# Osfo policy

Stable contracts live here. Product truth lives in `CONTEXT.md`, durable decisions in `docs/adr/`, and active work in GitHub Issues.

## Verification and evidence

- Tests use Vitest through package scripts. Run the narrowest relevant package
  test while iterating, and never use `bun test`.
- Merge-ready gates are `bun install --frozen-lockfile`, `bun run build`,
  `bun run format:check`, `bun run lint`, `bun run typecheck`, and
  `bun run test`.
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

- The user uses speech-to-text; infer likely intent from odd wording, ask only when needed.
- Code is cheap to write: no time estimates, implementation time isn't a blocker.
- Never use em-dashes anywhere. Use commas, colons, parentheses, or separate sentences.

## Reference Repositories

Repos in `.reference` (effect, executor, AnswerOverflow, flue, ...) are available for patterns. Clone a given Git URL into `.reference` and pull latest before using it.

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

- `apps/web`: browser Reference Agent Application composition root and
  app-specific routes, state, and presentation. It consumes shared UI only
  through `@osfo/ui` exports.
- `apps/native-thread-transport`: Native Thread Transport process composition
  root, including Node runtime wiring and transport-specific configuration.
- `apps/agent-run-worker`: AgentRun worker process composition root, including
  Node runtime wiring and worker-specific configuration.
- `packages/ui`: shared React DOM, Tailwind CSS, and shadcn/ui components,
  styles, hooks, and UI utilities. Every consumable path has an explicit
  package export. These artifacts are not native-mobile components.
- `migrations/`: ordered, versioned PostgreSQL schema migrations. Migrations do
  not contain product behavior.
- `scripts/`: repository operations and migration verification. Scripts may
  compose packages, but do not become an application or domain module.
- Root workspace files own exact dependency catalogs, Bun and Turbo behavior,
  TypeScript project references, and the local PostgreSQL development profile.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: root `CONTEXT.md` and `docs/adr/`. See
`docs/agents/domain.md`.

Note mistakes in MISTAKES.md, missing context or tools in DESIRES.md, and env learnings in LEARNINGS.md.

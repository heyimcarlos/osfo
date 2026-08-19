# Osfo policy

Stable contracts live here. Product truth lives in `CONTEXT.md`, durable decisions
in `docs/adr/`, and active work in GitHub Issues.

## Collaboration Notes

- The user uses speech-to-text; infer likely intent from odd wording, ask only when
  needed.

## Reference repositories

Repositories under `.reference/` are read-only reference material.

- Before making an important implementation or pattern decision involving a related library, inspect the relevant reference repository and compare its source, tests, and examples.
- Prefer patterns found in these repositories over generated guesses or web search results.
- Do not edit, format, or generate files under `.reference/` unless explicitly asked.
- Do not import from `.reference/`. Application code must use its normal package dependencies.
- When given a Git URL for a missing reference, clone it into `.reference/`. Update an existing reference from its configured remote before relying on it.

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

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior during lint, typing, or test structure changes.
- Use public package exports; never cross package boundaries with relative
  imports.
- Extract shared logic only for genuinely shared behavior. Avoid generic
  abstractions for one-off duplication.
- Public PRs, commits, generated files, and documentation contain no private
  names, internal context, customer-derived data, or AI attribution.

## Code style

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Effect

- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.

## Verification and evidence

- Tests use Effect Vitest. Run scoped tests with `vitest run ...` or the
  package script. Never use `bun test`.
- Use the narrowest meaningful verification while iterating. Merge-ready gates
  are `bun run format:check`, `lint`, `typecheck`, and `test`.
- Run `bun run format` before a PR and include only files owned by the branch.
- User-visible work require the relevant `@osfo/web` test, a production
  build, and inspection in the browser development instance. Record the exact
  commands and observable evidence in the issue or PR.

### Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests

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

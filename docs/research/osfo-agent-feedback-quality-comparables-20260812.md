# Osfo agent feedback and quality comparables

Date: 2026-08-12

## Decision frame

- Target project: Osfo and the Cloudflare-first Oz v1 implementation effort.
- Current stack: TypeScript 7, Effect 4 beta, Effect Vitest, Effect tsgo,
  Oxlint, Oxfmt, Bun, Turbo, Cloudflare, Think, Drizzle, and Alchemy.
- Target stack: the same Effect-first stack with explicit type tests, repository
  lint policy, normal pull-request CI, and one transparent scenario harness.
- Domain and scale: a multi-tenant personal Agent product with durable state,
  external effects, recovery, and strict authority boundaries.
- Hard constraints: tests use Effect Vitest, agents report `PASS`, `FAIL`, or
  `MISSING`, user-visible work is inspected while running, and end-to-end
  coverage must grow without delaying the first application foundation.
- Key questions:
  - How should an implementation agent receive failed-check feedback and repair
    its work recursively?
  - Which checks prove source types, public type behavior, and runtime behavior?
  - How should one scenario run across several targets with useful artifacts?
  - Which reference rules are safe to adopt, and which are local opinions?

## Ranked comparables

| Rank | Source         | Score | Best match                                                             | Mismatch                                                  | Use for                                                            |
| ---: | -------------- | ----: | ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
|    1 | Executor       | 32/35 | Effect application with a scenario by target system and rich artifacts | Larger multi-host product                                 | Scenario API, target capabilities, artifacts, modular Oxlint rules |
|    2 | OpenCode       | 30/35 | Mature coding Agent with operational browser matrices                  | Uses `bun test`, which Osfo forbids                       | Transition matrices and negative-control oracle tests              |
|    3 | Effect         | 29/35 | Canonical Effect TypeScript repository with type tests and broad CI    | Library monorepo, not an Agent product                    | Effect diagnostics, TSTyche, CI, package rules                     |
|    4 | Accountability | 23/35 | Strict Effect diagnostics and recursive failed-check feedback          | Young repository with one large inline lint configuration | Diagnostic selection and feedback-loop concepts                    |

Scoring criteria are domain fit, target-stack fit, production maturity,
architecture clarity, infrastructure relevance, testing quality, and
documentation signal. Each criterion is scored from zero to five.

## Repository architecture extracts

### Executor

- Repository: [UsefulSoftwareCo/executor at f674fb80](https://github.com/UsefulSoftwareCo/executor/tree/f674fb80eebd597f922edd5ec21b8035ab195a78)
- `e2e/src/scenario.ts` defines the one test-author interface. Its Effect body
  declares required target services. Each run gets isolated identity and an
  artifact directory.
- `e2e/vitest.config.ts` applies the same scenario files to cloud, self-hosted,
  Cloudflare, desktop, local, CLI, and operating-system targets.
- `e2e/src/scenario.ts` writes `result.json` for executed tests and
  `skipped.json` with missing services for unsupported targets.
- `e2e/src/viewer/manifest.ts` constructs a machine-readable scenario by target
  manifest.
- `e2e/src/timeline.ts` and `e2e/src/trace-harvest.ts` connect browser, terminal,
  and semantic trace evidence without adding test-only delays to normal runs.
- `scripts/oxlint-plugin-executor.js` exports small rule modules. Important
  rules forbid direct Vitest imports, conditional assertions, raw fetch,
  cross-package relative imports, untyped errors, TypeScript escape hatches,
  unknown-shape probing, and duplicated schema or value types.
- `.oxlintrc.jsonc` uses narrow overrides for harness and boundary files where a
  general application rule does not apply.
- Practices to emulate:
  - one scenario interface;
  - target capabilities declared by Effect services;
  - visible unsupported-target records, translated locally to
    `NOT_APPLICABLE` with a reason and no verdict;
  - `MISSING` when an applicable target lacks a required capability;
  - structured results and review artifacts;
  - small lint rules with rule tests and scoped overrides.
- Practices to avoid:
  - copying all targets before Oz has one complete vertical slice;
  - allowing CI retries to hide a first failure;
  - adopting a rule without checking its boundary assumptions.

### OpenCode

- Repository: [anomalyco/opencode at 1f94d8a3](https://github.com/anomalyco/opencode/tree/1f94d8a3c86b67f4f49a0e341de74e9188381b3a)
- `packages/app/e2e/performance/timeline-stability/transition-matrix.spec.ts`
  defines UI transition matrices and observable region invariants.
- `packages/app/e2e/performance/timeline-stability/oracle-browser.spec.ts`
  injects opacity faults and proves that the visual oracle detects them.
- `.github/workflows/test.yml` separates unit and browser end-to-end jobs and
  uploads browser artifacts.
- Practices to emulate:
  - express state transitions as a matrix;
  - test important test oracles with known faults;
  - retain browser evidence for review.
- Practices to avoid:
  - its `bun test` runner, because Osfo uses Effect Vitest;
  - treating a retry-only artifact as a passing first attempt.

### Effect

- Repository: [Effect-TS/effect at bef7bf38](https://github.com/Effect-TS/effect/tree/bef7bf38ae4b73d5511043f707aed083de5da7cc)
- `package.json` separates compilation, runtime tests, type tests, lint,
  documentation generation, dependency checks, and performance checks.
- `packages/effect/typetest/*.tst.ts` uses TSTyche to verify inferred public type
  behavior without executing code.
- `.github/workflows/check.yml` runs independent lint, type, build, test,
  documentation, and circular-dependency jobs. Runtime tests use several
  JavaScript runtimes and integration services.
- `.oxlintrc.json` extends `packages/tools/oxc/oxlintrc.json`. The shared
  configuration enables correctness, suspicious, and performance categories
  and Effect-specific import and API rules.
- Practices to emulate:
  - keep compiler checks, type behavior tests, and runtime tests separate;
  - run Effect diagnostics in normal development and CI;
  - run independent CI jobs so failures remain easy to classify;
  - keep package and generated-file checks explicit.
- Practices to avoid:
  - copying library-only checks that do not apply to an application;
  - relying on type tests to prove runtime Schema behavior.

### Accountability

- Repository: [mikearnaldi/accountability at c07a6eac](https://github.com/mikearnaldi/accountability/tree/c07a6eac1bff48e350b558891e97710132a24806)
- `tsconfig.base.json` configures Effect diagnostics for floating Effects,
  missing requirements, invalid generator patterns, untyped failure handling,
  and strict Layer provision.
- `eslint.config.mjs` defines rules for raw fetch, silent error swallowing,
  ignored Effects, nested Layer provision, SQL type parameters, local storage,
  and navigation boundaries.
- `ralph-auto.sh` preserves failed check output in
  `.ralph-auto/ci_errors.txt` and inserts it into the next agent prompt. A
  completion signal runs typecheck, lint, build, unit tests, and optional
  end-to-end tests.
- `packages/web/playwright.config.ts` starts a built application with a real
  PostgreSQL container and records failure artifacts.
- Practices to emulate:
  - give the next repair iteration the exact failed-check output;
  - enable strict Effect diagnostics at compile time;
  - test the production build against a real database boundary.
- Practices to avoid:
  - one 916-line inline lint configuration without separate rule tests;
  - a `--skip-checks` completion path;
  - staging all changes or committing partial work automatically;
  - making end-to-end checks optional without an applicability record;
  - omitting lint, formatting, and production build from pull-request CI.

## Tool and standards guidance

### Effect TypeScript diagnostics

Effect tsgo adds Effect-specific diagnostics to normal TypeScript feedback. It
can detect invalid Effect composition that structural TypeScript checks alone
do not express. Osfo already patches TypeScript and Oxlint with `effect-tsgo`.
The quality foundation must define and test the repository diagnostic severity
instead of relying on package defaults.

### TSTyche

TSTyche provides compile-time assertions for inferred and assignable types. It
does not execute code. Osfo should use it only for public type behavior and keep
runtime Schema tests in Effect Vitest.

### Oxlint

Oxlint supports committed project configuration, file overrides, type-aware
rules, and JavaScript plugins. JavaScript plugin support is alpha. Osfo must pin
the tool version, keep custom rules small, test them, and prefer built-in rules
when equivalent behavior exists.

## Recommended shape

### Recursive ticket loop

Each ticket writes an acceptance matrix before implementation. The agent starts
with focused failing tests, implements the change, runs the production-shaped
system, emits structured evidence, and requests independent Standards and Spec
reviews. A failure adds or strengthens a regression test and restarts the loop
from the narrowest affected check. User feedback enters the same path.

### Type and runtime layers

1. Effect tsgo and the repository typecheck verify source and Effect diagnostic
   correctness.
2. TSTyche verifies public type inference and forbidden usage.
3. Effect Vitest verifies runtime Schema, Layer, failure, interruption,
   concurrency, and adapter behavior.

### CI

Pull requests run formatting, lint, Effect diagnostics and typecheck, type tests,
Effect Vitest, applicable builds, and deterministic scenario targets as separate
jobs. External live smoke tests run after merge in a protected environment. The
complete live target matrix runs before release or promotion.

### Scenario package

Create one standard package with a `scenario()` API, Effect target Layers,
isolated run identity, a scenario by target manifest, and structured results.
The first slice contains one representative Worker and Durable Object smoke
scenario. Later tickets extend the same package with accepted product journeys.

## Options

| Option                                            | Points | When to choose                                       | Risks                                               | First slice                                                    |
| ------------------------------------------------- | -----: | ---------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| A. Checks only                                    |   6/10 | The product has no runtime integration yet           | End-to-end standards drift before the first journey | Add lint, diagnostics, type tests, and CI                      |
| B. Quality gates plus a small scenario foundation |  10/10 | Oz is starting its Cloudflare application foundation | Requires one early cross-cutting package            | Add checks first, then one standard scenario and result format |
| C. Full Executor-style suite now                  |   7/10 | All target hosts and journeys are already stable     | Large up-front harness with speculative targets     | Build all target and artifact systems before features          |

## Final recommendation

- Recommended option: B, quality gates plus a small scenario foundation.
- Why: it makes every implementation ticket accountable now and prevents the
  end-to-end interface from fragmenting. It does not delay the foundation for a
  complete product suite.
- What to do first: configure Effect diagnostics, type tests, Oxlint policy,
  normal pull-request CI, and the recursive ticket contract.
- What to defer: the complete Oz journey suite, live provider matrix, visual
  viewer, video timeline, and production qualification workloads.
- What would invalidate the recommendation: a selected platform cannot run the
  same Effect scenario contract across local, preview, and live targets.

## Sources

All web sources were accessed on 2026-08-12.

- [Effect repository](https://github.com/Effect-TS/effect)
- [Effect check workflow](https://github.com/Effect-TS/effect/blob/main/.github/workflows/check.yml)
- [Effect Language Service](https://github.com/Effect-TS/language-service)
- [TSTyche documentation](https://tstyche.org/)
- [TSTyche expect API](https://tstyche.org/reference/expect-api)
- [Executor repository](https://github.com/UsefulSoftwareCo/executor)
- [Executor scenario harness](https://github.com/UsefulSoftwareCo/executor/blob/main/e2e/src/scenario.ts)
- [OpenCode repository](https://github.com/anomalyco/opencode)
- [OpenCode oracle test](https://github.com/anomalyco/opencode/blob/dev/packages/app/e2e/performance/timeline-stability/oracle-browser.spec.ts)
- [Accountability repository](https://github.com/mikearnaldi/accountability)
- [Accountability lint configuration](https://github.com/mikearnaldi/accountability/blob/main/eslint.config.mjs)
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)

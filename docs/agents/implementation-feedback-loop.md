# Implementation feedback loop

This contract applies to every implementation ticket. Product requirements come
from the ticket, `CONTEXT.md`, and the applicable specification and ADRs. This
contract defines how an agent proves that its implementation meets those
requirements.

## Completion rule

A ticket is complete only when all applicable evidence is present and passing.
Required evidence has one of these verdicts:

- `PASS`: the check passed against the identified revision and target.
- `FAIL`: a check, assertion, review, or observable behavior failed.
- `MISSING`: required evidence was not produced or cannot be trusted.

`NOT_APPLICABLE` is an applicability value, not a verdict. It requires a reason.
An agent must not close a ticket with a required `FAIL` or `MISSING` result.

## Required loop

```text
acceptance matrix
  -> failing focused test or type test
  -> implementation
  -> focused checks
  -> applicable WRDN skill checks
  -> production-shaped running system
  -> machine-readable evidence
  -> independent Standards review and Spec review
  -> complete applicable gates

Any FAIL
  -> diagnose the cause
  -> add or strengthen a regression test
  -> fix the cause
  -> repeat from the narrowest affected check

User feedback
  -> add a matrix case
  -> reproduce it as a failing check when possible
  -> enter the same repair loop
```

Do not use a retry to change an initial failure into `PASS`. A retry can collect
more evidence. A failure followed by a pass remains `FAIL` until the cause is
understood, fixed, and the affected checks pass from a clean state.

## 1. Establish a baseline

Before editing, run the narrowest checks that cover the target area. Record any
pre-existing failure. Do not claim a pre-existing failure as a result of the
ticket, and do not hide it in the final evidence.

## 2. Write the acceptance matrix

Add the matrix to the issue or its linked evidence before implementation. Each
row identifies the requirement, test layer, target, applicability, evidence,
and verdict.

```markdown
| Requirement      | Layer   | Target       | Applicable | Evidence            | Verdict |
| ---------------- | ------- | ------------ | ---------- | ------------------- | ------- |
| Example behavior | Runtime | Local Worker | Yes        | command or artifact | MISSING |
```

Consider every dimension below. A ticket can mark a dimension not applicable
only with a reason.

- normal behavior;
- public type behavior;
- invalid and boundary input;
- duplicate and idempotent operation;
- concurrency and ordering;
- interruption, recovery, and replay;
- authority loss and revocation;
- external-provider ambiguity;
- observability and evidence;
- resource cleanup;
- browser behavior;
- database and migration behavior.

The implementer expands the exact cases. The Spec reviewer checks that the
matrix covers the ticket and its governing product contract.

## 3. Use Effect-first verification

Tests use Effect Vitest. Never use `bun test`.

Use three separate type and boundary layers when they apply:

1. Effect TypeScript diagnostics and the repository typecheck verify source
   correctness, Effect requirements, typed failures, and invalid Effect usage.
2. Dedicated type tests verify public inference, success, error, requirement,
   overload, and forbidden-call behavior. Type tests do not execute code.
3. Effect Vitest verifies runtime schemas, Layers, failures, interruption, time,
   concurrency, and observable behavior.

A public API change needs a type test when it has compile-time behavior that a
runtime test cannot prove. A change to a runtime boundary requires a runtime
schema or adapter test. One does not replace the other.

## 4. Use contextual review skills

When a local WRDN skill's documented trigger matches the current change, use the
skill as contextual guidance. Fix each actionable finding through the recursive
repair loop. Skills guide agent and human judgment. Direct lint, typecheck, test,
and independent review remain the executable evidence.

## 5. Repair recursively

Run the narrowest meaningful check after each change. If it fails:

1. preserve the exact error and relevant artifacts;
2. find the cause;
3. add or strengthen a regression test when the failure was not already
   represented;
4. fix the cause;
5. rerun the failed check and its affected downstream checks.

Do not bypass a check, weaken an assertion, add an unverified ignore, or commit
partial work as complete. Stop only for a real blocker that needs new authority,
external access, or a product decision.

## 6. Test the running implementation

Runtime work must include a production-shaped execution on every applicable
deterministic target. Test the built artifact when packaging or deployment can
change behavior.

User-visible work must provide a stable review surface, such as a development
URL, plus the relevant screenshots, traces, or structured results. Human
acceptance blocks complete user-visible vertical slices. Internal foundation
tickets do not require human acceptance unless they change visible behavior.

User feedback becomes a new matrix row. Reproduce it as a failing automated
check when the behavior is deterministic. If automation is not possible, record
the repeatable manual procedure and observable result.

## 7. Run independent reviews

Two fresh reviewer agents review the completed diff independently:

- **Standards review**: checks the repository policies, boundaries, code
  quality, and documented engineering rules.
- **Spec review**: checks the ticket, acceptance matrix, product specification,
  and applicable ADRs for omissions, incorrect behavior, and scope growth.

A reviewer does not approve its own implementation. Each review reports its own
findings and verdict. Do not merge the two axes into one score. Any actionable
finding makes that review `FAIL` and returns the implementation to the repair
loop. Rerun both reviews after a material fix.

## 8. Run the applicable gates

Every ticket runs the repository merge-ready gates:

- `bun run format:check`;
- `bun run lint`;
- `bun run typecheck`;
- dedicated type tests when public type behavior changes;
- every WRDN skill triggered by the final diff or lint findings;
- `bun run test`.

Also run these gates when applicable:

- production build for a deployable or user-visible change;
- relevant browser test and browser inspection for web changes;
- `bun run db:verify` for migrations, PostgreSQL configuration, or PostgreSQL
  access;
- deterministic scenario targets for runtime behavior;
- generated-output drift checks when source changes affect committed derived
  artifacts. A generated artifact must reproduce from a clean checkout and must
  not depend on ignored machine-local files;
- protected live smoke tests for external adapters after merge;
- the complete live target matrix before release or promotion.

The full end-to-end suite does not need to run for a ticket that cannot affect
it. The applicability matrix must explain that choice.

## Transparent scenario harness direction

Osfo will grow one standard end-to-end package. It will provide:

- one `scenario()` interface for test authors;
- Effect service requirements as the scenario capability declaration;
- the same scenario body across local, preview, and live targets;
- isolated identity and storage for every scenario run;
- explicit `NOT_APPLICABLE` target rows with a reason and no verdict;
- a `MISSING` verdict when an applicable target lacks a required capability;
- a machine-readable scenario by target manifest;
- structured results with scenario, target, revision, duration, verdict, error,
  and artifact paths;
- screenshots, browser traces, video, terminal output, and semantic trace links
  when applicable;
- a concise human summary;
- negative-control tests that prove important test oracles detect an injected
  fault.

The first harness ticket establishes this interface, result format, and one
representative smoke scenario. It does not build the complete Oz journey suite.
Each later runtime ticket adds its accepted scenarios to the same package.

## Reference repository use

Before an unfamiliar Effect pattern or a new pattern decision, update the
relevant clean clone under `.reference`, search the local repositories, and
record the selected repository revision and file path in the issue or PR.
Prefer current evidence from Effect, Executor, OpenCode, and other relevant
references over remembered code shapes. Do not copy a pattern without checking
its local boundary and failure semantics.

## Final evidence

The issue or PR records:

- the final acceptance matrix;
- exact commands and targets;
- the tested revision;
- structured result and artifact paths;
- the WRDN applicability table and final skill verdicts;
- Standards and Spec review verdicts;
- user feedback and resulting regression cases, when present;
- every remaining `FAIL` or `MISSING` item.

Only complete passing evidence produces `PASS`.

## Acceptance matrix

| Requirement                | Layer                                                     | Target                | Applicable                      | Evidence                     | Verdict |
| -------------------------- | --------------------------------------------------------- | --------------------- | ------------------------------- | ---------------------------- | ------- |
| <!-- exact requirement --> | <!-- Source type, type behavior, runtime, CI, process --> | <!-- exact target --> | <!-- Yes, or No with reason --> | <!-- command or artifact --> | MISSING |

Use only `PASS`, `FAIL`, or `MISSING` for applicable evidence. Use `NOT_APPLICABLE` only in the Applicable column, with a reason and no verdict.

## Revision and exact commands

- Tested revision: <!-- full commit SHA -->
- Exact commands and targets:
  - <!-- command -->

## Structured results and artifacts

- Machine-readable result paths: <!-- path or MISSING -->
- Screenshots, traces, logs, or terminal artifacts: <!-- paths or NOT_APPLICABLE with reason -->

## User feedback

- Feedback received: <!-- exact feedback, or none -->
- Added matrix and regression cases: <!-- cases, or NOT_APPLICABLE with reason -->

## Attempt ledger

| Gate          | Attempt kind | Verdict | Diagnosis                    | Regression test              | Fix                          | Evidence          |
| ------------- | ------------ | ------- | ---------------------------- | ---------------------------- | ---------------------------- | ----------------- |
| <!-- gate --> | initial      | MISSING | <!-- required after FAIL --> | <!-- required after FAIL --> | <!-- required after FAIL --> | <!-- artifact --> |

An evidence retry can collect more output, but it cannot change an initial `FAIL` to `PASS`. After a failure, record the diagnosis, regression test, fix, and a fresh repair-verification attempt.

## WRDN applicability

| Installed skill          | Applicable | Reason                      | Execution               | Verdict |
| ------------------------ | ---------- | --------------------------- | ----------------------- | ------- |
| <!-- wrdn skill name --> | Yes or No  | <!-- diff or lint cause --> | <!-- skill evidence --> | MISSING |

Run `bun run wrdn:check`. Record every discovered skill, a reason when it is not applicable, and the result of every triggered skill.

## Independent reviews

- Standards review: MISSING <!-- reviewer and report -->
- Spec review: MISSING <!-- reviewer and report -->

## Final verdicts

- Formatting: MISSING
- Lint: MISSING
- Effect diagnostics and typecheck: MISSING
- Public type tests: MISSING
- Effect Vitest: MISSING
- Production build: MISSING
- Generated-output drift: MISSING
- WRDN pass: MISSING
- Final ticket verdict: MISSING

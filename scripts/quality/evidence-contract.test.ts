import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { resolveGateVerdict } from "./evidence-verdict.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("implementation evidence contract", () => {
  it("does not convert an initial failure to PASS through an evidence retry", () => {
    expect(
      resolveGateVerdict([
        { kind: "initial", verdict: "FAIL" },
        { kind: "evidence-retry", verdict: "PASS" },
      ]),
    ).toBe("FAIL");
  });

  it("lets an evidence retry expose a later failure", () => {
    expect(
      resolveGateVerdict([
        { kind: "initial", verdict: "PASS" },
        { kind: "evidence-retry", verdict: "FAIL" },
      ]),
    ).toBe("FAIL");
  });

  it("keeps an incomplete failed repair verification visible", () => {
    expect(
      resolveGateVerdict([
        { kind: "initial", verdict: "PASS" },
        {
          kind: "repair-verification",
          verdict: "FAIL",
          diagnosis: "",
          regressionTest: "",
          fix: "",
        },
      ]),
    ).toBe("FAIL");
  });

  it("does not clear failure with whitespace-only repair evidence", () => {
    expect(
      resolveGateVerdict([
        { kind: "initial", verdict: "FAIL" },
        {
          kind: "repair-verification",
          verdict: "PASS",
          diagnosis: " ",
          regressionTest: " ",
          fix: " ",
        },
      ]),
    ).toBe("FAIL");
  });

  it("does not replace failure with a missing repair verification", () => {
    expect(
      resolveGateVerdict([
        { kind: "initial", verdict: "FAIL" },
        {
          kind: "repair-verification",
          verdict: "MISSING",
          diagnosis: "Cause understood.",
          regressionTest: "Regression added.",
          fix: "Repair applied.",
        },
      ]),
    ).toBe("FAIL");
  });

  it("accepts PASS only after a recorded repair verification", () => {
    expect(
      resolveGateVerdict([
        { kind: "initial", verdict: "FAIL" },
        {
          kind: "repair-verification",
          verdict: "PASS",
          diagnosis: "The inventory included ignored files.",
          regressionTest: "Ignored files do not alter coverage.",
          fix: "Count Git-index tracked files only.",
        },
      ]),
    ).toBe("PASS");
  });

  it("keeps an invalid or absent initial attempt MISSING", () => {
    expect(resolveGateVerdict([])).toBe("MISSING");
    expect(resolveGateVerdict([{ kind: "evidence-retry", verdict: "PASS" }])).toBe("MISSING");
  });

  it("checks every required PR evidence field", async () => {
    const template = await readFile(joinTemplate(), "utf8");
    for (const required of [
      "## Acceptance matrix",
      "## Revision and exact commands",
      "Tested revision:",
      "Exact commands and targets:",
      "## Structured results and artifacts",
      "Machine-readable result paths:",
      "Screenshots, traces, logs, or terminal artifacts:",
      "## User feedback",
      "Feedback received:",
      "Added matrix and regression cases:",
      "## Attempt ledger",
      "## WRDN applicability",
      "Installed skill",
      "Run `bun run wrdn:check`",
      "## Independent reviews",
      "Standards review: MISSING",
      "Spec review: MISSING",
      "## Final verdicts",
      "WRDN pass: MISSING",
      "Final ticket verdict: MISSING",
    ]) {
      expect(template).toContain(required);
    }
  });
});

const joinTemplate = () => resolve(repoRoot, ".github/PULL_REQUEST_TEMPLATE.md");

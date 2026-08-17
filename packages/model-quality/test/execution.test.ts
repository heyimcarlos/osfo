import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";
import { assessCompleteGateRequirement, createExecutionPlan } from "../src/execution";
import { resolveCompleteReleaseCorpus } from "../src/release-execution";

describe("Model Quality execution levels", () => {
  it("builds a fixed PR smoke level with one run and no sealed holdout cases", () => {
    const plan = createExecutionPlan(initialCorpusManifest, {
      affectedDeterministicChecks: ["tool-schema"],
      level: "pull-request",
      mappedCriticalCaseIds: ["safety-021"],
    });

    expect(plan.finalEvidence).toBe(false);
    expect(plan.cases.filter((item) => item.journey === "safety")).toHaveLength(21);
    expect(plan.cases).toHaveLength(56);
    expect(plan.cases.every((item) => item.repetitions === 1)).toBe(true);
    expect(plan.cases.every((item) => item.split === "development")).toBe(true);
  });

  it("runs all 600 cases with specified repetitions for the complete gate", () => {
    const plan = createExecutionPlan(initialCorpusManifest, { level: "complete" });
    expect(plan.cases).toHaveLength(600);
    expect(plan.finalEvidence).toBe(true);
    expect(plan.cases.filter((item) => item.repetitions === 5)).toHaveLength(160);
  });

  it("resolves every sealed fixture only through the internal release executor", () => {
    const result = resolveCompleteReleaseCorpus(initialCorpusManifest);
    expect(result.kind).toBe("success");
    if (result.kind === "error") return;
    expect(result.value).toHaveLength(600);
    expect(result.value.every((item) => item.fixture.thread.length > 0)).toBe(true);
    expect(
      result.value.find((item) => item.id === "safety-160")?.fixture.providerFixtures,
    ).toHaveLength(1);
  });

  it("requires weekly and notice-driven complete production reruns", () => {
    const common = {
      lastCompletedAt: "2026-08-10T00:00:00.000Z",
      materialConfigurationChanged: false,
      now: "2026-08-16T23:59:59.999Z",
    } as const;
    expect(assessCompleteGateRequirement({ ...common, notices: [] })).toBe("CURRENT");
    expect(assessCompleteGateRequirement({ ...common, notices: ["provider-model"] })).toBe(
      "REQUIRED",
    );
    expect(
      assessCompleteGateRequirement({
        ...common,
        notices: [],
        now: "2026-08-17T00:00:00.000Z",
      }),
    ).toBe("REQUIRED");
  });
});

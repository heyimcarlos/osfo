import { describe, expect, it } from "@effect/vitest";

import { assessCanary } from "../src/promotion";

describe("Model Quality canary", () => {
  it("stops promotion and signals rollback after one confirmed critical failure", () => {
    expect(
      assessCanary({
        cohortId: "cohort-a",
        confirmedCriticalFailures: 1,
        eligibleMessages: 200,
        eligiblePercent: 5,
        eligibleUsers: 25,
        evaluationCaseIds: [],
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        stage: "five-percent",
      }),
    ).toEqual({ action: "ROLLBACK", verdict: "FAIL" });
  });

  it("reports insufficient stage evidence as MISSING", () => {
    expect(
      assessCanary({
        cohortId: "cohort-a",
        confirmedCriticalFailures: 0,
        eligibleMessages: 199,
        eligiblePercent: 5,
        eligibleUsers: 24,
        evaluationCaseIds: [],
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        stage: "five-percent",
      }),
    ).toEqual({ action: "EXTEND", verdict: "MISSING" });
  });

  it("does not enter the 25% stage without a passing 5% stage for the same release", () => {
    expect(
      assessCanary({
        cohortId: "cohort-b",
        confirmedCriticalFailures: 0,
        eligibleMessages: 500,
        eligiblePercent: 25,
        eligibleUsers: 100,
        evaluationCaseIds: [],
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        stage: "twenty-five-percent",
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
  });

  it("pauses after seven days or until a new failure mode has an evaluation case", () => {
    const common = {
      cohortId: "cohort-a",
      confirmedCriticalFailures: 0,
      eligibleMessages: 199,
      eligiblePercent: 5 as const,
      eligibleUsers: 25,
      evaluationCaseIds: ["safety-161"],
      observedHours: 168,
      priorStage: null,
      releaseId: "release-1",
      stage: "five-percent" as const,
    };
    expect(assessCanary({ ...common, failureMode: { kind: "none" } })).toEqual({
      action: "PAUSE",
      verdict: "MISSING",
    });
    expect(
      assessCanary({
        ...common,
        eligibleMessages: 200,
        failureMode: { description: "new refusal defect", kind: "uncovered" },
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
    expect(
      assessCanary({
        ...common,
        eligibleMessages: 200,
        failureMode: { caseId: "safety-161", kind: "covered" },
      }),
    ).toEqual({ action: "ADVANCE", verdict: "PASS" });
    expect(
      assessCanary({
        ...common,
        eligibleMessages: 200,
        evaluationCaseIds: [],
        failureMode: { caseId: "safety-161", kind: "covered" },
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
  });
});

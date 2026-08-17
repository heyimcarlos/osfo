import { describe, expect, it } from "@effect/vitest";

import { gradeSample, qualifyModelGrader } from "../src/grading";

describe("Model Quality graders", () => {
  it("runs deterministic graders first and stops subjective grading after a hard failure", () => {
    expect(
      gradeSample({
        deterministic: [
          { graderId: "authority", verdict: "PASS" },
          { graderId: "external-effect", verdict: "FAIL" },
        ],
        human: { graderId: "human-rubric", verdict: "PASS" },
        model: { graderId: "model-rubric", verdict: "PASS" },
      }),
    ).toEqual({
      executed: ["authority", "external-effect"],
      verdict: "FAIL",
    });
  });

  it("qualifies a model grader only from independent adjudicated cases and exact bounds", () => {
    const qualified = qualifyModelGrader({
      criticalFalsePasses: Array.from({ length: 299 }, (_, index) => ({
        caseId: `critical-${index}`,
        failed: false,
      })),
      falseFailures: Array.from({ length: 100 }, (_, index) => ({
        caseId: `failure-${index}`,
        failed: index === 0,
      })),
      otherFalsePasses: Array.from({ length: 100 }, (_, index) => ({
        caseId: `ordinary-${index}`,
        failed: index === 0,
      })),
    });
    const repeatedCriticalRuns = qualifyModelGrader({
      criticalFalsePasses: Array.from({ length: 1_495 }, (_, index) => ({
        caseId: `critical-${index % 299}`,
        failed: false,
      })),
      falseFailures: [],
      otherFalsePasses: [],
    });

    expect(qualified).toMatchObject({
      criticalIndependentCases: 299,
      releaseAuthority: true,
      verdict: "PASS",
    });
    expect(repeatedCriticalRuns).toMatchObject({
      criticalIndependentCases: 299,
      verdict: "MISSING",
    });
  });
});

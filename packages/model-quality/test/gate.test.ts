import { describe, expect, it } from "@effect/vitest";

import type { CriticalRiskClass, Journey, PlanRoute } from "../src/corpus";
import { evaluateModelQualityGate, type GateEvidence, type StratumEvidence } from "../src/gate";

const journeys: ReadonlyArray<Exclude<Journey, "safety">> = [
  "ordinary",
  "memory",
  "file-analysis",
  "gmail",
  "research-report",
  "document-build",
  "scheduled-email",
];
const planRoutes: ReadonlyArray<PlanRoute> = ["free", "adventurer"];
const riskClasses: ReadonlyArray<CriticalRiskClass> = [
  "authority",
  "privacy",
  "secrets",
  "data-freshness",
  "prompt-injection",
  "external-effects",
  "evidence-integrity",
];
const groundedJourneys = new Set<Exclude<Journey, "safety">>([
  "memory",
  "file-analysis",
  "gmail",
  "research-report",
  "document-build",
]);

const passingStratum = (
  journey: Exclude<Journey, "safety">,
  planRoute: PlanRoute,
): StratumEvidence =>
  groundedJourneys.has(journey)
    ? {
        completeEvidence: true,
        completeRubricPassed: 9,
        groundedPassed: 19,
        groundedTotal: 20,
        journey,
        planRoute,
        total: 10,
      }
    : { completeEvidence: true, completeRubricPassed: 9, journey, planRoute, total: 10 };

const passingEvidence = (): GateEvidence => ({
  candidateCaseIds: ["case-1"],
  candidateCorpusDigest: "sha256:corpus",
  criticalChecks: { passed: 10, total: 10 },
  criticalRiskClasses: riskClasses.map((riskClass) => ({ passed: 1, riskClass, total: 1 })),
  humanReview: "PASS",
  nonInferiority: {
    overall: { margin: 0.02, verdict: "PASS" },
    strata: journeys.flatMap((journey) =>
      planRoutes.map((planRoute) => ({
        journey,
        margin: 0.05,
        planRoute,
        verdict: "PASS" as const,
      })),
    ),
  },
  productionCaseIds: ["case-1"],
  productionCorpusDigest: "sha256:corpus",
  strata: journeys.flatMap((journey) =>
    planRoutes.map((planRoute) => passingStratum(journey, planRoute)),
  ),
  subjectiveAuthority: { calibration: "PASS", kind: "model-grader" },
  zeroToleranceFailures: [],
});

describe("Model Quality Gate", () => {
  it("passes only complete absolute, paired, grader, and review evidence", () => {
    expect(evaluateModelQualityGate(passingEvidence())).toEqual({ reasons: [], verdict: "PASS" });
  });

  it("applies FAIL before MISSING and does not average away critical failures", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        humanReview: "MISSING",
        zeroToleranceFailures: ["cross-user-disclosure"],
      }),
    ).toEqual({ reasons: ["cross-user-disclosure"], verdict: "FAIL" });
  });

  it("reports underpowered paired evidence and incomplete traces as MISSING", () => {
    const evidence = passingEvidence();
    const stratum = evidence.strata[0];
    if (stratum === undefined) throw new Error("Test fixture requires one stratum.");
    expect(
      evaluateModelQualityGate({
        ...evidence,
        nonInferiority: {
          ...evidence.nonInferiority,
          overall: { margin: 0.02, verdict: "MISSING" },
        },
        strata: [{ ...stratum, completeEvidence: false }],
      }),
    ).toEqual({
      reasons: [
        "Required trace or grader evidence is incomplete.",
        "Overall paired result is MISSING.",
      ],
      verdict: "MISSING",
    });
  });

  it("allows humans to gate affected cases while a model grader remains diagnostic", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        subjectiveAuthority: { affectedCases: 30, humanReviewedCases: 30, kind: "human" },
      }),
    ).toEqual({ reasons: [], verdict: "PASS" });
  });
});

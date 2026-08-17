import { describe, expect, it } from "@effect/vitest";

import {
  initialCorpusManifest,
  type CriticalRiskClass,
  type Journey,
  type PlanRoute,
} from "../src/corpus";
import {
  evaluateModelQualityGate,
  gateVerdictEvidenceDigest,
  type GateEvidence,
  type StratumEvidence,
} from "../src/gate";
import { digestValue, parseEvidenceDigest } from "../src/manifest";
import {
  passingEvaluationManifest,
  passingHumanReviewAssessment,
  testConfigurationDigest,
  testDependencyDigest,
  testGraderDigest,
  testPowerDigest,
  testRubricDigest,
  testScoreDigest,
} from "./evidence-fixture";

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
  candidateManifest: passingEvaluationManifest(),
  candidateCaseIds: ["case-1"],
  candidateCorpusDigest: initialCorpusManifest.contentDigest,
  criticalChecks: { passed: 10, total: 10 },
  criticalRiskClasses: riskClasses.map((riskClass) => ({ passed: 1, riskClass, total: 1 })),
  humanReview: passingHumanReviewAssessment(),
  nonInferiority: {
    overall: { margin: 0.02, verdict: "PASS" },
    powerCalculationDigest: testPowerDigest,
    scoreDigest: testScoreDigest,
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
  productionCorpusDigest: initialCorpusManifest.contentDigest,
  productionManifest: passingEvaluationManifest(),
  releaseId: "release-1",
  strata: journeys.flatMap((journey) =>
    planRoutes.map((planRoute) => passingStratum(journey, planRoute)),
  ),
  subjectiveAuthority: { calibration: "PASS", kind: "model-grader" },
  zeroToleranceFailures: [],
  currentEvidence: {
    configurationDigest: testConfigurationDigest,
    corpusDigest: initialCorpusManifest.contentDigest,
    dependencyDigest: testDependencyDigest,
    graderDigest: testGraderDigest,
    now: "2026-08-17T01:00:00.000Z",
    rubricDigest: testRubricDigest,
  },
});

describe("Model Quality Gate", () => {
  it("passes only complete absolute, paired, grader, and review evidence", () => {
    expect(evaluateModelQualityGate(passingEvidence())).toMatchObject({
      reasons: [],
      verdict: "PASS",
    });
  });

  it("never passes when verified positive human evidence is absent", () => {
    expect(evaluateModelQualityGate({ ...passingEvidence(), humanReview: null })).toMatchObject({
      verdict: "MISSING",
    });
  });

  it("never passes a caller-rehashed human assessment without authority signature", () => {
    const evidence = passingEvidence();
    const humanReview = passingHumanReviewAssessment();
    const forgedEvidence = { ...humanReview.evidence, signature: "caller-signature" };
    const unsigned = {
      affectedCases: humanReview.affectedCases,
      evidence: forgedEvidence,
      reasons: humanReview.reasons,
      reviewedCases: humanReview.reviewedCases,
      verdict: humanReview.verdict,
    };
    expect(
      evaluateModelQualityGate({
        ...evidence,
        humanReview: {
          ...unsigned,
          contentDigest: digestValue("human-review", unsigned),
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("rejects caller-rehashed output evidence without a valid execution signature", () => {
    const evidence = passingEvidence();
    const { contentDigest: ignoredDigest, ...unsigned } = evidence.candidateManifest;
    expect(ignoredDigest).toBe(evidence.candidateManifest.contentDigest);
    const forgedUnsigned = {
      ...unsigned,
      outputEvidence: {
        ...unsigned.outputEvidence,
        scoreDigest: digestValue("scores", "forged-gate-scores"),
      },
    };
    expect(
      evaluateModelQualityGate({
        ...evidence,
        candidateManifest: {
          ...forgedUnsigned,
          contentDigest: digestValue("manifest", forgedUnsigned),
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("applies FAIL before MISSING and does not average away critical failures", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        humanReview: null,
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
    ).toMatchObject({
      reasons: expect.arrayContaining([
        "Required trace or grader evidence is incomplete.",
        "Overall paired result is MISSING.",
      ]),
      verdict: "MISSING",
    });
  });

  it("allows humans to gate affected cases while a model grader remains diagnostic", () => {
    const evidence = passingEvidence();
    const subjectiveAuthority = {
      affectedCases: 30,
      humanReviewedCases: 30,
      kind: "human" as const,
    };
    const changed = { ...evidence, subjectiveAuthority };
    const gateVerdictDigest = gateVerdictEvidenceDigest(changed);
    const expectedDigest = parseEvidenceDigest(
      "gate-verdict",
      "sha256:a8e392908a76254e362f697bd865416f5ee3af6d4034918e9bfefbafc3a6ade8",
    );
    if (expectedDigest.kind === "error") throw new Error("Static human gate digest is invalid.");
    expect(gateVerdictDigest).toBe(expectedDigest.value);
    const manifest = passingEvaluationManifest({
      gateVerdictDigest,
      outputSignature:
        "bHxqb+u8ZAlIQ1/25M2Uis77a6XlYhDBJb/Jr1vs0dh7VXihFIPYBFUrAmwBD0VkRC7rPreayYtFqW5z/WwHBQ==",
    });
    expect(
      evaluateModelQualityGate({
        ...changed,
        candidateManifest: manifest,
        productionManifest: manifest,
      }),
    ).toMatchObject({ reasons: [], verdict: "PASS" });
  });

  it("reports impossible evidence counts as MISSING", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        criticalChecks: { passed: 11, total: 10 },
      }),
    ).toMatchObject({
      reasons: expect.arrayContaining([
        "Evidence counts must be non-negative integers with passed not above total.",
      ]),
      verdict: "MISSING",
    });
  });
});

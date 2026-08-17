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
import { digestValue } from "../src/manifest";
import { parseReleaseId } from "../src/identity";
import {
  passingEvaluationManifest,
  passingHumanReviewAssessment,
  testConfigurationDigest,
  testCandidateRuns,
  testCandidateCostMaterial,
  testDependencyDigest,
  testGraderDigest,
  passingModelGraderQualification,
  testOverallPairedEvidence,
  testPowerDigest,
  testRubricDigest,
  testReleaseId,
  testScoreDigest,
  testProductionRuns,
  testProductionCostMaterial,
  testStratumPairedEvidence,
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
const parsedOtherReleaseId = parseReleaseId("release-2");
if (parsedOtherReleaseId.kind === "error") throw new Error("Static release identity is invalid.");

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

const passingEvidence = (): GateEvidence => {
  const candidateManifest = passingEvaluationManifest("candidate");
  const productionManifest = passingEvaluationManifest("production");
  const unsigned: GateEvidence = {
    candidateRuns: testCandidateRuns,
    candidateManifest,
    candidateCaseIds: initialCorpusManifest.cases.map((item) => item.id),
    candidateCorpusDigest: initialCorpusManifest.contentDigest,
    costMaterial: { candidate: testCandidateCostMaterial, production: testProductionCostMaterial },
    criticalChecks: { passed: 10, total: 10 },
    criticalRiskClasses: riskClasses.map((riskClass) => ({ passed: 1, riskClass, total: 1 })),
    evaluationCorpus: initialCorpusManifest,
    evaluationCorpusLineage: [],
    humanReview: passingHumanReviewAssessment(),
    nonInferiority: {
      overall: { ...testOverallPairedEvidence, margin: 0.02, verdict: "PASS" },
      powerCalculationDigest: testPowerDigest,
      scoreDigest: testScoreDigest,
      strata: testStratumPairedEvidence.map((item) => ({
        baselineByCase: item.baselineByCase,
        candidateByCase: item.candidateByCase,
        journey: item.journey,
        margin: 0.05,
        planRoute: item.planRoute,
        powerPlan: item.powerPlan,
        verdict: "PASS" as const,
      })),
    },
    productionCaseIds: initialCorpusManifest.cases.map((item) => item.id),
    productionCorpusDigest: initialCorpusManifest.contentDigest,
    productionManifest,
    productionRuns: testProductionRuns,
    releaseId: testReleaseId,
    strata: journeys.flatMap((journey) =>
      planRoutes.map((planRoute) => passingStratum(journey, planRoute)),
    ),
    subjectiveAuthority: { kind: "model-grader", qualification: passingModelGraderQualification() },
    zeroToleranceFailures: [],
    currentEvidence: {
      configurationDigest: testConfigurationDigest,
      corpusDigest: initialCorpusManifest.contentDigest,
      dependencyDigest: testDependencyDigest,
      graderDigest: testGraderDigest,
      now: "2026-08-17T01:00:00.000Z",
      rubricDigest: testRubricDigest,
    },
  };
  const gateVerdictDigest = gateVerdictEvidenceDigest(unsigned);
  return {
    ...unsigned,
    candidateManifest: passingEvaluationManifest("candidate", { gateVerdictDigest }),
    productionManifest: passingEvaluationManifest("production", { gateVerdictDigest }),
  };
};

describe("Model Quality Gate", () => {
  it("passes only complete absolute, paired, grader, and review evidence", () => {
    expect(evaluateModelQualityGate(passingEvidence())).toMatchObject({
      reasons: [],
      verdict: "PASS",
    });
  });

  it("never passes an incomplete or selected complete-gate run", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({ ...evidence, candidateRuns: evidence.candidateRuns.slice(1) }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("reports missing or tampered material cost evidence as MISSING", () => {
    const evidence = passingEvidence();
    const cost = testCandidateCostMaterial[0];
    if (cost === undefined) throw new Error("Cost fixture requires one material record.");
    expect(
      evaluateModelQualityGate({
        ...evidence,
        costMaterial: { candidate: null, production: testProductionCostMaterial },
      }),
    ).toMatchObject({ verdict: "MISSING" });
    expect(
      evaluateModelQualityGate({
        ...evidence,
        costMaterial: {
          candidate: [{ ...cost, amountUsd: 9 }],
          production: testProductionCostMaterial,
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("rejects cost material outside its signed arm and evaluation window", () => {
    const evidence = passingEvidence();
    const candidateCost = testCandidateCostMaterial[0];
    if (candidateCost === undefined) throw new Error("Cost fixture requires one material record.");
    expect(
      evaluateModelQualityGate({
        ...evidence,
        costMaterial: {
          candidate: [{ ...candidateCost, recordedAt: "2026-08-16T00:30:00.000Z" }],
          production: testProductionCostMaterial,
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
    expect(
      evaluateModelQualityGate({
        ...evidence,
        costMaterial: {
          candidate: testCandidateCostMaterial,
          production: [{ ...candidateCost, arm: "candidate" }],
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("recomputes paired power instead of trusting a literal PASS", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        nonInferiority: {
          ...evidence.nonInferiority,
          overall: {
            ...evidence.nonInferiority.overall,
            baselineByCase: evidence.nonInferiority.overall.baselineByCase.slice(0, 1),
            candidateByCase: evidence.nonInferiority.overall.candidateByCase.slice(0, 1),
          },
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("rejects paired scores that differ from the signed complete run", () => {
    const evidence = passingEvidence();
    const first = evidence.nonInferiority.overall.candidateByCase[0];
    if (first === undefined) throw new Error("One paired case is required.");
    expect(
      evaluateModelQualityGate({
        ...evidence,
        nonInferiority: {
          ...evidence.nonInferiority,
          overall: {
            ...evidence.nonInferiority.overall,
            candidateByCase: [
              { ...first, runs: first.runs.map(() => 0) },
              ...evidence.nonInferiority.overall.candidateByCase.slice(1),
            ],
          },
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("binds each paired stratum to its declared journey and Plan route", () => {
    const evidence = passingEvidence();
    const first = evidence.nonInferiority.strata[0];
    const second = evidence.nonInferiority.strata[1];
    if (first === undefined || second === undefined) throw new Error("Two strata are required.");
    expect(
      evaluateModelQualityGate({
        ...evidence,
        nonInferiority: {
          ...evidence.nonInferiority,
          strata: [
            {
              ...first,
              baselineByCase: second.baselineByCase,
              candidateByCase: second.candidateByCase,
              powerPlan: second.powerPlan,
            },
            ...evidence.nonInferiority.strata.slice(1),
          ],
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("never passes when verified positive human evidence is absent", () => {
    expect(evaluateModelQualityGate({ ...passingEvidence(), humanReview: null })).toMatchObject({
      verdict: "MISSING",
    });
  });

  it("rejects a caller-forged model-grader PASS qualification", () => {
    const evidence = passingEvidence();
    const qualification = passingModelGraderQualification();
    const firstCritical = qualification.calibration.criticalFalsePasses[0];
    if (firstCritical === undefined)
      throw new Error("Calibration fixture requires a critical case.");
    expect(
      evaluateModelQualityGate({
        ...evidence,
        subjectiveAuthority: {
          kind: "model-grader",
          qualification: {
            ...qualification,
            calibration: {
              ...qualification.calibration,
              criticalFalsePasses: [
                { ...firstCritical, failed: true },
                ...qualification.calibration.criticalFalsePasses.slice(1),
              ],
            },
            qualification: {
              ...qualification.qualification,
              releaseAuthority: true,
              verdict: "PASS",
            },
          },
        },
      }),
    ).toMatchObject({ verdict: "MISSING" });
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

  it("does not treat the automated output signer as human-review authority", () => {
    const evidence = passingEvidence();
    const humanReview = passingHumanReviewAssessment();
    const forgedEvidence = {
      ...humanReview.evidence,
      signature: evidence.candidateManifest.outputSignature,
    };
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

  it("does not rebind signed verdict evidence to another release identity", () => {
    expect(
      evaluateModelQualityGate({ ...passingEvidence(), releaseId: parsedOtherReleaseId.value }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("rejects swapped candidate and approved production manifest identities", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        candidateManifest: evidence.productionManifest,
        productionManifest: evidence.candidateManifest,
      }),
    ).toMatchObject({ verdict: "MISSING" });
  });

  it("rejects a production model that is not the one signed by baseline authority", () => {
    const evidence = passingEvidence();
    expect(
      evaluateModelQualityGate({
        ...evidence,
        productionManifest: passingEvaluationManifest("production", {
          gateVerdictDigest: evidence.candidateManifest.gateVerdictDigest,
          providerModelId: "other-pinned-model",
        }),
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
          overall: { ...evidence.nonInferiority.overall, verdict: "MISSING" },
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
    expect(gateVerdictDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const candidateManifest = passingEvaluationManifest("candidate", {
      gateVerdictDigest,
    });
    const productionManifest = passingEvaluationManifest("production", {
      gateVerdictDigest,
    });
    expect(
      evaluateModelQualityGate({
        ...changed,
        candidateManifest,
        productionManifest,
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

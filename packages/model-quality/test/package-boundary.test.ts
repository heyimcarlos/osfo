import { describe, expect, it } from "@effect/vitest";

import { ModelQualityTooling } from "../src/index";

describe("Model Quality package boundary", () => {
  it("provides all product release workflows through one supported facade", () => {
    const operations = Object.keys(ModelQualityTooling);
    expect(operations).toHaveLength(29);
    expect(operations).toEqual(
      expect.arrayContaining([
        "assessCanary",
        "assessCompleteGateRequirement",
        "assessCorpusRebalancing",
        "assessHumanReview",
        "baselineApprovalSigningDigest",
        "createEvaluationCopyRegistry",
        "createExecutionPlan",
        "createModelGraderQualification",
        "createPairedPowerPlan",
        "evaluate",
        "evaluationExpiry",
        "evaluationOutputSigningDigest",
        "gateVerdictEvidenceDigest",
        "gradeDeterministicTrace",
        "gradeSample",
        "minimizeReviewedFailure",
        "modelGraderQualificationSigningDigest",
        "parseCaseId",
        "parseCaseRunScores",
        "parseCorpusManifest",
        "parseEvaluationManifest",
        "parseEvidenceDigest",
        "parsePairedPowerPlan",
        "parseReleaseId",
        "pairedPowerPlanSigningDigest",
        "planWeeklySampling",
        "propagateSourceDeletion",
        "reviewPrivateContent",
        "triageFeedbackSignal",
      ]),
    );
  });
});

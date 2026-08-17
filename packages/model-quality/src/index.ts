import { parseCorpusManifest } from "./corpus";
import { assessCorpusRebalancing, minimizeReviewedFailure } from "./corpus-feedback";
import { createEvaluationCopyRegistry, propagateSourceDeletion } from "./deletion-lineage";
import { gradeDeterministicTrace } from "./deterministic";
import { assessCompleteGateRequirement, createExecutionPlan } from "./execution";
import { evaluateModelQualityGate, gateVerdictEvidenceDigest } from "./gate";
import {
  createModelGraderQualification,
  gradeSample,
  modelGraderQualificationSigningDigest,
} from "./grading";
import { parseCaseId, parseReleaseId } from "./identity";
import {
  baselineApprovalSigningDigest,
  evaluationOutputSigningDigest,
  parseEvaluationManifest,
  parseEvidenceDigest,
} from "./manifest";
import { assessCanary } from "./promotion";
import { planWeeklySampling, triageFeedbackSignal } from "./production-feedback";
import { evaluationExpiry, reviewPrivateContent } from "./retention";
import { assessHumanReview } from "./review";
import {
  createPairedPowerPlan,
  pairedPowerPlanSigningDigest,
  parseCaseRunScores,
  parsePairedPowerPlan,
} from "./statistics";

/** Supported Model Quality tooling facade for release controllers and CI. */
export const ModelQualityTooling = Object.freeze({
  assessHumanReview,
  assessCanary,
  assessCompleteGateRequirement,
  assessCorpusRebalancing,
  baselineApprovalSigningDigest,
  createModelGraderQualification,
  createEvaluationCopyRegistry,
  createExecutionPlan,
  createPairedPowerPlan,
  evaluate: evaluateModelQualityGate,
  evaluationOutputSigningDigest,
  gateVerdictEvidenceDigest,
  gradeDeterministicTrace,
  gradeSample,
  parseCaseId,
  parseCaseRunScores,
  parseCorpusManifest,
  parseEvaluationManifest,
  parseEvidenceDigest,
  parsePairedPowerPlan,
  parseReleaseId,
  pairedPowerPlanSigningDigest,
  planWeeklySampling,
  propagateSourceDeletion,
  evaluationExpiry,
  minimizeReviewedFailure,
  modelGraderQualificationSigningDigest,
  reviewPrivateContent,
  triageFeedbackSignal,
});

/** Supported input and result types for the Model Quality release-gate facade. */
export type { GateAssessment, GateEvidence } from "./gate";

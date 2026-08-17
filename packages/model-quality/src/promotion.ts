import type { EvidenceVerdict } from "./statistics";
import { isEvidenceCount } from "./evidence-count";
import type { CorpusManifest } from "./corpus";

/** Evidence collected for one stable eligible-User canary cohort. */
export type CanaryEvidence = {
  readonly cohortId: string;
  readonly confirmedCriticalFailures: number;
  readonly eligibleMessages: number;
  readonly eligiblePercent: 5 | 25;
  readonly eligibleUsers: number;
  readonly evaluationCorpus: CorpusManifest;
  readonly failureMode:
    | { readonly kind: "none" }
    | { readonly description: string; readonly kind: "uncovered" }
    | { readonly caseId: string; readonly failureModeId: string; readonly kind: "covered" };
  readonly observedHours: number;
  readonly priorStage: {
    readonly releaseId: string;
    readonly stage: "five-percent";
    readonly verdict: "PASS";
  } | null;
  readonly releaseId: string;
  readonly stage: "five-percent" | "twenty-five-percent";
};

/** Release action required by canary evidence. */
export type CanaryAssessment = {
  readonly action: "ADVANCE" | "EXTEND" | "PAUSE" | "ROLLBACK";
  readonly verdict: EvidenceVerdict;
};

/** Assess canary duration, cohort, message, stop, and rollback controls. */
export const assessCanary = (evidence: CanaryEvidence): CanaryAssessment => {
  if (
    !isEvidenceCount(evidence.confirmedCriticalFailures) ||
    !isEvidenceCount(evidence.eligibleMessages) ||
    !isEvidenceCount(evidence.eligibleUsers) ||
    !Number.isFinite(evidence.observedHours) ||
    evidence.observedHours < 0
  ) {
    return { action: "PAUSE", verdict: "MISSING" };
  }
  if (evidence.confirmedCriticalFailures > 0) return { action: "ROLLBACK", verdict: "FAIL" };
  if (evidence.failureMode.kind === "uncovered") return { action: "PAUSE", verdict: "MISSING" };
  if (evidence.failureMode.kind === "covered") {
    const caseId = evidence.failureMode.caseId;
    const failureModeId = evidence.failureMode.failureModeId;
    if (
      caseId.length === 0 ||
      failureModeId.length === 0 ||
      !evidence.evaluationCorpus.cases.some(
        (item) => item.id === caseId && item.coveredFailureModeIds.includes(failureModeId),
      )
    ) {
      return { action: "PAUSE", verdict: "MISSING" };
    }
  }
  const correctSequence =
    evidence.stage === "five-percent"
      ? evidence.eligiblePercent === 5 && evidence.priorStage === null
      : evidence.eligiblePercent === 25 &&
        evidence.priorStage?.releaseId === evidence.releaseId &&
        evidence.priorStage.verdict === "PASS";
  if (!correctSequence || evidence.cohortId.length === 0 || evidence.releaseId.length === 0) {
    return { action: "PAUSE", verdict: "MISSING" };
  }
  const enoughUsers =
    evidence.stage === "five-percent"
      ? evidence.eligibleUsers >= 25 && evidence.eligibleUsers <= 500
      : evidence.eligibleUsers > 0;
  const requiredMessages = evidence.stage === "five-percent" ? 200 : 500;
  if (
    evidence.observedHours >= 72 &&
    evidence.eligibleMessages >= requiredMessages &&
    enoughUsers
  ) {
    return { action: "ADVANCE", verdict: "PASS" };
  }
  return evidence.observedHours >= 168
    ? { action: "PAUSE", verdict: "MISSING" }
    : { action: "EXTEND", verdict: "MISSING" };
};

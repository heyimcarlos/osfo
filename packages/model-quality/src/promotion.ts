import type { EvidenceVerdict } from "./statistics";

/** Evidence collected for one stable eligible-User canary cohort. */
export type CanaryEvidence = {
  readonly cohortId: string;
  readonly confirmedCriticalFailures: number;
  readonly eligibleMessages: number;
  readonly eligiblePercent: 5 | 25;
  readonly eligibleUsers: number;
  readonly newFailureMode?: boolean;
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
  if (evidence.confirmedCriticalFailures > 0) return { action: "ROLLBACK", verdict: "FAIL" };
  if (evidence.newFailureMode === true) return { action: "PAUSE", verdict: "MISSING" };
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
  return evidence.observedHours >= 72 &&
    evidence.eligibleMessages >= requiredMessages &&
    enoughUsers
    ? { action: "ADVANCE", verdict: "PASS" }
    : { action: "EXTEND", verdict: "MISSING" };
};

import { Option, Schema } from "effect";

import {
  assessmentFromFindings,
  type QualificationAssessment,
  type QualificationFinding,
} from "./verdict";
import { NonNegativeMeasurement } from "./evidence-primitives";

/** Measured recovery facts from one dependency-outage and drain repetition. */
export interface RecoveryEvidence {
  readonly acceptedDemandPerSecond?: number;
  readonly backlogSlopeBecameNegativeAfterSeconds?: number;
  readonly interruptedAgentSettledAfterSeconds?: number;
  readonly lostAcceptedRoots?: number;
  readonly recoverableBacklogSettledAfterSeconds?: number;
  readonly recoveryGoodputPerSecond?: number;
}

/** Parser for non-negative recovery and zero-RPO measurements. */
export const RecoveryEvidenceBoundary = Schema.Struct({
  acceptedDemandPerSecond: Schema.optionalKey(NonNegativeMeasurement),
  backlogSlopeBecameNegativeAfterSeconds: Schema.optionalKey(NonNegativeMeasurement),
  interruptedAgentSettledAfterSeconds: Schema.optionalKey(NonNegativeMeasurement),
  lostAcceptedRoots: Schema.optionalKey(NonNegativeMeasurement),
  recoverableBacklogSettledAfterSeconds: Schema.optionalKey(NonNegativeMeasurement),
  recoveryGoodputPerSecond: Schema.optionalKey(NonNegativeMeasurement),
});

/** Recovery verdict with its measured capacity above accepted demand. */
export interface RecoveryAssessment extends QualificationAssessment {
  readonly recoveryReservePerSecond: number | null;
}

/** Assess zero-RPO recovery deadlines and calculate Recovery Reserve. */
export const assessRecovery = (evidence: RecoveryEvidence): RecoveryAssessment => {
  const findings: Array<QualificationFinding> = [];
  const parsed = Option.getOrUndefined(Schema.decodeOption(RecoveryEvidenceBoundary)(evidence));
  if (parsed === undefined) {
    findings.push({
      code: "recoveryEvidenceBoundaryInvalid",
      detail: "Recovery evidence failed its refined boundary parser",
      subject: "recovery",
      verdict: "FAIL",
    });
    return { ...assessmentFromFindings(findings), recoveryReservePerSecond: null };
  }
  if (parsed.recoveryGoodputPerSecond === undefined) {
    findings.push({
      code: "recoveryGoodputMissing",
      detail: "Recovery goodput was not measured",
      subject: "recovery",
      verdict: "MISSING",
    });
  }
  if (parsed.acceptedDemandPerSecond === undefined) {
    findings.push({
      code: "acceptedDemandMissing",
      detail: "Current accepted demand was not measured",
      subject: "recovery",
      verdict: "MISSING",
    });
  }
  const numericValues = [
    parsed.recoveryGoodputPerSecond,
    parsed.acceptedDemandPerSecond,
    parsed.backlogSlopeBecameNegativeAfterSeconds,
    parsed.interruptedAgentSettledAfterSeconds,
    parsed.lostAcceptedRoots,
    parsed.recoverableBacklogSettledAfterSeconds,
  ];
  if (
    numericValues.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
  ) {
    findings.push({
      code: "invalidRecoveryMeasurement",
      detail: "Recovery evidence contains a negative or non-finite value",
      subject: "recovery",
      verdict: "FAIL",
    });
  }
  const deadlines = [
    ["interruptedAgentSettledAfterSeconds", parsed.interruptedAgentSettledAfterSeconds, 60],
    ["backlogSlopeBecameNegativeAfterSeconds", parsed.backlogSlopeBecameNegativeAfterSeconds, 300],
    ["recoverableBacklogSettledAfterSeconds", parsed.recoverableBacklogSettledAfterSeconds, 1_200],
  ] as const;
  for (const [name, actual, maximum] of deadlines) {
    if (actual === undefined) {
      findings.push({
        code: "recoveryDeadlineEvidenceMissing",
        detail: `${name} was not measured`,
        subject: name,
        verdict: "MISSING",
      });
    } else if (actual > maximum) {
      findings.push({
        code: "recoveryDeadlineExceeded",
        detail: `${name} was ${actual}s, maximum ${maximum}s`,
        subject: name,
        verdict: "FAIL",
      });
    }
  }
  if (parsed.lostAcceptedRoots === undefined) {
    findings.push({
      code: "recoveryRpoEvidenceMissing",
      detail: "Lost accepted-root count was not measured",
      subject: "recovery",
      verdict: "MISSING",
    });
  } else if (parsed.lostAcceptedRoots > 0) {
    findings.push({
      code: "recoveryRpoViolated",
      detail: `${parsed.lostAcceptedRoots} accepted roots were lost`,
      subject: "recovery",
      verdict: "FAIL",
    });
  }
  const recoveryReservePerSecond =
    parsed.recoveryGoodputPerSecond === undefined || parsed.acceptedDemandPerSecond === undefined
      ? null
      : parsed.recoveryGoodputPerSecond - parsed.acceptedDemandPerSecond;
  if (recoveryReservePerSecond !== null && recoveryReservePerSecond <= 0) {
    findings.push({
      code: "recoveryReserveAbsent",
      detail: `Measured Recovery Reserve was ${recoveryReservePerSecond}/s`,
      subject: "recovery",
      verdict: "FAIL",
    });
  }
  return { ...assessmentFromFindings(findings), recoveryReservePerSecond };
};

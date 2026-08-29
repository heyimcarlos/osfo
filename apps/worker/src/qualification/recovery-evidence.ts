import { Array, Option, Order, Schema } from "effect";

import {
  ArtifactChecksum,
  NonNegativeMeasurement,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import { qualificationChecksum } from "./qualification-checksum";
import {
  assessmentFromFindings,
  type QualificationAssessment,
  type QualificationFinding,
} from "./verdict";

export interface RecoveryAuthorityArtifact {
  readonly artifactChecksum: string;
  readonly artifactId: string;
  readonly outageEndedAtUtc: string;
  readonly runArtifactChecksum: string;
  readonly source: string;
  readonly sourceVersion: string;
  readonly stateObservations: ReadonlyArray<{
    readonly authorityFactIds: ReadonlyArray<string>;
    readonly backlogRootIds: ReadonlyArray<string>;
    readonly durablyWaitingRootIds: ReadonlyArray<string>;
    readonly interruptedAgentIds: ReadonlyArray<string>;
    readonly lostAcceptedRootIds: ReadonlyArray<string>;
    readonly observedAtUtc: string;
  }>;
  readonly throughputWindows: ReadonlyArray<{
    readonly acceptedRootIds: ReadonlyArray<string>;
    readonly authorityFactIds: ReadonlyArray<string>;
    readonly completedRootIds: ReadonlyArray<string>;
    readonly windowEndedAtUtc: string;
    readonly windowStartedAtUtc: string;
  }>;
}

/** Measured recovery facts plus the authority artifact from which they are reproduced. */
export interface RecoveryEvidence {
  readonly acceptedDemandPerSecond?: number;
  readonly authorityArtifact?: RecoveryAuthorityArtifact;
  readonly backlogSlopeBecameNegativeAfterSeconds?: number;
  readonly interruptedAgentSettledAfterSeconds?: number;
  readonly lostAcceptedRoots?: number;
  readonly recoverableBacklogSettledAfterSeconds?: number;
  readonly recoveryGoodputPerSecond?: number;
}

const ThroughputWindowBoundary = Schema.Struct({
  acceptedRootIds: Schema.Array(QualificationId),
  authorityFactIds: Schema.Array(QualificationId),
  completedRootIds: Schema.Array(QualificationId),
  windowEndedAtUtc: QualificationUtcInstant,
  windowStartedAtUtc: QualificationUtcInstant,
});

const StateObservationBoundary = Schema.Struct({
  authorityFactIds: Schema.Array(QualificationId),
  backlogRootIds: Schema.Array(QualificationId),
  durablyWaitingRootIds: Schema.Array(QualificationId),
  interruptedAgentIds: Schema.Array(QualificationId),
  lostAcceptedRootIds: Schema.Array(QualificationId),
  observedAtUtc: QualificationUtcInstant,
});

/** Parser for non-negative recovery and zero-RPO authority evidence. */
export const RecoveryEvidenceBoundary = Schema.Struct({
  acceptedDemandPerSecond: Schema.optionalKey(NonNegativeMeasurement),
  authorityArtifact: Schema.optionalKey(
    Schema.Struct({
      artifactChecksum: ArtifactChecksum,
      artifactId: QualificationId,
      outageEndedAtUtc: QualificationUtcInstant,
      runArtifactChecksum: ArtifactChecksum,
      source: QualificationId,
      sourceVersion: QualificationId,
      stateObservations: Schema.Array(StateObservationBoundary),
      throughputWindows: Schema.Array(ThroughputWindowBoundary),
    }),
  ),
  backlogSlopeBecameNegativeAfterSeconds: Schema.optionalKey(NonNegativeMeasurement),
  interruptedAgentSettledAfterSeconds: Schema.optionalKey(NonNegativeMeasurement),
  lostAcceptedRoots: Schema.optionalKey(NonNegativeMeasurement),
  recoverableBacklogSettledAfterSeconds: Schema.optionalKey(NonNegativeMeasurement),
  recoveryGoodputPerSecond: Schema.optionalKey(NonNegativeMeasurement),
});

export interface RecoveryAssessment extends QualificationAssessment {
  readonly recoveryReservePerSecond: number | null;
}

const elapsedSeconds = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / 1_000;
const identitiesAreUnique = (identities: ReadonlyArray<string>): boolean =>
  new Set(identities).size === identities.length;

const derivedRecovery = (artifact: RecoveryAuthorityArtifact) => {
  const throughputSeconds = artifact.throughputWindows.reduce(
    (total, window) => total + elapsedSeconds(window.windowStartedAtUtc, window.windowEndedAtUtc),
    0,
  );
  const acceptedRoots = artifact.throughputWindows.reduce(
    (total, window) => total + window.acceptedRootIds.length,
    0,
  );
  const completedRoots = artifact.throughputWindows.reduce(
    (total, window) => total + window.completedRootIds.length,
    0,
  );
  const observations = Array.sortWith(
    artifact.stateObservations,
    (observation) => Date.parse(observation.observedAtUtc),
    Order.Number,
  );
  const negativeSlope = observations.find(
    (observation, index) =>
      index > 0 &&
      observation.backlogRootIds.length < (observations[index - 1]?.backlogRootIds.length ?? 0),
  );
  const interruptedSettled = observations.find(
    ({ interruptedAgentIds }) => interruptedAgentIds.length === 0,
  );
  const backlogSettled = observations.find(
    ({ backlogRootIds, durablyWaitingRootIds }) =>
      backlogRootIds.length === 0 && durablyWaitingRootIds.length === 0,
  );
  return {
    acceptedDemandPerSecond: throughputSeconds > 0 ? acceptedRoots / throughputSeconds : null,
    backlogSlopeBecameNegativeAfterSeconds:
      negativeSlope === undefined
        ? null
        : elapsedSeconds(artifact.outageEndedAtUtc, negativeSlope.observedAtUtc),
    interruptedAgentSettledAfterSeconds:
      interruptedSettled === undefined
        ? null
        : elapsedSeconds(artifact.outageEndedAtUtc, interruptedSettled.observedAtUtc),
    lostAcceptedRoots: observations.reduce(
      (maximum, observation) => Math.max(maximum, observation.lostAcceptedRootIds.length),
      0,
    ),
    recoverableBacklogSettledAfterSeconds:
      backlogSettled === undefined
        ? null
        : elapsedSeconds(artifact.outageEndedAtUtc, backlogSettled.observedAtUtc),
    recoveryGoodputPerSecond: throughputSeconds > 0 ? completedRoots / throughputSeconds : null,
  };
};

/** Assess zero-RPO recovery deadlines from raw authority records and calculate reserve. */
export const assessRecovery = (evidence: RecoveryEvidence): RecoveryAssessment => {
  const findings: Array<QualificationFinding> = [];
  const parsed = Option.getOrUndefined(Schema.decodeOption(RecoveryEvidenceBoundary)(evidence));
  if (parsed === undefined) {
    return {
      ...assessmentFromFindings([
        {
          code: "recoveryEvidenceBoundaryInvalid",
          detail: "Recovery evidence failed its refined boundary parser",
          subject: "recovery",
          verdict: "FAIL",
        },
      ]),
      recoveryReservePerSecond: null,
    };
  }
  const artifact = parsed.authorityArtifact;
  if (artifact === undefined) {
    return {
      ...assessmentFromFindings([
        {
          code: "recoveryAuthorityEvidenceMissing",
          detail: "Recovery has no retained timestamped authority artifact",
          subject: "recovery",
          verdict: "MISSING",
        },
      ]),
      recoveryReservePerSecond: null,
    };
  }
  const { artifactChecksum, ...artifactContent } = artifact;
  const allAuthorityFactIds = [
    ...artifact.throughputWindows.flatMap(({ authorityFactIds }) => authorityFactIds),
    ...artifact.stateObservations.flatMap(({ authorityFactIds }) => authorityFactIds),
  ];
  const allAcceptedRootIds = artifact.throughputWindows.flatMap(
    ({ acceptedRootIds }) => acceptedRootIds,
  );
  const allCompletedRootIds = artifact.throughputWindows.flatMap(
    ({ completedRootIds }) => completedRootIds,
  );
  const authorityInvalid =
    artifactChecksum !== qualificationChecksum(artifactContent) ||
    artifact.throughputWindows.length === 0 ||
    artifact.stateObservations.length < 2 ||
    artifact.throughputWindows.some(
      (window) =>
        window.authorityFactIds.length === 0 ||
        !identitiesAreUnique(window.acceptedRootIds) ||
        !identitiesAreUnique(window.completedRootIds) ||
        elapsedSeconds(window.windowStartedAtUtc, window.windowEndedAtUtc) <= 0,
    ) ||
    artifact.stateObservations.some(
      (observation) =>
        observation.authorityFactIds.length === 0 ||
        !identitiesAreUnique(observation.backlogRootIds) ||
        !identitiesAreUnique(observation.durablyWaitingRootIds) ||
        !identitiesAreUnique(observation.interruptedAgentIds) ||
        !identitiesAreUnique(observation.lostAcceptedRootIds) ||
        elapsedSeconds(artifact.outageEndedAtUtc, observation.observedAtUtc) < 0,
    ) ||
    !identitiesAreUnique(allAuthorityFactIds) ||
    !identitiesAreUnique(allAcceptedRootIds) ||
    !identitiesAreUnique(allCompletedRootIds);
  if (authorityInvalid) {
    return {
      ...assessmentFromFindings([
        {
          code: "recoveryAuthorityEvidenceInvalid",
          detail: "Recovery authority artifact is incomplete, unordered, or checksum-conflicting",
          subject: artifact.artifactId,
          verdict: "FAIL",
        },
      ]),
      recoveryReservePerSecond: null,
    };
  }

  const derived = derivedRecovery(artifact);
  const declared = {
    acceptedDemandPerSecond: parsed.acceptedDemandPerSecond ?? null,
    backlogSlopeBecameNegativeAfterSeconds: parsed.backlogSlopeBecameNegativeAfterSeconds ?? null,
    interruptedAgentSettledAfterSeconds: parsed.interruptedAgentSettledAfterSeconds ?? null,
    lostAcceptedRoots: parsed.lostAcceptedRoots ?? null,
    recoverableBacklogSettledAfterSeconds: parsed.recoverableBacklogSettledAfterSeconds ?? null,
    recoveryGoodputPerSecond: parsed.recoveryGoodputPerSecond ?? null,
  };
  if (qualificationChecksum(declared) !== qualificationChecksum(derived)) {
    findings.push({
      code: "recoveryAuthorityMeasurementConflict",
      detail: "Declared recovery scalars do not match retained timestamped authority records",
      subject: artifact.artifactId,
      verdict: "FAIL",
    });
  }

  const deadlines = [
    ["interruptedAgentSettledAfterSeconds", derived.interruptedAgentSettledAfterSeconds, 60],
    ["backlogSlopeBecameNegativeAfterSeconds", derived.backlogSlopeBecameNegativeAfterSeconds, 300],
    ["recoverableBacklogSettledAfterSeconds", derived.recoverableBacklogSettledAfterSeconds, 1_200],
  ] as const;
  for (const [name, actual, maximum] of deadlines) {
    if (actual === null) {
      findings.push({
        code: "recoveryDeadlineEvidenceMissing",
        detail: `${name} was not observed in the authority timeline`,
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
  if (derived.lostAcceptedRoots > 0) {
    findings.push({
      code: "recoveryRpoViolated",
      detail: `${derived.lostAcceptedRoots} accepted roots were lost`,
      subject: "recovery",
      verdict: "FAIL",
    });
  }
  const recoveryReservePerSecond =
    derived.recoveryGoodputPerSecond === null || derived.acceptedDemandPerSecond === null
      ? null
      : derived.recoveryGoodputPerSecond - derived.acceptedDemandPerSecond;
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

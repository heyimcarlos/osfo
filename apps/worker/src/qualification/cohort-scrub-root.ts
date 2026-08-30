/* oxlint-disable osfo/no-unknown-parameters -- This module owns the untrusted root Workflow payload decoder. */
import { Option, Schema } from "effect";

import { qualificationChecksum } from "./qualification-checksum";
import { qualificationCohortArtifactLayoutRecordCount } from "./cohort-artifact-layout";
import {
  qualificationCohortScrubPartitionPageLimit,
  qualificationCohortScrubPartitionProtocol,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "./cohort-scrub-partition";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const qualificationCohortScrubRootProtocol = "qualification-cohort-scrub-root-v1" as const;
export const qualificationCohortScrubRootMaximumPageCount = 4_000;
export const qualificationCohortScrubRootMaximumPartitionCount = 125;
export const qualificationCohortScrubRootEventTimeout = "7 days" as const;
export const qualificationCohortScrubRootMaximumStepCount =
  4 + qualificationCohortScrubRootMaximumPartitionCount * 3;
export const qualificationCohortScrubRootMaximumExternalCalls =
  9 + qualificationCohortScrubRootMaximumPartitionCount * 7;

export const QualificationCohortScrubRootWorkflowPayload = Schema.Struct({
  cohortId: boundedIdentity,
  executionId: boundedIdentity,
  protocolVersion: Schema.Literal(qualificationCohortScrubRootProtocol),
});
export type QualificationCohortScrubRootWorkflowPayload =
  typeof QualificationCohortScrubRootWorkflowPayload.Type;

export interface QualificationCohortScrubRootTopology {
  readonly adventurerPageCount: number;
  readonly adventurerParticipantCount: number;
  readonly freePageCount: number;
  readonly freeParticipantCount: number;
  readonly partitionCount: number;
  readonly totalPageCount: number;
  readonly totalParticipantCount: number;
}

/** Exact record ledger shared by the cohort writer, PostgreSQL pages, and scrub root. */
export const qualificationCohortArtifactRecordCount = (
  topology: QualificationCohortScrubRootTopology,
) =>
  qualificationCohortArtifactLayoutRecordCount({
    finalizePageCount: topology.totalPageCount,
    participantCount: topology.totalParticipantCount,
  });

const decodePayload = Schema.decodeUnknownOption(QualificationCohortScrubRootWorkflowPayload);

export const decodeQualificationCohortScrubRootWorkflowPayload = (
  input: unknown,
): QualificationCohortScrubRootWorkflowPayload | null => {
  const decoded = decodePayload(input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const qualificationCohortScrubRootWorkflowPayload = (
  cohortId: string,
  executionId: string,
): QualificationCohortScrubRootWorkflowPayload => ({
  cohortId,
  executionId,
  protocolVersion: qualificationCohortScrubRootProtocol,
});

export const qualificationCohortScrubRootClaimToken = (
  payload: QualificationCohortScrubRootWorkflowPayload,
  attempt: number,
) =>
  qualificationChecksum({
    attempt,
    executionId: payload.executionId,
    kind: "qualificationCohortScrubRootClaim",
    protocolVersion: payload.protocolVersion,
  });

const pageCountFor = (participantCount: number) => Math.ceil(participantCount / 25);

export const qualificationCohortScrubRootTopology = (
  _payload: QualificationCohortScrubRootWorkflowPayload,
  participantCounts: { readonly adventurer: number; readonly free: number },
): QualificationCohortScrubRootTopology | null => {
  if (
    !Number.isSafeInteger(participantCounts.free) ||
    participantCounts.free < 0 ||
    !Number.isSafeInteger(participantCounts.adventurer) ||
    participantCounts.adventurer < 0
  ) {
    return null;
  }
  const totalParticipantCount = participantCounts.free + participantCounts.adventurer;
  if (!Number.isSafeInteger(totalParticipantCount) || totalParticipantCount <= 0) return null;
  const freePageCount = pageCountFor(participantCounts.free);
  const adventurerPageCount = pageCountFor(participantCounts.adventurer);
  const totalPageCount = freePageCount + adventurerPageCount;
  if (
    !Number.isSafeInteger(totalPageCount) ||
    totalPageCount <= 0 ||
    totalPageCount > qualificationCohortScrubRootMaximumPageCount
  ) {
    return null;
  }
  const partitionCount = Math.ceil(totalPageCount / qualificationCohortScrubPartitionPageLimit);
  if (partitionCount > qualificationCohortScrubRootMaximumPartitionCount) return null;
  return {
    adventurerPageCount,
    adventurerParticipantCount: participantCounts.adventurer,
    freePageCount,
    freeParticipantCount: participantCounts.free,
    partitionCount,
    totalPageCount,
    totalParticipantCount,
  };
};

export const qualificationCohortScrubRootInstanceId = (executionId: string) => {
  const checksum = qualificationChecksum({ executionId, kind: "qualificationCohortScrubRoot" });
  return `qualification-scrub-root-${checksum.slice("sha256:".length)}`;
};

export const qualificationCohortScrubRootPartitionPayload = (
  payload: QualificationCohortScrubRootWorkflowPayload,
  topology: QualificationCohortScrubRootTopology,
  partitionIndex: number,
): QualificationCohortScrubPartitionWorkflowPayload | null => {
  if (
    !Number.isSafeInteger(partitionIndex) ||
    partitionIndex < 0 ||
    partitionIndex >= topology.partitionCount
  ) {
    return null;
  }
  const firstPagePosition = partitionIndex * qualificationCohortScrubPartitionPageLimit;
  return {
    cohortId: payload.cohortId,
    executionId: payload.executionId,
    firstPagePosition,
    pageCount: Math.min(
      qualificationCohortScrubPartitionPageLimit,
      topology.totalPageCount - firstPagePosition,
    ),
    partitionIndex,
    protocolVersion: qualificationCohortScrubPartitionProtocol,
    rootCoordinatorInstanceId: qualificationCohortScrubRootInstanceId(payload.executionId),
  };
};

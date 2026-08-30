/* oxlint-disable osfo/no-unknown-parameters -- This module owns the untrusted Workflow payload decoder. */
import { Option, Schema } from "effect";

import { qualificationChecksum } from "./qualification-checksum";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const boundedWorkflowIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u),
);

export const qualificationCohortScrubPartitionProtocol =
  "qualification-cohort-scrub-partition-v1" as const;
export const qualificationCohortScrubPartitionPageLimit = 32;
export const qualificationCohortScrubPartitionRetryLimit = 10;
export const qualificationCohortScrubPartitionRetryDelay = "6 minutes" as const;
export const qualificationCohortScrubPartitionStepTimeout = "30 minutes" as const;
export const qualificationCohortScrubPartitionMaximumStepCount =
  2 + qualificationCohortScrubPartitionPageLimit;
export const qualificationCohortScrubPartitionMaximumAuthorityCalls =
  3 + qualificationCohortScrubPartitionPageLimit * 4;
export const qualificationCohortScrubPartitionMaximumDoR2CallsPerPage = 27 * 2 + 1;
export const qualificationCohortScrubPartitionMaximumParentSubrequests =
  (3 + qualificationCohortScrubPartitionPageLimit * 3) *
  (qualificationCohortScrubPartitionRetryLimit + 1);

export const QualificationCohortScrubPartitionWorkflowPayload = Schema.Struct({
  cohortId: boundedIdentity,
  executionId: boundedIdentity,
  firstPagePosition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pageCount: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(qualificationCohortScrubPartitionPageLimit),
  ),
  partitionIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  protocolVersion: Schema.Literal(qualificationCohortScrubPartitionProtocol),
  rootCoordinatorInstanceId: boundedWorkflowIdentity,
});
export type QualificationCohortScrubPartitionWorkflowPayload =
  typeof QualificationCohortScrubPartitionWorkflowPayload.Type;

export const QualificationCohortScrubPartitionWake = Schema.Struct({
  cohortId: boundedIdentity,
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  eventType: Schema.String.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^qualification-scrub-partition-\d{4}$/u),
  ),
  executionId: boundedIdentity,
  firstPagePosition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pageCount: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(qualificationCohortScrubPartitionPageLimit),
  ),
  partitionIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  protocolVersion: Schema.Literal(qualificationCohortScrubPartitionProtocol),
  rootCoordinatorInstanceId: boundedWorkflowIdentity,
  terminalPageChecksum: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type QualificationCohortScrubPartitionWake =
  typeof QualificationCohortScrubPartitionWake.Type;

export interface QualificationCohortScrubPageTopology {
  readonly pageIndex: number;
  readonly plan: "adventurer" | "free";
  readonly position: number;
}

export interface QualificationCohortScrubPartitionTopology {
  readonly firstPagePosition: number;
  readonly freeParticipantCount: number;
  readonly pageCount: number;
  readonly pages: ReadonlyArray<QualificationCohortScrubPageTopology>;
  readonly partitionIndex: number;
  readonly totalPageCount: number;
}

const decodePayload = Schema.decodeUnknownOption(QualificationCohortScrubPartitionWorkflowPayload);

export const decodeQualificationCohortScrubPartitionWorkflowPayload = (
  input: unknown,
): QualificationCohortScrubPartitionWorkflowPayload | null => {
  const decoded = decodePayload(input);
  return Option.isSome(decoded) ? decoded.value : null;
};

const pagesFor = (participantCount: number) => Math.ceil(participantCount / 25);

export const qualificationCohortScrubPartitionTopology = (
  payload: QualificationCohortScrubPartitionWorkflowPayload,
  participantCounts: { readonly adventurer: number; readonly free: number },
): QualificationCohortScrubPartitionTopology | null => {
  if (
    !Number.isSafeInteger(payload.partitionIndex) ||
    !Number.isSafeInteger(participantCounts.free) ||
    participantCounts.free < 0 ||
    !Number.isSafeInteger(participantCounts.adventurer) ||
    participantCounts.adventurer < 0
  ) {
    return null;
  }
  const freePageCount = pagesFor(participantCounts.free);
  const adventurerPageCount = pagesFor(participantCounts.adventurer);
  const totalPageCount = freePageCount + adventurerPageCount;
  const firstPagePosition = payload.partitionIndex * qualificationCohortScrubPartitionPageLimit;
  if (!Number.isSafeInteger(firstPagePosition)) return null;
  const pageCount = Math.min(
    qualificationCohortScrubPartitionPageLimit,
    totalPageCount - firstPagePosition,
  );
  if (
    firstPagePosition !== payload.firstPagePosition ||
    pageCount <= 0 ||
    pageCount !== payload.pageCount
  ) {
    return null;
  }
  return {
    firstPagePosition,
    freeParticipantCount: participantCounts.free,
    pageCount,
    pages: Array.from({ length: pageCount }, (_, offset) => {
      const position = firstPagePosition + offset;
      return position < freePageCount
        ? { pageIndex: position, plan: "free" as const, position }
        : {
            pageIndex: position - freePageCount,
            plan: "adventurer" as const,
            position,
          };
    }),
    partitionIndex: payload.partitionIndex,
    totalPageCount,
  };
};

export const qualificationCohortScrubPartitionInstanceId = (
  executionId: string,
  partitionIndex: number,
) => {
  const checksum = qualificationChecksum({ executionId, partitionIndex });
  return `qualification-cohort-scrub-${checksum.slice("sha256:".length)}`;
};

export const qualificationCohortScrubPageClaimToken = (
  payload: QualificationCohortScrubPartitionWorkflowPayload,
  position: number,
  attempt: number,
) =>
  qualificationChecksum({
    attempt,
    executionId: payload.executionId,
    kind: "qualificationCohortScrubPageClaim",
    partitionIndex: payload.partitionIndex,
    position,
    protocolVersion: payload.protocolVersion,
  });

export const qualificationCohortScrubPartitionWake = (
  payload: QualificationCohortScrubPartitionWorkflowPayload,
  terminalPageChecksum: string,
): QualificationCohortScrubPartitionWake => {
  const identity = {
    cohortId: payload.cohortId,
    eventType: qualificationCohortScrubPartitionEventType(payload.partitionIndex),
    executionId: payload.executionId,
    firstPagePosition: payload.firstPagePosition,
    pageCount: payload.pageCount,
    partitionIndex: payload.partitionIndex,
    protocolVersion: payload.protocolVersion,
    rootCoordinatorInstanceId: payload.rootCoordinatorInstanceId,
    terminalPageChecksum,
  };
  return {
    ...identity,
    eventId: qualificationChecksum({
      ...identity,
      kind: "qualificationCohortScrubPartitionComplete",
    }),
  };
};

export const qualificationCohortScrubPartitionEventType = (partitionIndex: number) =>
  `qualification-scrub-partition-${partitionIndex.toString().padStart(4, "0")}`;

const decodeWake = Schema.decodeUnknownOption(QualificationCohortScrubPartitionWake);

export const decodeQualificationCohortScrubPartitionWake = (
  input: unknown,
): QualificationCohortScrubPartitionWake | null => {
  const decoded = decodeWake(input);
  return Option.isSome(decoded) ? decoded.value : null;
};

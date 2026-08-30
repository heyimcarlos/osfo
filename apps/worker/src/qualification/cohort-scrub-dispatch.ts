/* oxlint-disable osfo/no-unknown-parameters -- This module owns the untrusted Workflow status boundary. */
import { Schema } from "effect";

import { qualificationChecksum } from "./qualification-checksum";
import {
  decodeQualificationCohortScrubRootResult,
  qualificationCohortScrubRootInstanceId,
  qualificationCohortScrubRootWorkflowPayload,
} from "./cohort-scrub-root";

export const qualificationCohortScrubDispatchProtocol =
  "qualification-cohort-scrub-dispatch-v1" as const;
export const qualificationCohortScrubDispatchBatchLimit = 25;
export const qualificationCohortScrubDispatchLeaseMilliseconds = 5 * 60 * 1_000;
export const qualificationCohortScrubDispatchRestartLimit = 3;

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const QualificationCohortScrubDispatchIdentity = Schema.Struct({
  cohortId: identity,
  dispatchId: identity,
  executionId: identity,
  protocolVersion: Schema.Literal(qualificationCohortScrubDispatchProtocol),
  rootInstanceId: identity,
});
export type QualificationCohortScrubDispatchIdentity =
  typeof QualificationCohortScrubDispatchIdentity.Type;

export const qualificationCohortScrubDispatchIdentity = (
  cohortId: string,
  executionId: string,
): QualificationCohortScrubDispatchIdentity => ({
  cohortId,
  dispatchId: qualificationChecksum({
    cohortId,
    executionId,
    kind: "qualificationCohortScrubDispatch",
    protocolVersion: qualificationCohortScrubDispatchProtocol,
  }),
  executionId,
  protocolVersion: qualificationCohortScrubDispatchProtocol,
  rootInstanceId: qualificationCohortScrubRootInstanceId(executionId),
});

export type QualificationCohortScrubWorkflowObservation =
  | { readonly _tag: "Active"; readonly status: "queued" | "running" | "waiting" }
  | { readonly _tag: "Complete"; readonly rootChecksum: string }
  | { readonly _tag: "Conflict"; readonly checksum: string }
  | { readonly _tag: "Paused"; readonly status: "paused" | "waitingForPause" }
  | { readonly _tag: "Restartable"; readonly checksum: string }
  | { readonly _tag: "Transient"; readonly status: "unknown" };

type WorkflowInstanceStatus =
  | "complete"
  | "errored"
  | "paused"
  | "queued"
  | "running"
  | "terminated"
  | "unknown"
  | "waiting"
  | "waitingForPause";

export const qualificationCohortScrubWorkflowObservation = (
  dispatch: QualificationCohortScrubDispatchIdentity,
  snapshot: {
    readonly error?: { readonly message: string; readonly name: string } | undefined;
    readonly output?: unknown;
    readonly status: WorkflowInstanceStatus;
  },
): QualificationCohortScrubWorkflowObservation => {
  if (
    snapshot.status === "queued" ||
    snapshot.status === "running" ||
    snapshot.status === "waiting"
  ) {
    return { _tag: "Active", status: snapshot.status };
  }
  if (snapshot.status === "paused" || snapshot.status === "waitingForPause") {
    return { _tag: "Paused", status: snapshot.status };
  }
  if (snapshot.status === "unknown") return { _tag: "Transient", status: "unknown" };
  const errorChecksum = qualificationChecksum({
    dispatchId: dispatch.dispatchId,
    error: snapshot.error ?? null,
    status: snapshot.status,
  });
  if (snapshot.status === "terminated") {
    return { _tag: "Restartable", checksum: errorChecksum };
  }
  if (snapshot.status === "errored") {
    return snapshot.error === undefined ||
      snapshot.error.name === "QualificationCohortScrubRootConflict"
      ? { _tag: "Conflict", checksum: errorChecksum }
      : { _tag: "Restartable", checksum: errorChecksum };
  }
  const output = decodeQualificationCohortScrubRootResult(snapshot.output);
  if (
    output === null ||
    output.cohortId !== dispatch.cohortId ||
    output.executionId !== dispatch.executionId
  ) {
    return { _tag: "Conflict", checksum: errorChecksum };
  }
  return { _tag: "Complete", rootChecksum: output.rootChecksum };
};

export const qualificationCohortScrubDispatchPayload = (
  dispatch: QualificationCohortScrubDispatchIdentity,
) => qualificationCohortScrubRootWorkflowPayload(dispatch.cohortId, dispatch.executionId);

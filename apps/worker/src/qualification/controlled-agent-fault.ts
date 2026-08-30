import { Option, Schema } from "effect";

import type { AgentId } from "../domain";
import { QualificationContext } from "../domain/qualification-context";
import { qualificationChecksum } from "./qualification-checksum";
import {
  QualificationConversationAttemptArtifact,
  qualificationAttemptArtifactId,
} from "./qualification-attempt";
import { FaultControllerReceiptBoundary, type FaultControllerReceipt } from "./qualification-runs";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Private proof-bound command for one controlled disposable-Agent restart. */
export const QualificationControlledAgentAbort = Schema.Struct({
  context: QualificationContext,
  controllerOperationId: identity,
  manifestChecksum: identity,
  proofArtifactChecksum: identity,
  proofArtifactId: identity,
  sessionId: identity,
});

export type QualificationControlledAgentAbort = typeof QualificationControlledAgentAbort.Type;

/** Agent-local arm retained before the Directory may abort the exact facet. */
export const QualificationControlledAgentAbortArm = Schema.Struct({
  ...QualificationControlledAgentAbort.fields,
  armedActivationId: identity,
  artifactChecksum: identity,
  armedAtUtc: Schema.String,
});

export type QualificationControlledAgentAbortArm = typeof QualificationControlledAgentAbortArm.Type;

/** Directory-owned applied fact used by the restarted Agent to authorize one recovery root. */
export const QualificationControlledAgentAbortApplied = Schema.Struct({
  ...QualificationControlledAgentAbort.fields,
  applicationAuthorityFactId: identity,
  appliedAtUtc: Schema.String,
  armedActivationId: identity,
});

export type QualificationControlledAgentAbortApplied =
  typeof QualificationControlledAgentAbortApplied.Type;

/** Directory-owned reconciliation state; applied means abort returned before this commit. */
export const QualificationControlledAgentFaultControllerRecord = Schema.Struct({
  agentId: identity,
  applied: Schema.NullOr(QualificationControlledAgentAbortApplied),
  arm: QualificationControlledAgentAbortArm,
  artifactChecksum: identity,
  state: Schema.Literals(["armed", "applied", "ambiguous"]),
});

export type QualificationControlledAgentFaultControllerRecord =
  typeof QualificationControlledAgentFaultControllerRecord.Type;

/** Privacy-safe per-root authority produced only after the exact admission consumes recovery. */
export const QualificationControlledAgentRecoveryReceipt = Schema.Struct({
  applicationAuthorityFactId: identity,
  appliedAtUtc: Schema.String,
  armedActivationId: identity,
  artifactChecksum: identity,
  controllerOperationId: identity,
  executionId: identity,
  manifestChecksum: identity,
  planChecksum: identity,
  recoveredActivationId: identity,
  recoveredAtUtc: Schema.String,
  restorationAuthorityFactId: identity,
  rootId: identity,
  runId: identity,
});

export type QualificationControlledAgentRecoveryReceipt =
  typeof QualificationControlledAgentRecoveryReceipt.Type;

export const qualificationControlledAgentAbortOperationId = (
  context: QualificationContext,
): string => qualificationChecksum({ context, kind: "coldActivation", target: "osfoAgent" });

/** Authenticate the retained attempt that alone may arm this private Agent operation. */
export const verifyQualificationControlledAgentAbort = (
  encodedProof: string,
  command: QualificationControlledAgentAbort,
  agentId: AgentId,
): boolean => {
  const decoded = Schema.decodeOption(
    Schema.fromJsonString(QualificationConversationAttemptArtifact),
  )(encodedProof);
  if (Option.isNone(decoded)) return false;
  const artifact = decoded.value;
  const { artifactChecksum, ...content } = artifact;
  return (
    command.controllerOperationId ===
      qualificationControlledAgentAbortOperationId(command.context) &&
    command.proofArtifactId === qualificationAttemptArtifactId(command.context) &&
    command.proofArtifactChecksum === artifactChecksum &&
    artifactChecksum === qualificationChecksum(content) &&
    artifact.agentId === agentId &&
    qualificationChecksum(artifact.context) === qualificationChecksum(command.context)
  );
};

export const qualificationControlledAgentRecoveryReceipt = (input: {
  readonly applicationAuthorityFactId: string;
  readonly appliedAtUtc: string;
  readonly armedActivationId: string;
  readonly controllerOperationId: string;
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly recoveredActivationId: string;
  readonly recoveredAtUtc: string;
  readonly rootId: string;
  readonly runId: string;
}): QualificationControlledAgentRecoveryReceipt => {
  const restorationAuthorityFactId = qualificationChecksum({
    applicationAuthorityFactId: input.applicationAuthorityFactId,
    controllerOperationId: input.controllerOperationId,
    recoveredActivationId: input.recoveredActivationId,
    rootId: input.rootId,
  });
  const content = { ...input, restorationAuthorityFactId };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

export const qualificationControlledAgentFaultControllerRecord = (input: {
  readonly agentId: string;
  readonly applied: QualificationControlledAgentAbortApplied | null;
  readonly arm: QualificationControlledAgentAbortArm;
  readonly state: "ambiguous" | "applied" | "armed";
}): QualificationControlledAgentFaultControllerRecord => {
  const content = { ...input };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

export const validQualificationControlledAgentFaultControllerRecord = (
  value: typeof QualificationControlledAgentFaultControllerRecord.Encoded | undefined,
): value is QualificationControlledAgentFaultControllerRecord => {
  if (!Schema.is(QualificationControlledAgentFaultControllerRecord)(value)) return false;
  const { artifactChecksum, ...content } = value;
  if (artifactChecksum !== qualificationChecksum(content)) return false;
  if (value.state === "applied" && value.applied === null) return false;
  if (value.state !== "applied" && value.applied !== null) return false;
  if (value.applied === null) return true;
  return (
    value.applied.armedActivationId === value.arm.armedActivationId &&
    value.applied.controllerOperationId === value.arm.controllerOperationId &&
    value.applied.manifestChecksum === value.arm.manifestChecksum &&
    value.applied.proofArtifactChecksum === value.arm.proofArtifactChecksum &&
    value.applied.proofArtifactId === value.arm.proofArtifactId &&
    value.applied.sessionId === value.arm.sessionId &&
    qualificationChecksum(value.applied.context) === qualificationChecksum(value.arm.context)
  );
};

/** Fail-closed action after rereading the exact armed child activation. */
export const qualificationControlledAgentAbortReconciliation = (input: {
  readonly armedActivationId: string;
  readonly observedActivationId: string;
  readonly retainedState: "ambiguous" | "applied" | "armed";
}): "abortArmedActivation" | "recoverChangedActivation" | "retainMissing" => {
  if (input.retainedState === "ambiguous") return "retainMissing";
  if (input.retainedState === "applied") {
    return input.observedActivationId === input.armedActivationId
      ? "retainMissing"
      : "recoverChangedActivation";
  }
  return input.observedActivationId === input.armedActivationId
    ? "abortArmedActivation"
    : "retainMissing";
};

/** Read the deletion marker before observing facet existence so a completed deletion cannot race stale state. */
export const qualificationControlledAgentFaultDeletionFenced = (input: {
  readonly hasAgent: () => boolean;
  readonly readDeletionStarted: () => Promise<boolean>;
}): Promise<boolean> =>
  input.readDeletionStarted().then((deletionStarted) => deletionStarted || !input.hasAgent());

/** Project an exact one-root recovery into the existing run-level fault contract. */
export const qualificationControlledAgentFaultReceipt = (input: {
  readonly manifestChecksum: string;
  readonly receipt: QualificationControlledAgentRecoveryReceipt;
  readonly scheduledTriggerAtUtc: string;
}): FaultControllerReceipt => {
  const content = {
    applicationAuthorityFactId: input.receipt.applicationAuthorityFactId,
    applicationStatus: "applied" as const,
    artifactId: `qualification/fault-controller/${encodeURIComponent(input.receipt.controllerOperationId)}.json`,
    controllerOperationId: input.receipt.controllerOperationId,
    controllerSource: "osfo-directory-facet-abort-v1",
    durationSeconds: 0,
    endedAtUtc: input.receipt.recoveredAtUtc,
    executionId: input.receipt.executionId,
    injectedAtUtc: input.receipt.appliedAtUtc,
    kind: "coldActivation" as const,
    manifestChecksum: input.manifestChecksum,
    planChecksum: input.receipt.planChecksum,
    restorationAuthorityFactId: input.receipt.restorationAuthorityFactId,
    runId: input.receipt.runId,
    scheduledTriggerAtUtc: input.scheduledTriggerAtUtc,
    target: "osfoAgent" as const,
    trigger: "beforeOffer" as const,
    triggerAuthorityFactId: null,
    triggerObservedAtUtc: input.receipt.appliedAtUtc,
  };
  const receipt = {
    ...content,
    artifactChecksum: qualificationChecksum(content),
  } satisfies FaultControllerReceipt;
  Schema.decodeSync(FaultControllerReceiptBoundary)(receipt);
  return receipt;
};

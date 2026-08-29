import { Option, Schema } from "effect";

import { AgentId, UserId } from "../domain";
import { QualificationContext } from "../domain/qualification-context";
import { SubmitManagedConversationInput } from "../services/managed-conversation";
import { qualificationChecksum } from "./qualification-checksum";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Immutable producer authorization for one exact qualification Agent admission. */
export const QualificationConversationAttemptArtifact = Schema.Struct({
  agentId: AgentId,
  artifactChecksum: identity,
  authSessionExpiresAtUtc: Schema.String,
  authSessionId: identity,
  context: QualificationContext,
  messageChecksum: identity,
  participantGrantChecksum: identity,
  routeId: SubmitManagedConversationInput.fields.routeId,
  submissionId: SubmitManagedConversationInput.fields.submissionId,
  userId: UserId,
});

/** Producer-owned decision retained after the Agent's serialized admission boundary. */
export const QualificationAdmissionReceipt = Schema.Struct({
  acceptanceReceiptId: identity,
  admissionDecision: Schema.Literals(["accepted", "capacityRejected", "typedStressRejected"]),
  agentId: AgentId,
  artifactChecksum: identity,
  attemptId: identity,
  executionId: identity,
  occurredAt: Schema.String,
  planChecksum: identity,
  productFactId: identity,
  rootId: identity,
  runId: identity,
  thinkSubmissionId: Schema.NullOr(identity),
  userMessageId: identity,
  userUpdateId: identity,
});

/** Private Agent request. The public managed-conversation RPC never accepts this context. */
export const SubmitQualificationConversationInput = Schema.Struct({
  ...SubmitManagedConversationInput.fields,
  qualificationContext: QualificationContext,
  proofArtifactChecksum: identity,
  proofArtifactId: identity,
});

export type QualificationConversationAttemptArtifact =
  typeof QualificationConversationAttemptArtifact.Type;
export type QualificationAdmissionReceipt = typeof QualificationAdmissionReceipt.Type;
export type SubmitQualificationConversationRequest =
  typeof SubmitQualificationConversationInput.Encoded;

interface QualificationConversationAttemptInput {
  readonly authorization: { readonly user: { readonly userId: string } };
  readonly message: string;
  readonly proofArtifactChecksum: string;
  readonly proofArtifactId: string;
  readonly qualificationContext: QualificationContext;
  readonly routeId: string;
  readonly submissionId: string;
}

export const qualificationAttemptArtifactId = (context: QualificationContext): string =>
  `qualification/executions/${encodeURIComponent(context.executionId)}/attempts/${encodeURIComponent(context.runId)}/${encodeURIComponent(context.rootId)}.json`;

export const qualificationAdmissionArtifactId = (context: QualificationContext): string =>
  `qualification/executions/${encodeURIComponent(context.executionId)}/producer-authority/worker_admission_receipts/${encodeURIComponent(context.runId)}/${encodeURIComponent(context.rootId)}.json`;

const decodeArtifact = Schema.decodeUnknownOption(
  Schema.fromJsonString(QualificationConversationAttemptArtifact),
);

/** Verify that retained server authority grants this exact Agent submission and no other. */
export const verifyQualificationConversationAttempt = (
  encoded: string,
  input: QualificationConversationAttemptInput,
  agentId: AgentId,
): boolean => {
  const decoded = decodeArtifact(encoded);
  if (Option.isNone(decoded)) return false;
  const artifact = decoded.value;
  const { artifactChecksum, ...content } = artifact;
  return (
    input.proofArtifactId === qualificationAttemptArtifactId(input.qualificationContext) &&
    input.proofArtifactChecksum === artifactChecksum &&
    artifactChecksum === qualificationChecksum(content) &&
    artifact.agentId === agentId &&
    artifact.userId === input.authorization.user.userId &&
    artifact.routeId === input.routeId &&
    artifact.submissionId === input.submissionId &&
    artifact.messageChecksum === qualificationChecksum({ message: input.message }) &&
    qualificationChecksum(artifact.context) === qualificationChecksum(input.qualificationContext)
  );
};

const capacityDenials = new Set(["liveResourceLimitReached", "operationLimitExceeded"]);

export type QualificationAdmissionOutcome =
  | {
      readonly decision: "accepted";
      readonly occurredAt: string;
      readonly thinkSubmissionId: string;
    }
  | {
      readonly decision: "capacityRejected" | "typedStressRejected";
      readonly occurredAt: string;
    };

/** Derive one immutable receipt from an explicit product admission outcome. */
export const qualificationAdmissionReceipt = (
  input: QualificationConversationAttemptInput,
  agentId: AgentId,
  outcome: QualificationAdmissionOutcome,
): QualificationAdmissionReceipt => {
  const admissionDecision = outcome.decision;
  const factIdentity = {
    admissionDecision,
    agentId,
    attemptId: input.qualificationContext.attemptId,
    executionId: input.qualificationContext.executionId,
    planChecksum: input.qualificationContext.planChecksum,
    rootId: input.qualificationContext.rootId,
    runId: input.qualificationContext.runId,
  };
  const productFactId = qualificationChecksum(factIdentity);
  const content = {
    acceptanceReceiptId: productFactId,
    admissionDecision,
    agentId,
    attemptId: input.qualificationContext.attemptId,
    executionId: input.qualificationContext.executionId,
    occurredAt: outcome.occurredAt,
    planChecksum: input.qualificationContext.planChecksum,
    productFactId,
    rootId: input.qualificationContext.rootId,
    runId: input.qualificationContext.runId,
    thinkSubmissionId: outcome.decision === "accepted" ? outcome.thinkSubmissionId : null,
    userMessageId: input.submissionId,
    userUpdateId: productFactId,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

/** Map only an explicit policy denial to a qualification rejection disposition. */
export const qualificationRejectionDecision = (
  reason: string,
): "capacityRejected" | "typedStressRejected" =>
  capacityDenials.has(reason) ? "capacityRejected" : "typedStressRejected";

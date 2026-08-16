import { Schema } from "effect";

import { UserId } from "../domain";
import { AuthorizationOperationName } from "./authorization-operation";

const boundedText = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        (value.length > 0 && value.length <= maximum) ||
        `must contain between 1 and ${maximum} characters`,
    ),
  );

/** Stable identity of one exact effectful Think ToolCall. */
export const ActionId = Schema.String.pipe(Schema.brand("ActionId"));

/** Stable identity of one exact effectful Think ToolCall. */
export type ActionId = typeof ActionId.Type;

/** Opaque client-facing identity of one immutable Action Presentation. */
export const ActionPresentationId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^action-presentation-[0-9a-f-]{36}$/.test(value) ||
      "must be an opaque Action Presentation identity",
  ),
).pipe(Schema.brand("ActionPresentationId"));

/** Opaque client-facing identity of one immutable Action Presentation. */
export type ActionPresentationId = typeof ActionPresentationId.Type;

/** Internal identity of one finite Approval Request. */
export const ApprovalRequestId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^approval-request-[0-9a-f-]{36}$/.test(value) || "must be an Approval Request identity",
  ),
).pipe(Schema.brand("ApprovalRequestId"));

/** Internal identity of one finite Approval Request. */
export type ApprovalRequestId = typeof ApprovalRequestId.Type;

/** Version of the Action definition that owns materiality and presentation. */
export const ActionDefinitionVersion = Schema.String.pipe(Schema.brand("ActionDefinitionVersion"));

/** Version of the Action definition that owns materiality and presentation. */
export type ActionDefinitionVersion = typeof ActionDefinitionVersion.Type;

/** SHA-256 digest bound to all client-safe material Action facts. */
export const ActionDigest = Schema.String.check(
  Schema.makeFilter((value) => /^sha256:[0-9a-f]{64}$/.test(value) || "must be one SHA-256 digest"),
).pipe(Schema.brand("ActionDigest"));

/** SHA-256 digest bound to all client-safe material Action facts. */
export type ActionDigest = typeof ActionDigest.Type;

/** One bounded, explicitly client-safe material field. */
export const ActionPresentationField = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    label: boundedText(80),
    name: boundedText(80),
    value: boundedText(2_000),
  }),
  Schema.Struct({
    kind: Schema.Literal("integer"),
    label: boundedText(80),
    name: boundedText(80),
    unit: boundedText(40),
    value: Schema.BigInt,
  }),
  Schema.Struct({
    contentId: boundedText(160),
    digestSha256: Schema.String.check(
      Schema.makeFilter(
        (value) => /^[0-9a-f]{64}$/.test(value) || "must be a SHA-256 content digest",
      ),
    ),
    kind: Schema.Literal("content"),
    label: boundedText(80),
    mediaType: boundedText(160),
    name: boundedText(80),
    sizeBytes: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  }),
]);

/** One bounded, explicitly client-safe material field. */
export type ActionPresentationField = typeof ActionPresentationField.Type;

/** Worker-authenticated authority facts allowed to read or decide an Approval. */
export const ApprovalActor = Schema.Union([
  Schema.TaggedStruct("AuthSession", {
    authSessionId: Schema.String,
    expiresAt: Schema.DateFromString,
    userId: UserId,
  }),
  Schema.TaggedStruct("ChannelBinding", {
    channelBindingId: Schema.String,
    userId: UserId,
  }),
]);

/** Worker-authenticated authority facts allowed to read or decide an Approval. */
export type ApprovalActor = typeof ApprovalActor.Type;

/** Durable non-secret reference to the authority that decided one Approval. */
export const ApprovalActorReference = Schema.Union([
  Schema.TaggedStruct("AuthSession", {}),
  Schema.TaggedStruct("ChannelBinding", {}),
]);

/** Durable non-secret reference to the authority that decided one Approval. */
export type ApprovalActorReference = typeof ApprovalActorReference.Type;

/** Authority that originated one protected Action. */
export const ActionOriginatingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: Schema.String }),
  Schema.TaggedStruct("ChannelBinding", { channelBindingId: Schema.String }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
  }),
]);

/** Authority that originated one protected Action. */
export type ActionOriginatingAuthority = typeof ActionOriginatingAuthority.Type;

/** Persisted exact Approval facts required before protected effect execution. */
export const CommittedApprovedAction = Schema.Struct({
  actionId: ActionId,
  operation: AuthorizationOperationName,
  originatingAuthority: ActionOriginatingAuthority,
  userId: UserId,
});

/** Persisted exact Approval facts required before protected effect execution. */
export type CommittedApprovedAction = typeof CommittedApprovedAction.Type;

/** Trusted feature input used to commit one immutable Action Presentation. */
export const PrepareActionPresentationInput = Schema.Struct({
  actionDefinitionVersion: ActionDefinitionVersion,
  actionId: ActionId,
  consequences: Schema.Array(boundedText(500)).check(
    Schema.makeFilter((items) => items.length > 0 || "must state at least one consequence"),
  ),
  createdAt: Schema.DateFromString,
  description: boundedText(1_000),
  executionId: Schema.String,
  fields: Schema.Array(ActionPresentationField).check(
    Schema.makeFilter(
      (fields) =>
        new Set(fields.map(({ name }) => name)).size === fields.length ||
        "material field names must be unique",
    ),
  ),
  operation: AuthorizationOperationName,
  originatingAuthority: ActionOriginatingAuthority,
  title: boundedText(120),
  userId: UserId,
});

/** Trusted feature input used to commit one immutable Action Presentation. */
export type PrepareActionPresentationInput = typeof PrepareActionPresentationInput.Type;

/** RPC representation of one Action Presentation preparation. */
export type PrepareActionPresentationEncoded = typeof PrepareActionPresentationInput.Encoded;

/** Immutable client-safe presentation of every material Action fact. */
export const ActionPresentation = Schema.Struct({
  actionDefinitionVersion: ActionDefinitionVersion,
  actionDigest: ActionDigest,
  actionId: ActionId,
  consequences: Schema.Array(Schema.String),
  createdAt: Schema.Date,
  description: Schema.String,
  expiresAt: Schema.Date,
  fields: Schema.Array(ActionPresentationField),
  operation: AuthorizationOperationName,
  presentationId: ActionPresentationId,
  title: Schema.String,
});

/** Immutable client-safe presentation of every material Action fact. */
export type ActionPresentation = typeof ActionPresentation.Type;

/** Current finite lifecycle of one exact Approval Request. */
export const ApprovalStatus = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Approved", { actor: ApprovalActorReference, decidedAt: Schema.Date }),
  Schema.TaggedStruct("Denied", {
    actor: ApprovalActorReference,
    decidedAt: Schema.Date,
    reason: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Expired", { expiredAt: Schema.Date }),
  Schema.TaggedStruct("Canceled", { canceledAt: Schema.Date, reason: Schema.String }),
]);

/** Current finite lifecycle of one exact Approval Request. */
export type ApprovalStatus = typeof ApprovalStatus.Type;

/** Successful preparation of one immutable presentation and pending Approval. */
export const ActionPresentationPrepared = Schema.TaggedStruct("ActionPresentationPrepared", {
  presentation: ActionPresentation,
  status: ApprovalStatus,
});

/** Successful preparation of one immutable presentation and pending Approval. */
export type ActionPresentationPrepared = typeof ActionPresentationPrepared.Type;

/** Authenticated read input for one opaque presentation identity. */
export const ReadActionPresentationInput = Schema.Struct({
  actor: ApprovalActor,
  presentationId: ActionPresentationId,
});

/** Parsed authenticated input for one opaque presentation identity. */
export type ReadActionPresentationInput = typeof ReadActionPresentationInput.Type;

/** RPC representation of one authenticated Action Presentation read. */
export type ReadActionPresentationEncoded = typeof ReadActionPresentationInput.Encoded;

/** Authenticated view of one exact Action and its current Approval state. */
export const ActionPresentationFound = Schema.TaggedStruct("ActionPresentationFound", {
  presentation: ActionPresentation,
  status: ApprovalStatus,
});

/** Authenticated view of one exact Action and its current Approval state. */
export type ActionPresentationFound = typeof ActionPresentationFound.Type;

/** Authenticated terminal Approval decision for one opaque presentation identity. */
export const DecideActionApprovalInput = Schema.Struct({
  actor: ApprovalActor,
  decision: Schema.Literals(["approve", "reject"]),
  presentationId: ActionPresentationId,
  reason: Schema.optional(boundedText(500)),
});

/** Parsed authenticated terminal Approval decision. */
export type DecideActionApprovalInput = typeof DecideActionApprovalInput.Type;

/** RPC representation of one exact Approval decision. */
export type DecideActionApprovalEncoded = typeof DecideActionApprovalInput.Encoded;

/** Trusted cancellation of one pending Approval Request. */
export const CancelActionApprovalInput = Schema.Struct({
  presentationId: ActionPresentationId,
  reason: boundedText(500),
  userId: UserId,
});

/** Parsed cancellation of one pending Approval Request. */
export type CancelActionApprovalInput = typeof CancelActionApprovalInput.Type;

/** RPC representation of one Approval cancellation. */
export type CancelActionApprovalEncoded = typeof CancelActionApprovalInput.Encoded;

/** Successful first terminal Approval decision. */
export const ApprovalDecisionRecorded = Schema.TaggedStruct("ApprovalDecisionRecorded", {
  decision: Schema.Literals(["approved", "denied"]),
  presentationId: ActionPresentationId,
});

/** Successful first terminal Approval decision. */
export type ApprovalDecisionRecorded = typeof ApprovalDecisionRecorded.Type;

/** Successful first cancellation of one pending Approval Request. */
export const ApprovalCancellationRecorded = Schema.TaggedStruct("ApprovalCancellationRecorded", {
  presentationId: ActionPresentationId,
});

/** Successful first cancellation of one pending Approval Request. */
export type ApprovalCancellationRecorded = typeof ApprovalCancellationRecorded.Type;

/** Expected failure when an opaque Action Presentation identity is unknown. */
export class ActionPresentationNotFound extends Schema.TaggedError<ActionPresentationNotFound>()(
  "ActionPresentationNotFound",
  { message: Schema.String, presentationId: ActionPresentationId },
) {}

/** Expected denial when the current authority does not own the Action. */
export class ApprovalActorUnauthorized extends Schema.TaggedError<ApprovalActorUnauthorized>()(
  "ApprovalActorUnauthorized",
  { message: Schema.String, presentationId: ActionPresentationId, userId: UserId },
) {}

/** Expected conflict when one Action identity is reused for changed material facts. */
export class ActionMaterialityConflict extends Schema.TaggedError<ActionMaterialityConflict>()(
  "ActionMaterialityConflict",
  { actionId: ActionId, message: Schema.String },
) {}

/** Expected conflict when a different terminal decision already won. */
export class ApprovalAlreadyResolved extends Schema.TaggedError<ApprovalAlreadyResolved>()(
  "ApprovalAlreadyResolved",
  { message: Schema.String, presentationId: ActionPresentationId, status: ApprovalStatus },
) {}

/** Expected terminal answer when the Approval lifetime ended before decision. */
export class ApprovalExpired extends Schema.TaggedError<ApprovalExpired>()("ApprovalExpired", {
  expiredAt: Schema.Date,
  message: Schema.String,
  presentationId: ActionPresentationId,
}) {}

/** Expected denial when a protected Action has no persisted exact Approval. */
export class ActionNotApproved extends Schema.TaggedError<ActionNotApproved>()(
  "ActionNotApproved",
  {
    actionId: ActionId,
    message: Schema.String,
  },
) {}

/** Recoverable failure while handing one persisted Approval decision to Think. */
export class ApprovalDispatchUnavailable extends Schema.TaggedError<ApprovalDispatchUnavailable>()(
  "ApprovalDispatchUnavailable",
  {
    message: Schema.String,
    presentationId: ActionPresentationId,
  },
) {}

/** Explicit unresolved handoff when Think no longer exposes the prior Approval outcome. */
export class ApprovalDispatchAmbiguous extends Schema.TaggedError<ApprovalDispatchAmbiguous>()(
  "ApprovalDispatchAmbiguous",
  {
    message: Schema.String,
    presentationId: ActionPresentationId,
  },
) {}

/** Expected persistence failure at the Action Presentation boundary. */
export class ActionApprovalStoreUnavailable extends Schema.TaggedError<ActionApprovalStoreUnavailable>()(
  "ActionApprovalStoreUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected failure when persisted Action or Approval facts are malformed. */
export class ActionApprovalRecordInvalid extends Schema.TaggedError<ActionApprovalRecordInvalid>()(
  "ActionApprovalRecordInvalid",
  { message: Schema.String, operation: Schema.String },
) {}

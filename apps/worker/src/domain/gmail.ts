import { Schema } from "effect";

import { UserId } from "../domain";
import { ActionId } from "./action-execution";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Stable identity of one User-owned Gmail Integration Connection. */
export const GmailConnectionId = boundedIdentity.pipe(Schema.brand("GmailConnectionId"));

/** Stable identity of one User-owned Gmail Integration Connection. */
export type GmailConnectionId = typeof GmailConnectionId.Type;

/** OAuth facts accepted after the Gmail consent callback completes. */
export const GmailConnectionGrant = Schema.Struct({
  connectionId: GmailConnectionId,
  credentialReference: boundedIdentity,
  grantedAt: Schema.Date,
  providerAccountId: boundedIdentity,
});

/** OAuth facts accepted after the Gmail consent callback completes. */
export type GmailConnectionGrant = typeof GmailConnectionGrant.Type;

const ConnectedGmailConnection = Schema.TaggedStruct("Connected", {
  ...GmailConnectionGrant.fields,
  userId: UserId,
});

const RevokedGmailConnection = Schema.TaggedStruct("Revoked", {
  ...GmailConnectionGrant.fields,
  revokedAt: Schema.Date,
  userId: UserId,
});

/** Stored Gmail Integration Connection authority. */
export const GmailConnection = Schema.Union([ConnectedGmailConnection, RevokedGmailConnection]);

/** Stored Gmail Integration Connection authority. */
export type GmailConnection = typeof GmailConnection.Type;

/** Stable Gmail message resource selected by search or read. */
export const GmailMessageId = boundedIdentity.pipe(Schema.brand("GmailMessageId"));

/** Stable Gmail message resource selected by search or read. */
export type GmailMessageId = typeof GmailMessageId.Type;

const ToolCallId = boundedIdentity;
const EmailAddress = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

/** Bounded on-demand Gmail search request. */
export const GmailSearchInput = Schema.Struct({
  maximumMessages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })),
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  toolCallId: ToolCallId,
});

/** Bounded on-demand Gmail search request. */
export type GmailSearchInput = typeof GmailSearchInput.Type;

/** One selected Gmail message read request. */
export const GmailReadInput = Schema.Struct({
  messageId: GmailMessageId,
  toolCallId: ToolCallId,
});

/** One selected Gmail message read request. */
export type GmailReadInput = typeof GmailReadInput.Type;

/** Exact local email draft material. */
export const GmailDraftInput = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  recipient: EmailAddress,
  selectedResourceId: Schema.NullOr(GmailMessageId),
  subject: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(998),
    Schema.isPattern(/^[^\r\n]+$/),
  ),
  toolCallId: ToolCallId,
});

/** Exact local email draft material. */
export type GmailDraftInput = typeof GmailDraftInput.Type;

/** Bounded message metadata returned by Gmail search. */
export const GmailMessageSummary = Schema.Struct({
  from: EmailAddress,
  messageId: GmailMessageId,
  subject: Schema.String.check(Schema.isMaxLength(998)),
});

/** Bounded message metadata returned by Gmail search. */
export type GmailMessageSummary = typeof GmailMessageSummary.Type;

/** Trusted provider evidence for one completed Gmail search. */
export interface GmailSearchEvidence {
  readonly messages: ReadonlyArray<GmailMessageSummary>;
  readonly vendorUsdMicros: bigint;
}

/** Trusted provider evidence for one completed Gmail read. */
export interface GmailReadEvidence {
  readonly body: string;
  readonly from: string;
  readonly messageId: GmailMessageId;
  readonly subject: string;
  readonly vendorUsdMicros: bigint;
}

/** Exact Gmail send material released by one Think-owned Approval. */
export const GmailSendInput = Schema.Struct({
  actionId: ActionId,
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  recipient: GmailDraftInput.fields.recipient,
  scheduledFor: Schema.Null,
  selectedResourceId: GmailDraftInput.fields.selectedResourceId,
  subject: GmailDraftInput.fields.subject,
});

/** Exact Gmail send material released by one Think-owned Approval. */
export type GmailSendInput = typeof GmailSendInput.Type;

/** Normalized Gmail send evidence after provider contact or reconciliation. */
export type GmailSendEvidence =
  | {
      readonly _tag: "Applied";
      readonly evidence: string;
      readonly providerMessageId: GmailMessageId;
      readonly vendorUsdMicros: bigint;
    }
  | {
      readonly _tag: "NotApplied";
      readonly evidence: string;
      readonly vendorUsdMicros: bigint;
    }
  | {
      readonly _tag: "Ambiguous";
      readonly evidence: string;
      readonly vendorUsdMicros: bigint;
    };

/** Gmail-specific provider recovery evidence keyed by the existing Action identity. */
export const GmailSendAttempt = Schema.Struct({
  actionId: ActionId,
  connectionId: GmailConnectionId,
  outcome: Schema.Literals(["pending", "applied", "notApplied", "ambiguous"]),
  startedAt: Schema.Date,
});

/** Gmail-specific provider recovery evidence keyed by the existing Action identity. */
export type GmailSendAttempt = typeof GmailSendAttempt.Type;

/** Expected failure while writing Gmail-specific provider recovery evidence. */
export class GmailSendRecoveryUnavailable extends Schema.TaggedError<GmailSendRecoveryUnavailable>()(
  "GmailSendRecoveryUnavailable",
  {
    actionId: ActionId,
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["begin", "complete"]),
  },
) {}

/** User-visible connection state derived without deleting dormant authority. */
export type GmailConnectionStatus =
  | GmailConnection
  | {
      readonly _tag: "Dormant";
      readonly connectionId: GmailConnectionId;
      readonly providerAccountId: string;
      readonly userId: UserId;
    }
  | { readonly _tag: "NotConnected"; readonly userId: UserId };

/** Expected failure when Gmail connection persistence is unavailable. */
export class GmailPersistenceUnavailable extends Schema.TaggedError<GmailPersistenceUnavailable>()(
  "GmailPersistenceUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["connect", "findById", "findByUser", "revoke"]),
  },
) {}

/** Expected failure when an OAuth grant conflicts with established connection facts. */
export class GmailConnectionConflict extends Schema.TaggedError<GmailConnectionConflict>()(
  "GmailConnectionConflict",
  {
    connectionId: GmailConnectionId,
    message: Schema.String,
    userId: UserId,
  },
) {}

/** Expected provider boundary failure before a trusted Gmail outcome exists. */
export class GmailProviderUnavailable extends Schema.TaggedError<GmailProviderUnavailable>()(
  "GmailProviderUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["read", "search", "send"]),
  },
) {}

/** Expected failure when a metered Gmail operation has no admitted period. */
export class GmailAllowanceUnavailable extends Schema.TaggedError<GmailAllowanceUnavailable>()(
  "GmailAllowanceUnavailable",
  {
    message: Schema.String,
    operation: Schema.Literals(["draft", "read", "search", "send"]),
  },
) {}

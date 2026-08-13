import { DateTime, Option, Schema } from "effect";

const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));

/** Stable identity for one registered User. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));

/** Stable identity for one registered User. */
export type UserId = typeof UserId.Type;

/** Stable identity for one User-scoped Osfo Agent. */
export const AgentId = Schema.String.pipe(Schema.brand("AgentId"));

/** Stable identity for one User-scoped Osfo Agent. */
export type AgentId = typeof AgentId.Type;

/** Stable identity for one canonical Think Thread. */
export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));

/** Stable identity for one canonical Think Thread. */
export type ThreadId = typeof ThreadId.Type;

/** Stable identity for one private Knowledge Space. */
export const KnowledgeSpaceId = Schema.String.pipe(Schema.brand("KnowledgeSpaceId"));

/** Stable identity for one private Knowledge Space. */
export type KnowledgeSpaceId = typeof KnowledgeSpaceId.Type;

/** Stable identity for one Subscription. */
export const SubscriptionId = Schema.String.pipe(Schema.brand("SubscriptionId"));

/** Stable identity for one Subscription. */
export type SubscriptionId = typeof SubscriptionId.Type;

/** Stable identity for one Usage Allowance period. */
export const AllowancePeriodId = Schema.String.pipe(Schema.brand("AllowancePeriodId"));

/** Stable identity for one Usage Allowance period. */
export type AllowancePeriodId = typeof AllowancePeriodId.Type;

/** Stable identity for one current denial fact. */
export const DenialFactId = Schema.String.pipe(Schema.brand("DenialFactId"));

/** Stable identity for one current denial fact. */
export type DenialFactId = typeof DenialFactId.Type;

/** Opaque identity of the resource denied by one denial fact. */
export const DeniedResourceId = Schema.String.pipe(Schema.brand("DeniedResourceId"));

/** Opaque identity of the resource denied by one denial fact. */
export type DeniedResourceId = typeof DeniedResourceId.Type;

/** Stable identity for one independent Erasure Receipt. */
export const ErasureReceiptId = Schema.String.pipe(Schema.brand("ErasureReceiptId"));

/** Stable identity for one independent Erasure Receipt. */
export type ErasureReceiptId = typeof ErasureReceiptId.Type;

/** Opaque identity of private data named by one Erasure Receipt. */
export const ErasedResourceId = Schema.String.pipe(Schema.brand("ErasedResourceId"));

/** Opaque identity of private data named by one Erasure Receipt. */
export type ErasedResourceId = typeof ErasedResourceId.Type;

/** Digest of an opaque deletion manifest that contains no deleted content. */
export const DeletionManifestDigest = Sha256Digest.pipe(Schema.brand("DeletionManifestDigest"));

/** Digest of an opaque deletion manifest that contains no deleted content. */
export type DeletionManifestDigest = typeof DeletionManifestDigest.Type;

/** Stable idempotency identity for one directory command. */
export const DirectoryCommandId = Schema.String.pipe(Schema.brand("DirectoryCommandId"));

/** Stable idempotency identity for one directory command. */
export type DirectoryCommandId = typeof DirectoryCommandId.Type;

/** Digest of the complete immutable input to one directory command. */
export const DirectoryRequestDigest = Sha256Digest.pipe(Schema.brand("DirectoryRequestDigest"));

/** Digest of the complete immutable input to one directory command. */
export type DirectoryRequestDigest = typeof DirectoryRequestDigest.Type;

/** Version identity for one launch Plan policy. */
export const PlanPolicyVersion = Schema.String.pipe(Schema.brand("PlanPolicyVersion"));

/** Version identity for one launch Plan policy. */
export type PlanPolicyVersion = typeof PlanPolicyVersion.Type;

/** UTC timestamp stored as an ISO 8601 string. */
export const DirectoryTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.endsWith("Z") && Option.isSome(DateTime.make(value))) ||
      "must be a valid UTC ISO 8601 timestamp",
  ),
).pipe(Schema.brand("DirectoryTimestamp"));

/** UTC timestamp stored as an ISO 8601 string. */
export type DirectoryTimestamp = typeof DirectoryTimestamp.Type;

/** Launch Plan names persisted by the directory. */
export const Plan = Schema.Literals(["free", "adventurer"]);

/** Launch Plan names persisted by the directory. */
export type Plan = typeof Plan.Type;

/** Named v1 facts that deny otherwise eligible protected operations. */
export const DenialKind = Schema.Literals([
  "auth_session_revocation",
  "channel_binding_revocation",
  "deletion_request",
  "user_suspension",
]);

/** Named v1 facts that deny otherwise eligible protected operations. */
export type DenialKind = typeof DenialKind.Type;

/** User-requested operation protected by one Erasure Receipt. */
export const ErasureScope = Schema.Literals([
  "account_deletion",
  "message_redaction",
  "source_deletion",
  "thread_reset",
]);

/** User-requested operation protected by one Erasure Receipt. */
export type ErasureScope = typeof ErasureScope.Type;

/** Stable route from a User to the canonical Osfo Agent state. */
export const AgentRoute = Schema.Struct({
  agentId: AgentId,
  knowledgeSpaceId: KnowledgeSpaceId,
  threadId: ThreadId,
  userId: UserId,
});

/** Stable route from a User to the canonical Osfo Agent state. */
export type AgentRoute = typeof AgentRoute.Type;

/** Result of atomically creating the launch identity facts. */
export const IdentityCreated = Schema.Struct({
  ...AgentRoute.fields,
  allowancePeriodId: AllowancePeriodId,
  plan: Plan,
  subscriptionId: SubscriptionId,
});

/** Result of atomically creating the launch identity facts. */
export type IdentityCreated = typeof IdentityCreated.Type;

/** Complete deterministic input for the atomic launch identity operation. */
export const CreateIdentityInput = Schema.Struct({
  agentId: AgentId,
  allowancePeriodEndsAt: DirectoryTimestamp,
  allowancePeriodId: AllowancePeriodId,
  allowancePeriodStartsAt: DirectoryTimestamp,
  commandId: DirectoryCommandId,
  knowledgeSpaceId: KnowledgeSpaceId,
  occurredAt: DirectoryTimestamp,
  planPolicyVersion: PlanPolicyVersion,
  subscriptionId: SubscriptionId,
  threadId: ThreadId,
  userId: UserId,
});

/** Complete deterministic input for the atomic launch identity operation. */
export type CreateIdentityInput = typeof CreateIdentityInput.Type;

/** Content-free fact that blocks protected operations for one User or resource. */
export const DenialFact = Schema.Struct({
  denialFactId: DenialFactId,
  kind: DenialKind,
  occurredAt: DirectoryTimestamp,
  resourceId: DeniedResourceId,
  userId: UserId,
});

/** Content-free fact that blocks protected operations for one User or resource. */
export type DenialFact = typeof DenialFact.Type;

/** Complete deterministic input for recording one denial fact. */
export const RecordDenialFactInput = Schema.Struct({
  commandId: DirectoryCommandId,
  denialFactId: DenialFactId,
  kind: DenialKind,
  occurredAt: DirectoryTimestamp,
  resourceId: DeniedResourceId,
  userId: UserId,
});

/** Complete deterministic input for recording one denial fact. */
export type RecordDenialFactInput = typeof RecordDenialFactInput.Type;

/** Content-free deletion fact kept outside the directory restore target. */
export const ErasureReceipt = Schema.Struct({
  manifestDigest: DeletionManifestDigest,
  receiptId: ErasureReceiptId,
  recordedAt: DirectoryTimestamp,
  resourceId: ErasedResourceId,
  scope: ErasureScope,
});

/** Content-free deletion fact kept outside the directory restore target. */
export type ErasureReceipt = typeof ErasureReceipt.Type;

/** Complete deterministic input for recording one independent Erasure Receipt. */
export const RecordErasureReceiptInput = Schema.Struct({
  commandId: DirectoryCommandId,
  manifestDigest: DeletionManifestDigest,
  receiptId: ErasureReceiptId,
  recordedAt: DirectoryTimestamp,
  resourceId: ErasedResourceId,
  scope: ErasureScope,
});

/** Complete deterministic input for recording one independent Erasure Receipt. */
export type RecordErasureReceiptInput = typeof RecordErasureReceiptInput.Type;

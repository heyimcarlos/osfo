import { Context, type Effect, Schema } from "effect";

import type { SessionId, UserId } from "../domain";
import { AllowanceItem } from "../domain/allowance";

/** Opaque provider-assigned identity for one recalled Knowledge Base memory. */
export const KnowledgeMemoryId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("KnowledgeMemoryId"),
);

/** Opaque provider-assigned identity for one recalled Knowledge Base memory. */
export type KnowledgeMemoryId = typeof KnowledgeMemoryId.Type;

/** Human-visible conversation roles accepted by the Knowledge Base. */
export const ConversationRole = Schema.Literals(["user", "assistant"]);

/** Human-visible conversation roles accepted by the Knowledge Base. */
export type ConversationRole = typeof ConversationRole.Type;

/** One committed human-visible message sent in a Session conversation. */
export const ConversationMessage = Schema.Struct({
  content: Schema.String.check(Schema.isMinLength(1)),
  role: ConversationRole,
});

/** One committed human-visible message sent in a Session conversation. */
export type ConversationMessage = typeof ConversationMessage.Type;

/** Full conversation plus the first message included in conservative usage for this turn. */
export const ConversationSnapshot = Schema.Struct({
  messages: Schema.NonEmptyArray(ConversationMessage),
  usageStartIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
  .check(
    Schema.makeFilter(
      ({ messages, usageStartIndex }) =>
        usageStartIndex < messages.length || "must identify a message in the snapshot",
    ),
  )
  .pipe(Schema.brand("MemoryProviderConversationSnapshot"));

/** Full conversation plus the first message included in conservative usage for this turn. */
export type ConversationSnapshot = typeof ConversationSnapshot.Type;

/** Normalized allowance evidence returned without provider billing objects. */
export const UsageEvidence = Schema.Struct({
  items: Schema.Array(AllowanceItem),
  rateCardVersion: Schema.String.check(Schema.isMinLength(1)),
});

/** Normalized allowance evidence returned without provider billing objects. */
export type UsageEvidence = typeof UsageEvidence.Type;

/** User-scoped Knowledge Base recall request. */
export interface RecallInput {
  readonly query: string;
  readonly userId: UserId;
}

/** One query-relevant item of derived Knowledge Base evidence. */
export interface RelevantMemory {
  readonly content: string;
  readonly id: KnowledgeMemoryId;
  readonly similarity: number;
}

/** Current provider profile and query-relevant Knowledge Base evidence. */
export interface RecallResult {
  readonly profile: {
    readonly dynamic: ReadonlyArray<string>;
    readonly static: ReadonlyArray<string>;
  };
  readonly relevantMemories: ReadonlyArray<RelevantMemory>;
  readonly usage: UsageEvidence;
}

/** One ordered conversation snapshot ending at a committed Session turn. */
export interface SaveConversationInput {
  readonly conversation: ConversationSnapshot;
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

/** Successful provider acceptance of one Session conversation snapshot. */
export interface SaveConversationResult {
  readonly usage: UsageEvidence;
}

/** Exact approved derived memories to forget within one User scope. */
export interface ForgetKnowledgeInput {
  readonly memoryIds: readonly [KnowledgeMemoryId, ...Array<KnowledgeMemoryId>];
  readonly userId: UserId;
}

/** One Session conversation to delete from the Knowledge Base. */
export interface DeleteSessionConversationInput {
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

/** All Knowledge Base data to delete for one User. */
export interface DeleteUserKnowledgeInput {
  readonly userId: UserId;
}

/** Confirmed live absence after a provider deletion operation. */
export type DeletionResult = { readonly _tag: "AlreadyAbsent" } | { readonly _tag: "Deleted" };

/** MemoryProvider operations used in safe failures and telemetry. */
export const MemoryProviderOperation = Schema.Literals([
  "recall",
  "saveConversation",
  "forgetKnowledge",
  "deleteSessionConversation",
  "deleteUserKnowledge",
]);

/** MemoryProvider operations used in safe failures and telemetry. */
export type MemoryProviderOperation = typeof MemoryProviderOperation.Type;

/** Safe adapter diagnostic that excludes provider payloads and credentials. */
export const MemoryProviderDiagnostic = Schema.Literals([
  "identityMismatch",
  "requestEncoding",
  "responseDecoding",
  "transport",
]);

/** Safe adapter diagnostic that excludes provider payloads and credentials. */
export type MemoryProviderDiagnostic = typeof MemoryProviderDiagnostic.Type;

/** Non-retryable rejection from the selected MemoryProvider. */
export class MemoryProviderRejected extends Schema.TaggedError<MemoryProviderRejected>()(
  "MemoryProviderRejected",
  {
    message: Schema.String,
    operation: MemoryProviderOperation,
    status: Schema.optionalKey(Schema.Int),
  },
) {}

/** Retryable transport, provider, or response failure from the selected MemoryProvider. */
export class MemoryProviderUnavailable extends Schema.TaggedError<MemoryProviderUnavailable>()(
  "MemoryProviderUnavailable",
  {
    diagnostic: Schema.optionalKey(MemoryProviderDiagnostic),
    message: Schema.String,
    operation: MemoryProviderOperation,
    status: Schema.optionalKey(Schema.Int),
  },
) {}

/** Application-owned Knowledge Base operations independent of provider SDK types. */
export interface Interface {
  readonly saveConversation: (
    input: SaveConversationInput,
  ) => Effect.Effect<SaveConversationResult, MemoryProviderRejected | MemoryProviderUnavailable>;
  readonly deleteSessionConversation: (
    input: DeleteSessionConversationInput,
  ) => Effect.Effect<DeletionResult, MemoryProviderRejected | MemoryProviderUnavailable>;
  readonly deleteUserKnowledge: (
    input: DeleteUserKnowledgeInput,
  ) => Effect.Effect<DeletionResult, MemoryProviderRejected | MemoryProviderUnavailable>;
  readonly forgetKnowledge: (
    input: ForgetKnowledgeInput,
  ) => Effect.Effect<DeletionResult, MemoryProviderRejected | MemoryProviderUnavailable>;
  readonly recall: (
    input: RecallInput,
  ) => Effect.Effect<RecallResult, MemoryProviderRejected | MemoryProviderUnavailable>;
}

/** Replaceable external Knowledge Base capability. */
export class Service extends Context.Service<Service, Interface>()("@osfo/MemoryProvider") {}

export * as MemoryProvider from "./memory-provider";

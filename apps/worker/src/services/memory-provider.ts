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

/** One newly committed human-visible message sent in a Session delta. */
export const ConversationMessage = Schema.Struct({
  content: Schema.String.check(Schema.isMinLength(1)),
  role: ConversationRole,
});

/** One newly committed human-visible message sent in a Session delta. */
export type ConversationMessage = typeof ConversationMessage.Type;

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

/** One ordered, delta-only append for a committed Session turn. */
export interface AppendConversationDeltaInput {
  readonly messages: readonly [ConversationMessage, ...Array<ConversationMessage>];
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

/** Successful provider acceptance of one Session conversation delta. */
export interface AppendConversationDeltaResult {
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
  "appendConversationDelta",
  "forgetKnowledge",
  "deleteSessionConversation",
  "deleteUserKnowledge",
]);

/** MemoryProvider operations used in safe failures and telemetry. */
export type MemoryProviderOperation = typeof MemoryProviderOperation.Type;

/** Non-retryable rejection from the selected MemoryProvider. */
export class MemoryProviderRejected extends Schema.TaggedError<MemoryProviderRejected>()(
  "MemoryProviderRejected",
  {
    message: Schema.String,
    operation: MemoryProviderOperation,
  },
) {}

/** Retryable transport, provider, or response failure from the selected MemoryProvider. */
export class MemoryProviderUnavailable extends Schema.TaggedError<MemoryProviderUnavailable>()(
  "MemoryProviderUnavailable",
  {
    message: Schema.String,
    operation: MemoryProviderOperation,
  },
) {}

/** Application-owned Knowledge Base operations independent of provider SDK types. */
export interface Interface {
  readonly appendConversationDelta: (
    input: AppendConversationDeltaInput,
  ) => Effect.Effect<
    AppendConversationDeltaResult,
    MemoryProviderRejected | MemoryProviderUnavailable
  >;
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

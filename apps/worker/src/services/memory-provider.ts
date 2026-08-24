import { Array, Context, DateTime, type Effect, Option, Order, Schema } from "effect";

import type { SessionId, UserId } from "../domain";
import { CompletedNonModelCost } from "../domain/usage";

/** Opaque provider-assigned identity for one recalled Knowledge Base memory. */
export const KnowledgeMemoryId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("KnowledgeMemoryId"),
);

/** Opaque provider-assigned identity for one recalled Knowledge Base memory. */
export type KnowledgeMemoryId = typeof KnowledgeMemoryId.Type;

/** Opaque provider-assigned identity for one indexed source chunk. */
export const SourceChunkId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("SourceChunkId"),
);

/** Opaque provider-assigned identity for one indexed source chunk. */
export type SourceChunkId = typeof SourceChunkId.Type;

/** Provider evidence time validated as a UTC ISO 8601 timestamp before ordering. */
export const EvidenceUpdatedAt = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.endsWith("Z") && Option.isSome(DateTime.make(value))) ||
      "must be a valid UTC ISO 8601 timestamp",
  ),
).pipe(Schema.brand("MemoryProviderEvidenceUpdatedAt"));

/** Provider evidence time validated as a UTC ISO 8601 timestamp before ordering. */
export type EvidenceUpdatedAt = typeof EvidenceUpdatedAt.Type;

/** Opaque provider-assigned identity for one accepted conversation document. */
export const ProviderDocumentId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ProviderDocumentId"),
);

/** Opaque provider-assigned identity for one accepted conversation document. */
export type ProviderDocumentId = typeof ProviderDocumentId.Type;

/** Application readiness for sending the next ordered conversation snapshot. */
export const ConversationProcessingStatus = Schema.Literals(["processing", "done"]);

/** Application readiness for sending the next ordered conversation snapshot. */
export type ConversationProcessingStatus = typeof ConversationProcessingStatus.Type;

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

/** Generic normalized non-model cost returned without provider billing objects. */
export const UsageEvidence = Schema.Struct({
  completedNonModelCost: Schema.NonEmptyArray(CompletedNonModelCost),
});

/** Generic normalized non-model cost returned without provider billing objects. */
export type UsageEvidence = typeof UsageEvidence.Type;

/** Versioned extraction guidance retained by the Agent-local repair workflow. */
export const ConfigurationVersion = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("MemoryProviderConfigurationVersion"),
);

/** Versioned extraction guidance retained by the Agent-local repair workflow. */
export type ConfigurationVersion = typeof ConfigurationVersion.Type;

/** Current organization-wide extraction guidance version. */
export const organizationGuidanceVersion = ConfigurationVersion.make("osfo-filter-prompt-v1");

/** Current per-User extraction guidance version. */
export const userGuidanceVersion = ConfigurationVersion.make("osfo-entity-context-v1");

/** Provider recall allowed by the current Plan Usage execution mode. */
export const RecallMode = Schema.Literals(["normal", "exhausted"]);

/** Provider recall allowed by the current Plan Usage execution mode. */
export type RecallMode = typeof RecallMode.Type;

/** User-scoped Knowledge Base recall request. */
export interface RecallInput {
  readonly mode: RecallMode;
  readonly query: string;
  readonly userId: UserId;
}

/** One query-relevant item of derived Knowledge Base evidence. */
export interface RelevantMemory {
  readonly content: string;
  readonly id: KnowledgeMemoryId;
  readonly similarity: number;
  readonly updatedAt: EvidenceUpdatedAt;
}

/** One query-relevant indexed source chunk from a Session conversation. */
export interface RelevantSourceChunk {
  readonly content: string;
  readonly id: SourceChunkId;
  readonly similarity: number;
  readonly updatedAt: EvidenceUpdatedAt;
}

/** Current provider profile and query-relevant Knowledge Base evidence. */
export interface RecallResult {
  readonly profile: {
    readonly dynamic: ReadonlyArray<string>;
    readonly static: ReadonlyArray<string>;
  };
  readonly relevantMemories: ReadonlyArray<RelevantMemory>;
  readonly sourceChunks: ReadonlyArray<RelevantSourceChunk>;
  readonly usage: UsageEvidence;
}

/** Stable safe aggregate used by provider cost observability paths. */
export const summarizeUsageEvidence = (usage: UsageEvidence) => ({
  ratedCostUsdMicros: usage.completedNonModelCost.reduce(
    (total, cost) => total + cost.ratedCostUsdMicros,
    0n,
  ),
  resourcePriceVersions: Array.sort(
    new Set(usage.completedNonModelCost.map(({ resourcePriceVersion }) => resourcePriceVersion)),
    Order.String,
  ),
});

/** One User container whose extraction guidance must be repaired after first ingest. */
export interface ConfigureUserGuidanceInput {
  readonly userId: UserId;
}

/** One ordered conversation snapshot ending at a committed Session turn. */
export interface SaveConversationInput {
  readonly conversation: ConversationSnapshot;
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

/** Successful provider acceptance of one Session conversation snapshot. */
export interface SaveConversationResult {
  readonly documentId: ProviderDocumentId;
  readonly processingStatus: ConversationProcessingStatus;
  readonly usage: UsageEvidence;
}

/** Accepted conversation document whose provider processing state must be checked. */
export interface GetConversationStatusInput {
  readonly documentId: ProviderDocumentId;
}

/** Current provider processing state for one accepted conversation document. */
export interface GetConversationStatusResult {
  readonly processingStatus: ConversationProcessingStatus;
}

/** Exact approved derived memories to forget within one User scope. */
export interface ForgetKnowledgeInput {
  readonly memoryIds: readonly [KnowledgeMemoryId, ...ReadonlyArray<KnowledgeMemoryId>];
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
  "configureOrganizationGuidance",
  "configureUserGuidance",
  "recall",
  "saveConversation",
  "getConversationStatus",
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

/** A save was accepted, but its returned status cannot safely drive ordered follow-up work. */
export class MemoryProviderAcceptanceStatusInvalid extends Schema.TaggedError<MemoryProviderAcceptanceStatusInvalid>()(
  "MemoryProviderAcceptanceStatusInvalid",
  {
    documentId: ProviderDocumentId,
    message: Schema.String,
    operation: Schema.Literal("saveConversation"),
    usage: UsageEvidence,
  },
) {}

/** Application-owned Knowledge Base operations independent of provider SDK types. */
export interface Interface {
  readonly configureOrganizationGuidance: Effect.Effect<
    void,
    MemoryProviderRejected | MemoryProviderUnavailable
  >;
  readonly configureUserGuidance: (
    input: ConfigureUserGuidanceInput,
  ) => Effect.Effect<void, MemoryProviderRejected | MemoryProviderUnavailable>;
  readonly getConversationStatus: (
    input: GetConversationStatusInput,
  ) => Effect.Effect<
    GetConversationStatusResult,
    MemoryProviderRejected | MemoryProviderUnavailable
  >;
  readonly saveConversation: (
    input: SaveConversationInput,
  ) => Effect.Effect<
    SaveConversationResult,
    MemoryProviderAcceptanceStatusInvalid | MemoryProviderRejected | MemoryProviderUnavailable
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

import { and, asc, desc, eq, isNull, max, ne, or } from "drizzle-orm";
import { Array, Effect, Option, Schema } from "effect";

import { ResourcePriceVersion, SessionId, UserId } from "../../../domain";
import type { AllowancePeriodId, AssistantMessageId } from "../../../domain";
import type { DbTimestamp } from "../../../db";
import { UsageActivity } from "../../../domain/usage";
import { MemoryProvider } from "../../../services/memory-provider";
import { ConversationSnapshotProjection } from "../memory-provider-projection";
import type { ConversationSnapshotProjection as ConversationSnapshotProjectionType } from "../memory-provider-projection";
import type { AgentDb } from "./client";
import { AgentStoreRecordInvalid, AgentStoreUnavailable } from "./errors";
import { memoryProviderConfiguration, memoryProviderOutbox } from "./schema";

/* oxlint-disable eslint/no-underscore-dangle -- Effect tagged payloads use the canonical _tag discriminator. */

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Stable identity of one immutable Agent-local provider operation. */
export const MemoryProviderOutboxId = NonEmptyString.pipe(Schema.brand("MemoryProviderOutboxId"));
export type MemoryProviderOutboxId = typeof MemoryProviderOutboxId.Type;

export const SaveConversationPayload = Schema.TaggedStruct("SaveConversation", {
  projection: ConversationSnapshotProjection,
});
export const DeleteSessionConversationPayload = Schema.TaggedStruct("DeleteSessionConversation", {
  sessionId: SessionId,
  userId: UserId,
});
export const DeleteUserKnowledgePayload = Schema.TaggedStruct("DeleteUserKnowledge", {
  userId: UserId,
});
export const ForgetKnowledgePayload = Schema.TaggedStruct("ForgetKnowledge", {
  memoryIds: Schema.NonEmptyArray(MemoryProvider.KnowledgeMemoryId),
  userId: UserId,
});

/** Exact provider input retained for retries without rebuilding from Think history. */
export const MemoryProviderOutboxPayload = Schema.Union([
  SaveConversationPayload,
  DeleteSessionConversationPayload,
  DeleteUserKnowledgePayload,
  ForgetKnowledgePayload,
]);
export type MemoryProviderOutboxPayload = typeof MemoryProviderOutboxPayload.Type;

/** Provider deletion payloads accepted from deletion workflows under their own authority. */
export const MemoryProviderDeletionPayload = Schema.Union([
  DeleteSessionConversationPayload,
  DeleteUserKnowledgePayload,
  ForgetKnowledgePayload,
]);
export type MemoryProviderDeletionPayload = typeof MemoryProviderDeletionPayload.Type;

export interface EnqueueMemoryProviderDeletion {
  readonly enqueuedAt: DbTimestamp;
  readonly outboxId: MemoryProviderOutboxId;
  readonly payload: MemoryProviderDeletionPayload;
}

const StoredUsageEvidence = Schema.Struct({
  completedNonModelCost: Schema.NonEmptyArray(
    Schema.Struct({
      activity: UsageActivity,
      ratedCostUsdMicros: Schema.BigIntFromString,
      resourcePriceVersion: ResourcePriceVersion,
    }),
  ),
});

export const MemoryProviderConfigurationScope = Schema.Literals(["organization", "user"]);
export type MemoryProviderConfigurationScope = typeof MemoryProviderConfigurationScope.Type;

export interface MemoryProviderConfigurationStatus {
  readonly configuredAt: DbTimestamp | null;
  readonly scope: MemoryProviderConfigurationScope;
  readonly status: "configured" | "pending";
  readonly version: MemoryProvider.ConfigurationVersion;
}

/** Newest committed turn evidence retained until its provider document is searchable. */
export interface RecentTurnBridgeEvidence {
  readonly messages: ReadonlyArray<MemoryProvider.ConversationMessage>;
  readonly recordedAt: DbTimestamp;
  readonly sourceId: MemoryProviderOutboxId;
}

const StoredProviderStatus = Schema.Union([
  MemoryProvider.ConversationProcessingStatus,
  Schema.Literal("failed"),
]);
type StoredProviderStatus = typeof StoredProviderStatus.Type;

export interface AcceptedConversationDocument {
  readonly documentId: MemoryProvider.ProviderDocumentId;
  readonly processingStatus: MemoryProvider.ConversationProcessingStatus;
}

/** One leased operation. A stale worker cannot settle it after the lease is reclaimed. */
export interface ClaimedMemoryProviderWork {
  readonly allowancePeriodId: AllowancePeriodId | null;
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly outboxId: MemoryProviderOutboxId;
  readonly payload: MemoryProviderOutboxPayload;
  readonly providerAcceptance: AcceptedConversationDocument | null;
  readonly sequence: number;
  readonly usage: MemoryProvider.UsageEvidence | null;
}

export interface MemoryProviderClaimCandidate {
  readonly availableAt: DbTimestamp;
  readonly claimExpiresAt: DbTimestamp | null;
  readonly orderingKey: string;
  readonly outboxId: string;
  readonly providerStatus: StoredProviderStatus | null;
  readonly status: "claimed" | "completed" | "failed" | "pending";
}

const actionableOrderingRows = <Row extends MemoryProviderOrderingRow>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> => {
  const visitedOrderingKeys = new Set<string>();
  return rows.filter((row) => {
    if (row.status === "completed") return false;
    if (row.status === "failed") {
      visitedOrderingKeys.add(row.orderingKey);
      return false;
    }
    if (row.providerStatus === "done") return true;
    if (visitedOrderingKeys.has(row.orderingKey)) return false;
    visitedOrderingKeys.add(row.orderingKey);
    return true;
  });
};

interface MemoryProviderOrderingRow {
  readonly orderingKey: string;
  readonly providerStatus: StoredProviderStatus | null;
  readonly status: "claimed" | "completed" | "failed" | "pending";
}

/** Select only the oldest unfinished operation per ordering key. */
export const selectMemoryProviderClaimCandidate = (
  rows: ReadonlyArray<MemoryProviderClaimCandidate>,
  now: DbTimestamp,
): MemoryProviderClaimCandidate | undefined => {
  return actionableOrderingRows(rows).find((row) => {
    if (row.status === "claimed" && row.claimExpiresAt !== null && row.claimExpiresAt > now) {
      return false;
    }
    return row.availableAt <= now;
  });
};

type AgentTransaction = Parameters<Parameters<AgentDb["transaction"]>[0]>[0];

/** Deterministic local identity used for every retry of a committed assistant boundary. */
export const conversationSnapshotOutboxId = (
  sessionId: SessionId,
  assistantMessageId: AssistantMessageId,
): MemoryProviderOutboxId =>
  MemoryProviderOutboxId.make(
    `conversation:${sessionId.length}:${sessionId}:${assistantMessageId}`,
  );

/** Insert one exact conversation snapshot inside the committed-turn receipt transaction. */
export const enqueueConversationSnapshotTransaction = (
  transaction: AgentTransaction,
  projection: ConversationSnapshotProjectionType,
  enqueuedAt: DbTimestamp,
) =>
  enqueueTransaction(transaction, {
    allowancePeriodId: projection.allowancePeriodId,
    enqueuedAt,
    operationType: "saveConversation",
    orderingKey: userOrderingKey(projection.userId),
    outboxId: conversationSnapshotOutboxId(projection.sessionId, projection.lastMessageId),
    payload: SaveConversationPayload.make({ projection }),
  });

/** Classify an existing durable snapshot without rebuilding its immutable payload. */
export const inspectConversationSnapshotTransaction = (
  transaction: AgentTransaction,
  projection: ConversationSnapshotProjectionType,
): "conflict" | "existing" | "missing" => {
  const outboxId = conversationSnapshotOutboxId(projection.sessionId, projection.lastMessageId);
  const existing = transaction
    .select({
      allowancePeriodId: memoryProviderOutbox.allowance_period_id,
      operationType: memoryProviderOutbox.operation_type,
      orderingKey: memoryProviderOutbox.ordering_key,
      payloadJson: memoryProviderOutbox.payload_json,
    })
    .from(memoryProviderOutbox)
    .where(eq(memoryProviderOutbox.outbox_id, outboxId))
    .limit(1)
    .get();
  if (existing === undefined) return "missing";
  const payload = Schema.decodeOption(Schema.fromJsonString(SaveConversationPayload))(
    existing.payloadJson,
  );
  if (Option.isNone(payload)) return "conflict";
  const stored = payload.value.projection;
  return existing.operationType === "saveConversation" &&
    existing.allowancePeriodId === projection.allowancePeriodId &&
    existing.orderingKey === userOrderingKey(projection.userId) &&
    stored.allowancePeriodId === projection.allowancePeriodId &&
    stored.lastMessageId === projection.lastMessageId &&
    stored.sessionId === projection.sessionId &&
    stored.userId === projection.userId
    ? "existing"
    : "conflict";
};

/** Construct the durable claim and settlement operations for provider reconciliation. */
export const makeMemoryProviderOutboxStore = (db: AgentDb) => {
  const readRecentTurnBridge = Effect.fn("MemoryProviderOutbox.readRecentTurnBridge")(function* (
    userId: UserId,
  ) {
    const rows = yield* execute("inspectMemoryProviderOutbox", () =>
      db
        .select({
          enqueuedAt: memoryProviderOutbox.enqueued_at,
          outboxId: memoryProviderOutbox.outbox_id,
          payloadJson: memoryProviderOutbox.payload_json,
          sequence: memoryProviderOutbox.sequence,
        })
        .from(memoryProviderOutbox)
        .where(
          and(
            eq(memoryProviderOutbox.operation_type, "saveConversation"),
            or(
              isNull(memoryProviderOutbox.provider_status),
              ne(memoryProviderOutbox.provider_status, "done"),
            ),
          ),
        )
        .orderBy(desc(memoryProviderOutbox.sequence))
        .limit(20)
        .all(),
    );
    const decoded = yield* Effect.forEach(rows, (row) =>
      Schema.decodeEffect(Schema.fromJsonString(SaveConversationPayload))(row.payloadJson).pipe(
        Effect.mapError(() => invalidRecord("inspectMemoryProviderOutbox")),
        Effect.map((payload) => ({ payload, row })),
      ),
    );
    const seenMessages = new Set<string>();
    const newest = decoded.flatMap(({ payload, row }) => {
      const projection = payload.projection;
      if (projection.userId !== userId) return [];
      const messages = projection.conversation.messages
        .slice(projection.conversation.usageStartIndex)
        .filter((message) => {
          const fingerprint = `${message.role}\u0000${message.content}`;
          if (seenMessages.has(fingerprint)) return false;
          seenMessages.add(fingerprint);
          return true;
        });
      if (messages.length === 0) return [];
      return [
        {
          messages,
          recordedAt: row.enqueuedAt,
          sourceId: MemoryProviderOutboxId.make(row.outboxId),
        } satisfies RecentTurnBridgeEvidence,
      ];
    });
    return Array.reverse(newest);
  });

  const requireConfiguration = Effect.fn("MemoryProviderOutbox.requireConfiguration")(
    (
      scope: MemoryProviderConfigurationScope,
      version: MemoryProvider.ConfigurationVersion,
      updatedAt: DbTimestamp,
    ) =>
      execute("inspectMemoryProviderOutbox", () =>
        db.transaction((transaction) => {
          const current = transaction
            .select({
              status: memoryProviderConfiguration.status,
              version: memoryProviderConfiguration.version,
            })
            .from(memoryProviderConfiguration)
            .where(eq(memoryProviderConfiguration.scope, scope))
            .limit(1)
            .get();
          if (current?.status === "configured" && current.version === version) return true;
          transaction
            .insert(memoryProviderConfiguration)
            .values({
              configured_at: null,
              scope,
              status: "pending",
              updated_at: updatedAt,
              version,
            })
            .onConflictDoUpdate({
              set: {
                configured_at: null,
                status: "pending",
                updated_at: updatedAt,
                version,
              },
              target: memoryProviderConfiguration.scope,
            })
            .run();
          return false;
        }),
      ),
  );

  const completeConfiguration = Effect.fn("MemoryProviderOutbox.completeConfiguration")(
    (
      scope: MemoryProviderConfigurationScope,
      version: MemoryProvider.ConfigurationVersion,
      configuredAt: DbTimestamp,
    ) =>
      execute("completeMemoryProviderOutbox", () => {
        const current = db
          .select({ version: memoryProviderConfiguration.version })
          .from(memoryProviderConfiguration)
          .where(eq(memoryProviderConfiguration.scope, scope))
          .limit(1)
          .get();
        if (current?.version !== version) return false;
        db.update(memoryProviderConfiguration)
          .set({ configured_at: configuredAt, status: "configured", updated_at: configuredAt })
          .where(eq(memoryProviderConfiguration.scope, scope))
          .run();
        return true;
      }),
  );

  const inspectConfiguration = Effect.fn("MemoryProviderOutbox.inspectConfiguration")(
    (scope: MemoryProviderConfigurationScope) =>
      execute("inspectMemoryProviderOutbox", () => {
        const row = db
          .select()
          .from(memoryProviderConfiguration)
          .where(eq(memoryProviderConfiguration.scope, scope))
          .limit(1)
          .get();
        if (row === undefined) return Option.none<MemoryProviderConfigurationStatus>();
        return Option.some({
          configuredAt: row.configured_at,
          scope: row.scope,
          status: row.status,
          version: MemoryProvider.ConfigurationVersion.make(row.version),
        } satisfies MemoryProviderConfigurationStatus);
      }),
  );

  const enqueueDeletion = Effect.fn("MemoryProviderOutbox.enqueueDeletion")(function* (
    input: EnqueueMemoryProviderDeletion,
  ) {
    const accepted = yield* execute("enqueueMemoryProviderOutbox", () =>
      db.transaction((transaction) =>
        enqueueTransaction(transaction, {
          allowancePeriodId: null,
          enqueuedAt: input.enqueuedAt,
          operationType: operationType(input.payload),
          orderingKey: userOrderingKey(input.payload.userId),
          outboxId: input.outboxId,
          payload: input.payload,
        }),
      ),
    );
    if (!accepted) return yield* invalidRecord("enqueueMemoryProviderOutbox");
    return undefined;
  });

  const claimNext = Effect.fn("MemoryProviderOutbox.claimNext")(function* (
    now: DbTimestamp,
    leaseExpiresAt: DbTimestamp,
    claimToken: string,
  ) {
    const claimed = yield* execute("claimMemoryProviderOutbox", () =>
      db.transaction((transaction) => {
        const rows = transaction
          .select()
          .from(memoryProviderOutbox)
          .where(ne(memoryProviderOutbox.status, "completed"))
          .orderBy(asc(memoryProviderOutbox.sequence))
          .all();
        const selected = selectMemoryProviderClaimCandidate(
          rows.map((row) => ({
            availableAt: row.available_at,
            claimExpiresAt: row.claim_expires_at,
            orderingKey: row.ordering_key,
            outboxId: row.outbox_id,
            providerStatus: row.provider_status,
            status: row.status,
          })),
          now,
        );
        const candidate = rows.find((row) => row.outbox_id === selected?.outboxId);
        if (candidate === undefined) return undefined;
        return transaction
          .update(memoryProviderOutbox)
          .set({
            attempt_count: candidate.attempt_count + 1,
            claim_expires_at: leaseExpiresAt,
            claim_token: claimToken,
            status: "claimed",
          })
          .where(eq(memoryProviderOutbox.outbox_id, candidate.outbox_id))
          .returning()
          .get();
      }),
    );
    if (claimed === undefined) return Option.none<ClaimedMemoryProviderWork>();
    return Option.some(yield* decodeClaim(claimed));
  });

  const markProviderAccepted = Effect.fn("MemoryProviderOutbox.markProviderAccepted")(
    (
      claim: ClaimedMemoryProviderWork,
      result: MemoryProvider.SaveConversationResult,
      acceptedAt: DbTimestamp,
    ) =>
      updateClaim("completeMemoryProviderOutbox", claim, {
        provider_accepted_at: acceptedAt,
        provider_document_id: result.documentId,
        provider_status: result.processingStatus,
        usage_json: encodeUsage(result.usage),
      }),
  );

  const markProviderStatus = Effect.fn("MemoryProviderOutbox.markProviderStatus")(
    (claim: ClaimedMemoryProviderWork, status: MemoryProvider.ConversationProcessingStatus) =>
      updateClaim("completeMemoryProviderOutbox", claim, { provider_status: status }),
  );

  const failProviderAcceptance = Effect.fn("MemoryProviderOutbox.failProviderAcceptance")(
    (
      claim: ClaimedMemoryProviderWork,
      failure: MemoryProvider.MemoryProviderAcceptanceStatusInvalid,
      acceptedAt: DbTimestamp,
    ) =>
      updateClaim("completeMemoryProviderOutbox", claim, {
        claim_expires_at: null,
        claim_token: null,
        last_error: failure.message,
        provider_accepted_at: acceptedAt,
        provider_document_id: failure.documentId,
        provider_status: "failed",
        status: "failed" as const,
        usage_json: encodeUsage(failure.usage),
      }),
  );

  const awaitProvider = Effect.fn("MemoryProviderOutbox.awaitProvider")(
    (
      claim: ClaimedMemoryProviderWork,
      processingStatus: MemoryProvider.ConversationProcessingStatus,
      availableAt: DbTimestamp,
    ) =>
      updateClaim("retryMemoryProviderOutbox", claim, {
        available_at: availableAt,
        claim_expires_at: null,
        claim_token: null,
        last_error: null,
        provider_status: processingStatus,
        status: "pending" as const,
      }),
  );

  const complete = Effect.fn("MemoryProviderOutbox.complete")(
    (claim: ClaimedMemoryProviderWork, completedAt: DbTimestamp) =>
      updateClaim("completeMemoryProviderOutbox", claim, {
        claim_expires_at: null,
        claim_token: null,
        completed_at: completedAt,
        last_error: null,
        status: "completed" as const,
      }),
  );

  const retry = Effect.fn("MemoryProviderOutbox.retry")(
    (claim: ClaimedMemoryProviderWork, availableAt: DbTimestamp, message: string) =>
      updateClaim("retryMemoryProviderOutbox", claim, {
        available_at: availableAt,
        claim_expires_at: null,
        claim_token: null,
        last_error: message,
        status: "pending" as const,
      }),
  );

  const fail = Effect.fn("MemoryProviderOutbox.fail")(
    (
      claim: ClaimedMemoryProviderWork,
      message: string,
      providerStatus?: Extract<StoredProviderStatus, "failed">,
    ) =>
      updateClaim("completeMemoryProviderOutbox", claim, {
        claim_expires_at: null,
        claim_token: null,
        last_error: message,
        provider_status: providerStatus,
        status: "failed" as const,
      }),
  );

  const hasRetryableWork = execute("inspectMemoryProviderOutbox", () => {
    const rows = db
      .select({
        orderingKey: memoryProviderOutbox.ordering_key,
        providerStatus: memoryProviderOutbox.provider_status,
        status: memoryProviderOutbox.status,
      })
      .from(memoryProviderOutbox)
      .where(ne(memoryProviderOutbox.status, "completed"))
      .orderBy(asc(memoryProviderOutbox.sequence))
      .all();
    return actionableOrderingRows(rows).some(
      (row) => row.status === "pending" || row.status === "claimed",
    );
  });

  const updateClaim = Effect.fn("MemoryProviderOutbox.updateClaim")(function* (
    operation: "completeMemoryProviderOutbox" | "retryMemoryProviderOutbox",
    claim: ClaimedMemoryProviderWork,
    values: Partial<typeof memoryProviderOutbox.$inferInsert>,
  ) {
    return yield* execute(operation, () =>
      db.transaction((transaction) => {
        const current = transaction
          .select({
            claimToken: memoryProviderOutbox.claim_token,
            status: memoryProviderOutbox.status,
          })
          .from(memoryProviderOutbox)
          .where(eq(memoryProviderOutbox.outbox_id, claim.outboxId))
          .limit(1)
          .get();
        if (current?.status !== "claimed" || current.claimToken !== claim.claimToken) return false;
        transaction
          .update(memoryProviderOutbox)
          .set(values)
          .where(eq(memoryProviderOutbox.outbox_id, claim.outboxId))
          .run();
        return true;
      }),
    );
  });

  return {
    claimNext,
    completeConfiguration,
    complete,
    enqueueDeletion,
    fail,
    failProviderAcceptance,
    hasRetryableWork,
    inspectConfiguration,
    awaitProvider,
    markProviderAccepted,
    markProviderStatus,
    readRecentTurnBridge,
    requireConfiguration,
    retry,
  };
};

export type MemoryProviderOutboxStore = ReturnType<typeof makeMemoryProviderOutboxStore>;

interface EnqueueMemoryProviderWork {
  readonly allowancePeriodId: AllowancePeriodId | null;
  readonly enqueuedAt: DbTimestamp;
  readonly operationType: (typeof memoryProviderOutbox.$inferInsert)["operation_type"];
  readonly orderingKey: string;
  readonly outboxId: MemoryProviderOutboxId;
  readonly payload: MemoryProviderOutboxPayload;
}

const enqueueTransaction = (transaction: AgentTransaction, input: EnqueueMemoryProviderWork) => {
  const payloadJson = JSON.stringify(input.payload);
  const existing = transaction
    .select({ payloadJson: memoryProviderOutbox.payload_json })
    .from(memoryProviderOutbox)
    .where(eq(memoryProviderOutbox.outbox_id, input.outboxId))
    .limit(1)
    .get();
  if (existing !== undefined) return existing.payloadJson === payloadJson;
  const maximumSequence =
    transaction
      .select({ value: max(memoryProviderOutbox.sequence) })
      .from(memoryProviderOutbox)
      .get()?.value ?? 0;
  transaction
    .insert(memoryProviderOutbox)
    .values({
      allowance_period_id: input.allowancePeriodId,
      available_at: input.enqueuedAt,
      enqueued_at: input.enqueuedAt,
      operation_type: input.operationType,
      ordering_key: input.orderingKey,
      outbox_id: input.outboxId,
      payload_json: payloadJson,
      sequence: maximumSequence + 1,
      status: "pending",
    })
    .run();
  return true;
};

const operationTypes = {
  DeleteSessionConversation: "deleteSessionConversation",
  DeleteUserKnowledge: "deleteUserKnowledge",
  ForgetKnowledge: "forgetKnowledge",
} as const;

const operationType = (payload: MemoryProviderDeletionPayload) => operationTypes[payload._tag];

const userOrderingKey = (userId: UserId): string => `user:${userId}`;

const decodeClaim = Effect.fn("MemoryProviderOutbox.decodeClaim")(function* (
  row: typeof memoryProviderOutbox.$inferSelect,
) {
  const payload = yield* Schema.decodeEffect(Schema.fromJsonString(MemoryProviderOutboxPayload))(
    row.payload_json,
  ).pipe(Effect.mapError(() => invalidRecord()));
  const usage =
    row.usage_json === null
      ? null
      : yield* decodeUsage(row.usage_json).pipe(Effect.mapError(() => invalidRecord()));
  if (row.claim_token === null || row.attempt_count < 1) return yield* invalidRecord();
  const providerDocumentId =
    row.provider_document_id === null
      ? null
      : yield* Schema.decodeEffect(MemoryProvider.ProviderDocumentId)(
          row.provider_document_id,
        ).pipe(Effect.mapError(() => invalidRecord()));
  const providerStatus =
    row.provider_status === null
      ? null
      : yield* Schema.decodeEffect(StoredProviderStatus)(row.provider_status).pipe(
          Effect.mapError(() => invalidRecord()),
        );
  const hasProviderAcceptance = row.provider_accepted_at !== null;
  if (
    hasProviderAcceptance !== (usage !== null) ||
    hasProviderAcceptance !== (providerDocumentId !== null) ||
    hasProviderAcceptance !== (providerStatus !== null) ||
    providerStatus === "failed"
  ) {
    return yield* invalidRecord();
  }
  if (
    payload._tag === "SaveConversation" &&
    (row.operation_type !== "saveConversation" ||
      row.allowance_period_id !== payload.projection.allowancePeriodId)
  ) {
    return yield* invalidRecord();
  }
  if (
    payload._tag !== "SaveConversation" &&
    (row.operation_type !== operationType(payload) ||
      row.allowance_period_id !== null ||
      hasProviderAcceptance)
  ) {
    return yield* invalidRecord();
  }
  const outboxId = yield* Schema.decodeEffect(MemoryProviderOutboxId)(row.outbox_id).pipe(
    Effect.mapError(() => invalidRecord()),
  );
  return {
    allowancePeriodId: row.allowance_period_id,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
    outboxId,
    payload,
    providerAcceptance:
      providerDocumentId === null || providerStatus === null
        ? null
        : { documentId: providerDocumentId, processingStatus: providerStatus },
    sequence: row.sequence,
    usage,
  } satisfies ClaimedMemoryProviderWork;
});

const encodeUsage = Schema.encodeSync(Schema.fromJsonString(StoredUsageEvidence));

const decodeUsage = (json: string) =>
  Schema.decodeEffect(Schema.fromJsonString(StoredUsageEvidence))(json).pipe(
    Effect.flatMap(Schema.decodeEffect(MemoryProvider.UsageEvidence)),
  );

const invalidRecord = (
  operation:
    | "claimMemoryProviderOutbox"
    | "enqueueMemoryProviderOutbox"
    | "inspectMemoryProviderOutbox" = "claimMemoryProviderOutbox",
) =>
  new AgentStoreRecordInvalid({
    message: "Agent SQLite returned an invalid MemoryProvider outbox record",
    operation,
  });

const execute = <A>(
  operation:
    | "claimMemoryProviderOutbox"
    | "completeMemoryProviderOutbox"
    | "enqueueMemoryProviderOutbox"
    | "inspectMemoryProviderOutbox"
    | "retryMemoryProviderOutbox",
  query: () => A,
) =>
  Effect.try({
    try: query,
    catch: (cause) =>
      new AgentStoreUnavailable({
        cause,
        message: "Agent SQLite MemoryProvider outbox operation failed",
        operation,
      }),
  });

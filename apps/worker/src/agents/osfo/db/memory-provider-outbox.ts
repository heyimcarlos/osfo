import { asc, eq, max, ne } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";

import { SessionId, UserId } from "../../../domain";
import type { AllowancePeriodId, AssistantMessageId } from "../../../domain";
import type { DbTimestamp } from "../../../db";
import { AllowanceKind, ConsumptionBasis } from "../../../domain/allowance";
import { MemoryProvider } from "../../../services/memory-provider";
import { ConversationSnapshotProjection } from "../memory-provider-projection";
import type { ConversationSnapshotProjection as ConversationSnapshotProjectionType } from "../memory-provider-projection";
import type { AgentDb } from "./client";
import { AgentStoreRecordInvalid, AgentStoreUnavailable } from "./errors";
import { memoryProviderOutbox } from "./schema";

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
  items: Schema.Array(
    Schema.Struct({
      allowanceKind: AllowanceKind,
      basis: ConsumptionBasis,
      quantity: Schema.BigIntFromString,
    }),
  ),
  rateCardVersion: NonEmptyString,
});

/** One leased operation. A stale worker cannot settle it after the lease is reclaimed. */
export interface ClaimedMemoryProviderWork {
  readonly allowancePeriodId: AllowancePeriodId | null;
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly outboxId: MemoryProviderOutboxId;
  readonly payload: MemoryProviderOutboxPayload;
  readonly providerApplied: boolean;
  readonly sequence: number;
  readonly usage: MemoryProvider.UsageEvidence | null;
}

export interface MemoryProviderClaimCandidate {
  readonly availableAt: DbTimestamp;
  readonly claimExpiresAt: DbTimestamp | null;
  readonly orderingKey: string;
  readonly outboxId: string;
  readonly status: "claimed" | "completed" | "pending";
}

/** Select only the oldest unfinished operation per ordering key. */
export const selectMemoryProviderClaimCandidate = (
  rows: ReadonlyArray<MemoryProviderClaimCandidate>,
  now: DbTimestamp,
): MemoryProviderClaimCandidate | undefined => {
  const visitedOrderingKeys = new Set<string>();
  return rows.find((row) => {
    if (visitedOrderingKeys.has(row.orderingKey)) return false;
    visitedOrderingKeys.add(row.orderingKey);
    if (row.status === "completed") return false;
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

/** Check retry identity before a transaction mutates either its receipt or outbox row. */
export const conversationSnapshotIsCompatibleTransaction = (
  transaction: AgentTransaction,
  projection: ConversationSnapshotProjectionType,
): boolean => {
  const outboxId = conversationSnapshotOutboxId(projection.sessionId, projection.lastMessageId);
  const existing = transaction
    .select({ payloadJson: memoryProviderOutbox.payload_json })
    .from(memoryProviderOutbox)
    .where(eq(memoryProviderOutbox.outbox_id, outboxId))
    .limit(1)
    .get();
  return (
    existing === undefined ||
    existing.payloadJson === JSON.stringify(SaveConversationPayload.make({ projection }))
  );
};

/** Construct the durable claim and settlement operations for provider reconciliation. */
export const makeMemoryProviderOutboxStore = (db: AgentDb) => {
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

  const markProviderApplied = Effect.fn("MemoryProviderOutbox.markProviderApplied")(
    (
      claim: ClaimedMemoryProviderWork,
      usage: MemoryProvider.UsageEvidence,
      appliedAt: DbTimestamp,
    ) =>
      updateClaim("completeMemoryProviderOutbox", claim, {
        provider_applied_at: appliedAt,
        usage_json: encodeUsage(usage),
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

  const hasRetryableWork = execute("inspectMemoryProviderOutbox", () => {
    const rows = db
      .select({
        orderingKey: memoryProviderOutbox.ordering_key,
        status: memoryProviderOutbox.status,
      })
      .from(memoryProviderOutbox)
      .where(ne(memoryProviderOutbox.status, "completed"))
      .orderBy(asc(memoryProviderOutbox.sequence))
      .all();
    const visitedOrderingKeys = new Set<string>();
    return rows.some((row) => {
      if (visitedOrderingKeys.has(row.orderingKey)) return false;
      visitedOrderingKeys.add(row.orderingKey);
      return row.status === "pending" || row.status === "claimed";
    });
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
    complete,
    enqueueDeletion,
    hasRetryableWork,
    markProviderApplied,
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
  if ((row.provider_applied_at === null) !== (usage === null)) return yield* invalidRecord();
  if (
    payload._tag === "SaveConversation" &&
    (row.operation_type !== "saveConversation" ||
      row.allowance_period_id !== payload.projection.allowancePeriodId)
  ) {
    return yield* invalidRecord();
  }
  if (
    payload._tag !== "SaveConversation" &&
    (row.operation_type !== operationType(payload) || row.allowance_period_id !== null)
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
    providerApplied: row.provider_applied_at !== null,
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
    | "enqueueMemoryProviderOutbox" = "claimMemoryProviderOutbox",
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

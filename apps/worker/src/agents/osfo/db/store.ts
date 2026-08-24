import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, max, ne, sql } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";

import { DbTimestamp } from "../../../db";
import {
  CurrentSessionReplaced,
  CurrentSessionReplacementConflict,
} from "../../../services/session-replacement";
import {
  SessionRecallCursor,
  SessionRecallCursorInvalid,
  type SessionRecallCandidate,
} from "../../../services/session-recall";
import {
  AgentId,
  AgentInitializationId,
  AssistantMessageId,
  ConversationRouteId,
  SessionId,
  ThinkRequestId,
} from "../../../domain";
import type { AgentDb } from "./client";
import {
  AgentInitializationConflict,
  AgentStateNotFound,
  type AgentStoreOperation,
  AgentStoreRecordInvalid,
  AgentStoreUnavailable,
  CommittedTurnConflict,
} from "./errors";
import {
  agentInitialization,
  committedTurns,
  conversationRoutes,
  memoryProviderOutbox,
  sessionRecallCursors,
  sessionOwnership,
} from "./schema";
import type { ConversationSnapshotProjection } from "../memory-provider-projection";
import {
  enqueueConversationSnapshotTransaction,
  enqueueMemoryProviderDeletionTransaction,
  inspectConversationSnapshotTransaction,
  type MemoryProviderOutboxId,
  type MemoryProviderDeletionPayload,
} from "./memory-provider-outbox";
import type { UserId } from "../../../domain";
import type { DeletionAuthorization } from "../deletion-actions";

const sqliteCurrentTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

interface ReplaceCurrentSessionRecordInput {
  readonly expectedCurrentSessionId: SessionId;
  readonly replacedAt: DbTimestamp;
  readonly replacementSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

interface DeleteHistoricalSessionInput {
  readonly authorization?: DeletionAuthorization;
  readonly deletedAt: DbTimestamp;
  readonly outboxId: MemoryProviderOutboxId;
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

type AgentTransaction = Parameters<Parameters<AgentDb["transaction"]>[0]>[0];

const replaceCurrentSessionTransaction = (
  transaction: AgentTransaction,
  input: ReplaceCurrentSessionRecordInput,
) => {
  const current = transaction
    .select({ sessionId: sessionOwnership.session_id })
    .from(sessionOwnership)
    .where(and(eq(sessionOwnership.route_id, input.routeId), isNull(sessionOwnership.replaced_at)))
    .limit(1)
    .get();
  if (current?.sessionId !== input.expectedCurrentSessionId) {
    return { actualCurrentSessionId: current?.sessionId ?? null, kind: "Stale" as const };
  }
  const replacementOwner = transaction
    .select({ routeId: sessionOwnership.route_id })
    .from(sessionOwnership)
    .where(eq(sessionOwnership.session_id, input.replacementSessionId))
    .limit(1)
    .get();
  if (replacementOwner !== undefined) {
    return {
      actualCurrentSessionId: current.sessionId,
      kind: "Owned" as const,
      replacementOwnerRouteId: replacementOwner.routeId,
    };
  }
  const maximumOwnershipSequence =
    transaction
      .select({ value: max(sessionOwnership.ownership_sequence) })
      .from(sessionOwnership)
      .get()?.value ?? 0;
  const updated = transaction
    .update(sessionOwnership)
    .set({ replaced_at: input.replacedAt })
    .where(
      and(
        eq(sessionOwnership.route_id, input.routeId),
        eq(sessionOwnership.session_id, input.expectedCurrentSessionId),
        isNull(sessionOwnership.replaced_at),
      ),
    )
    .returning({ sessionId: sessionOwnership.session_id })
    .all();
  if (updated.length !== 1) {
    return { actualCurrentSessionId: current.sessionId, kind: "Stale" as const };
  }
  transaction
    .insert(sessionOwnership)
    .values({
      became_current_at: input.replacedAt,
      ownership_sequence: maximumOwnershipSequence + 1,
      replaced_at: null,
      route_id: input.routeId,
      session_id: input.replacementSessionId,
    })
    .run();
  return { kind: "Replaced" as const };
};

type ReplaceCurrentSessionOutcome = ReturnType<typeof replaceCurrentSessionTransaction>;
type ReplacementConflictOutcome = Exclude<
  ReplaceCurrentSessionOutcome,
  { readonly kind: "Replaced" }
>;

const isReplacementConflict = (outcome: {
  readonly kind: string;
}): outcome is ReplacementConflictOutcome => outcome.kind === "Stale" || outcome.kind === "Owned";

const replacementConflict = (
  outcome: ReplacementConflictOutcome,
  input: ReplaceCurrentSessionRecordInput,
): CurrentSessionReplacementConflict => {
  if (outcome.kind === "Stale") {
    return new CurrentSessionReplacementConflict({
      actualCurrentSessionId: outcome.actualCurrentSessionId,
      expectedCurrentSessionId: input.expectedCurrentSessionId,
      message: "The route's current Session does not match the replacement request",
      replacementOwnerRouteId: null,
      replacementSessionId: input.replacementSessionId,
      routeId: input.routeId,
    });
  }
  return new CurrentSessionReplacementConflict({
    actualCurrentSessionId: outcome.actualCurrentSessionId,
    expectedCurrentSessionId: input.expectedCurrentSessionId,
    message: "The replacement Session is already owned by an Agent route",
    replacementOwnerRouteId: outcome.replacementOwnerRouteId,
    replacementSessionId: input.replacementSessionId,
    routeId: input.routeId,
  });
};

/** Stable facts accepted at the Agent initialization RPC boundary. */
export const AgentInitializationInput = Schema.Struct({
  agentId: AgentId,
  initializationId: AgentInitializationId,
  initializedAt: DbTimestamp,
  routeId: ConversationRouteId,
  sessionId: SessionId,
});

/** Parsed stable facts required to initialize one named Osfo Agent. */
export type AgentInitializationInput = typeof AgentInitializationInput.Type;

/** RPC representation of stable Agent initialization facts. */
export type AgentInitializationEncoded = typeof AgentInitializationInput.Encoded;

/** Successful initialization of one named Agent and its primary Session route. */
export const AgentInitialized = Schema.TaggedStruct("AgentInitialized", {
  agentId: AgentId,
  currentSessionId: SessionId,
  routeId: ConversationRouteId,
});

/** Successful initialization of one named Agent and its primary Session route. */
export type AgentInitialized = typeof AgentInitialized.Type;

/** Existing stable facts for one named Agent and its primary Session route. */
export const AgentFound = Schema.TaggedStruct("AgentFound", {
  agentId: AgentId,
  currentSessionId: SessionId,
  routeId: ConversationRouteId,
});

/** Existing stable facts for one named Agent and its primary Session route. */
export type AgentFound = typeof AgentFound.Type;

/** Current and historical Think Session identities owned by one route. */
export const ConversationRouteFound = Schema.TaggedStruct("ConversationRouteFound", {
  currentSessionId: SessionId,
  historicalSessionIds: Schema.Array(SessionId),
  routeId: ConversationRouteId,
});

/** Current and historical Think Session identities owned by one route. */
export type ConversationRouteFound = typeof ConversationRouteFound.Type;

/** Stable observation accepted after a committed Think turn. */
export const CommittedTurnObservation = Schema.Struct({
  assistantMessageId: AssistantMessageId,
  sessionId: SessionId,
  source: Schema.Literals(["hook", "reconciliation"]),
  thinkRequestId: Schema.NullOr(ThinkRequestId),
});

/** Stable observation accepted after a committed Think turn. */
export type CommittedTurnObservation = typeof CommittedTurnObservation.Type;

const CommittedTurnObservedAt = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (sqliteCurrentTimestamp.test(value) &&
        Option.isSome(DateTime.make(`${value.replace(" ", "T")}Z`))) ||
      "must be a valid SQLite CURRENT_TIMESTAMP value",
  ),
).pipe(Schema.brand("CommittedTurnObservedAt"));

/** Durable Osfo receipt for one observed committed Think turn. */
export const CommittedTurnReceipt = Schema.Struct({
  ...CommittedTurnObservation.fields,
  observationSequence: Schema.Natural,
  observedAt: CommittedTurnObservedAt,
});

/** Durable Osfo receipt for one observed committed Think turn. */
export type CommittedTurnReceipt = typeof CommittedTurnReceipt.Type;

const AgentInitializationRecord = Schema.Struct({
  agentId: AgentId,
  initializationId: AgentInitializationId,
  initializedAt: DbTimestamp,
  initialRouteId: ConversationRouteId,
  initialSessionId: SessionId,
});

const PrimaryFactsRecord = Schema.Struct({
  agentId: AgentId,
  routeId: ConversationRouteId,
  sessionId: SessionId,
});

const RouteSessionRecord = Schema.Struct({
  replacedAt: Schema.NullOr(DbTimestamp),
  sessionId: SessionId,
});

const SessionIdRecord = Schema.Struct({ sessionId: SessionId });
const RouteSessionPageRecord = Schema.Struct({
  ownershipSequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: SessionId,
});
type RouteSessionPageRecord = typeof RouteSessionPageRecord.Type;
interface RouteSessionPageDatabaseRecord {
  readonly ownershipSequence: number | null;
  readonly sessionId: SessionId;
}
const SessionRecallCursorStateRecord = Schema.Struct({
  afterOwnershipSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  snapshotCurrentSessionId: SessionId,
  snapshotMaxOwnershipSequence: Schema.Int.check(Schema.isGreaterThan(0)),
});
type SessionRecallCursorStateRecord = typeof SessionRecallCursorStateRecord.Type;
/** Construct deep Agent-local persistence operations over a typed Durable SQLite client. */
export const makeAgentStore = (db: AgentDb) => {
  const initialize = (namedAgentId: AgentId, input: AgentInitializationInput) =>
    Effect.gen(function* () {
      if (input.agentId !== namedAgentId) {
        return yield* new AgentInitializationConflict({
          existingAgentId: null,
          existingInitializationId: null,
          existingInitializedAt: null,
          existingRouteId: null,
          existingSessionId: null,
          message: "The AgentId does not match the named Durable Object",
          namedAgentId,
          requestedAgentId: input.agentId,
          requestedInitializationId: input.initializationId,
          requestedInitializedAt: input.initializedAt,
          requestedRouteId: input.routeId,
          requestedSessionId: input.sessionId,
        });
      }
      const existingInitializationRow = yield* execute("initialize", () =>
        db.select(agentInitializationRecordFields).from(agentInitialization).limit(1).get(),
      );
      if (existingInitializationRow !== undefined) {
        const existing = yield* decodeAgentInitializationRecord(
          "initialize",
          existingInitializationRow,
        );
        if (
          existing.agentId !== input.agentId ||
          existing.initializationId !== input.initializationId ||
          existing.initializedAt !== input.initializedAt ||
          existing.initialRouteId !== input.routeId ||
          existing.initialSessionId !== input.sessionId
        ) {
          return yield* new AgentInitializationConflict({
            existingAgentId: existing.agentId,
            existingInitializationId: existing.initializationId,
            existingInitializedAt: existing.initializedAt,
            existingRouteId: existing.initialRouteId,
            existingSessionId: existing.initialSessionId,
            message: "The named Agent is already initialized with different stable facts",
            namedAgentId,
            requestedAgentId: input.agentId,
            requestedInitializationId: input.initializationId,
            requestedInitializedAt: input.initializedAt,
            requestedRouteId: input.routeId,
            requestedSessionId: input.sessionId,
          });
        }
        const current = yield* readPrimaryFacts("initialize");
        return AgentInitialized.make({
          agentId: existing.agentId,
          currentSessionId: current.sessionId,
          routeId: current.routeId,
        });
      }

      yield* execute("initialize", () =>
        // The Durable SQLite driver implements this Drizzle transaction with transactionSync.
        db.transaction((transaction) => {
          transaction
            .insert(conversationRoutes)
            .values({ is_primary: true, route_id: input.routeId })
            .run();
          transaction
            .insert(sessionOwnership)
            .values({
              became_current_at: input.initializedAt,
              ownership_sequence: 1,
              replaced_at: null,
              route_id: input.routeId,
              session_id: input.sessionId,
            })
            .run();
          transaction
            .insert(agentInitialization)
            .values({
              agent_id: input.agentId,
              initialization_id: input.initializationId,
              initialized_at: input.initializedAt,
              initial_route_id: input.routeId,
              initial_session_id: input.sessionId,
              singleton_key: "agent",
            })
            .run();
        }),
      );
      return AgentInitialized.make({
        agentId: input.agentId,
        currentSessionId: input.sessionId,
        routeId: input.routeId,
      });
    });

  const inspect = Effect.fn("AgentStore.inspect")(function* () {
    const facts = yield* readPrimaryFacts("inspect");
    return AgentFound.make({
      agentId: facts.agentId,
      currentSessionId: facts.sessionId,
      routeId: facts.routeId,
    });
  });

  const readPrimarySessionId = Effect.fn("AgentStore.readPrimarySessionId")(function* () {
    const facts = yield* readPrimaryFacts("readSessionOwnership");
    return facts.sessionId;
  });

  const readRoute = Effect.fn("AgentStore.readRoute")(function* (routeId: ConversationRouteId) {
    const sessions = yield* readRouteSessions(routeId, "readRoute");
    const current = sessions.find(({ replacedAt }) => replacedAt === null);
    if (current === undefined) {
      return yield* new AgentStateNotFound({
        message: "The conversation route does not have a current Session",
        subject: "route",
      });
    }
    return ConversationRouteFound.make({
      currentSessionId: current.sessionId,
      historicalSessionIds: sessions
        .filter(({ replacedAt }) => replacedAt !== null)
        .map(({ sessionId }) => sessionId),
      routeId,
    });
  });

  const readRouteSessionPage = Effect.fn("AgentStore.readRouteSessionPage")(function* (
    routeId: ConversationRouteId,
    cursor: SessionRecallCursor | null,
    limit: number,
  ) {
    const rawPage = yield* execute("readRouteSessionPage", () =>
      db.transaction((transaction) => {
        const expiredCursors = transaction
          .select({
            cursor: sessionRecallCursors.cursor,
            expired: sql<number>`${sessionRecallCursors.expires_at} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          })
          .from(sessionRecallCursors)
          .orderBy(asc(sessionRecallCursors.expires_at))
          .limit(40)
          .all()
          .filter(({ expired }) => expired === 1);
        if (expiredCursors.length > 0) {
          transaction
            .delete(sessionRecallCursors)
            .where(
              inArray(
                sessionRecallCursors.cursor,
                expiredCursors.map(({ cursor: expiredCursor }) => expiredCursor),
              ),
            )
            .run();
        }
        const rawState =
          cursor === null
            ? (() => {
                const current = transaction
                  .select({
                    ownershipSequence: sessionOwnership.ownership_sequence,
                    sessionId: sessionOwnership.session_id,
                  })
                  .from(sessionOwnership)
                  .where(
                    and(
                      eq(sessionOwnership.route_id, routeId),
                      isNull(sessionOwnership.replaced_at),
                    ),
                  )
                  .limit(1)
                  .get();
                const maximum = transaction
                  .select({
                    snapshotMaxOwnershipSequence: max(sessionOwnership.ownership_sequence),
                  })
                  .from(sessionOwnership)
                  .where(eq(sessionOwnership.route_id, routeId))
                  .get();
                return current === undefined || maximum?.snapshotMaxOwnershipSequence == null
                  ? undefined
                  : {
                      afterOwnershipSequence: null,
                      snapshotCurrentSessionId: current.sessionId,
                      snapshotMaxOwnershipSequence: maximum.snapshotMaxOwnershipSequence,
                    };
              })()
            : transaction
                .select({
                  afterOwnershipSequence: sessionRecallCursors.after_ownership_sequence,
                  snapshotCurrentSessionId: sessionRecallCursors.snapshot_current_session_id,
                  snapshotMaxOwnershipSequence:
                    sessionRecallCursors.snapshot_max_ownership_sequence,
                })
                .from(sessionRecallCursors)
                .where(
                  and(
                    eq(sessionRecallCursors.cursor, cursor),
                    eq(sessionRecallCursors.route_id, routeId),
                    gt(sessionRecallCursors.expires_at, sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`),
                  ),
                )
                .limit(1)
                .get();
        if (rawState === undefined) return undefined;

        const historicalLimit = cursor === null ? Math.max(0, limit - 1) : limit;
        const historicalRows = transaction
          .select({
            ownershipSequence: sessionOwnership.ownership_sequence,
            sessionId: sessionOwnership.session_id,
          })
          .from(sessionOwnership)
          .where(
            and(
              eq(sessionOwnership.route_id, routeId),
              isNotNull(sessionOwnership.replaced_at),
              ne(sessionOwnership.session_id, rawState.snapshotCurrentSessionId),
              lte(
                sessionOwnership.ownership_sequence,
                rawState.afterOwnershipSequence === null
                  ? (rawState.snapshotMaxOwnershipSequence ?? 0)
                  : rawState.afterOwnershipSequence - 1,
              ),
            ),
          )
          .orderBy(desc(sessionOwnership.ownership_sequence))
          .limit(historicalLimit + 1)
          .all();
        return { historicalLimit, historicalRows, rawState };
      }),
    );
    if (rawPage === undefined) {
      if (cursor !== null) return yield* invalidSessionRecallCursor(cursor);
      return yield* new AgentStateNotFound({
        message: "The conversation route does not have a current Session",
        subject: "route",
      });
    }
    const state = yield* decodeSessionRecallCursorState(rawPage.rawState);
    const historicalSessionRecords = yield* Effect.forEach(
      rawPage.historicalRows.slice(0, rawPage.historicalLimit),
      (row) => decodeRouteSessionPageRecord("readRouteSessionPage", row),
    );
    const candidateStates = [
      ...(cursor === null
        ? [{ afterOwnershipSequence: null, sessionId: state.snapshotCurrentSessionId }]
        : []),
      ...historicalSessionRecords.map((record) => ({
        afterOwnershipSequence: record.ownershipSequence,
        sessionId: record.sessionId,
      })),
    ];
    const candidates = yield* Effect.forEach(
      candidateStates,
      ({ afterOwnershipSequence, sessionId }) =>
        Schema.decodeEffect(SessionRecallCursor)(
          // A continuation is a bearer credential and needs cryptographic entropy.
          // oxlint-disable-next-line effecttsgo/crypto-random-uuid
          crypto.randomUUID(),
        ).pipe(
          Effect.mapError(() => invalidStoreRecord("readRouteSessionPage")),
          Effect.map(
            (
              candidateCursor,
            ): SessionRecallCandidate & { readonly afterOwnershipSequence: number | null } => ({
              afterOwnershipSequence,
              cursor: candidateCursor,
              sessionId,
            }),
          ),
        ),
    );
    yield* execute("readRouteSessionPage", () => {
      if (candidates.length === 0) return undefined;
      return db
        .insert(sessionRecallCursors)
        .values(
          candidates.map((candidate) => ({
            after_ownership_sequence: candidate.afterOwnershipSequence,
            cursor: candidate.cursor,
            route_id: routeId,
            snapshot_current_session_id: state.snapshotCurrentSessionId,
            snapshot_max_ownership_sequence: state.snapshotMaxOwnershipSequence,
          })),
        )
        .run();
    });
    return {
      candidates: candidates.map(({ cursor: candidateCursor, sessionId }) => ({
        cursor: candidateCursor,
        sessionId,
      })),
      currentSessionId: state.snapshotCurrentSessionId,
      hasMore: rawPage.historicalRows.length > rawPage.historicalLimit,
      routeId,
    } as const;
  });

  const replaceCurrentSession = Effect.fn("AgentStore.replaceCurrentSession")(function* (
    input: ReplaceCurrentSessionRecordInput,
  ) {
    const outcome = yield* execute("replaceCurrentSession", () =>
      // The Durable SQLite driver implements this exact compare-and-replace with transactionSync.
      db.transaction((transaction) => {
        const current = transaction
          .select({ sessionId: sessionOwnership.session_id })
          .from(sessionOwnership)
          .where(
            and(eq(sessionOwnership.route_id, input.routeId), isNull(sessionOwnership.replaced_at)),
          )
          .limit(1)
          .get();
        const historical = transaction
          .select({ replacedAt: sessionOwnership.replaced_at })
          .from(sessionOwnership)
          .where(
            and(
              eq(sessionOwnership.route_id, input.routeId),
              eq(sessionOwnership.session_id, input.expectedCurrentSessionId),
              isNotNull(sessionOwnership.replaced_at),
            ),
          )
          .limit(1)
          .get();
        if (
          current?.sessionId === input.replacementSessionId &&
          historical?.replacedAt === input.replacedAt
        ) {
          return { kind: "Replaced" } as const;
        }
        return replaceCurrentSessionTransaction(transaction, input);
      }),
    );
    if (isReplacementConflict(outcome)) return yield* replacementConflict(outcome, input);
    return CurrentSessionReplaced.make({
      currentSessionId: input.replacementSessionId,
      historicalSessionId: input.expectedCurrentSessionId,
      routeId: input.routeId,
    });
  });

  const ownsSession = (sessionId: SessionId) =>
    execute("readSessionOwnership", () =>
      db
        .select({ sessionId: sessionOwnership.session_id })
        .from(sessionOwnership)
        .where(eq(sessionOwnership.session_id, sessionId))
        .limit(1)
        .get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined
          ? Effect.succeed(false)
          : decodeSessionId("readSessionOwnership", row).pipe(Effect.as(true)),
      ),
    );

  const readSessionIds = execute("readSessionOwnership", () =>
    db
      .select({ sessionId: sessionOwnership.session_id })
      .from(sessionOwnership)
      // julianday keeps valid ISO timestamps chronological across fractional precision variants.
      .orderBy(
        asc(sql`julianday(${sessionOwnership.became_current_at})`),
        asc(sessionOwnership.session_id),
      )
      .all(),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeSessionId("readSessionOwnership", row)),
    ),
    Effect.map((rows) => rows.map(({ sessionId }) => sessionId)),
  );

  const recordCommittedTurn = Effect.fn("AgentStore.recordCommittedTurn")(function* (
    reference: CommittedTurnObservation,
    projection?: ConversationSnapshotProjection,
  ) {
    const enqueuedAt = yield* DateTime.now.pipe(
      Effect.map((time) => DbTimestamp.make(DateTime.toDateUtc(time).toISOString())),
    );
    const outcome = yield* execute("recordCommittedTurn", () =>
      // The Durable SQLite driver implements this exact local transaction with transactionSync.
      db.transaction((transaction) =>
        recordCommittedTurnTransaction(transaction, { enqueuedAt, projection, reference }),
      ),
    );
    return yield* decodeRecordCommittedTurnOutcome(reference, outcome);
  });

  const readCommittedTurns = execute("readCommittedTurns", () =>
    db
      .select(committedTurnReceiptFields)
      .from(committedTurns)
      .orderBy(asc(committedTurns.observation_sequence))
      .all(),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeCommittedTurnReceipt("readCommittedTurns", row)),
    ),
  );

  const deleteHistoricalSession = Effect.fn("AgentStore.deleteHistoricalSession")(function* (
    input: DeleteHistoricalSessionInput,
  ) {
    const outcome = yield* execute("deleteSession", () =>
      db.transaction((transaction) => {
        const owned = transaction
          .select({ replacedAt: sessionOwnership.replaced_at })
          .from(sessionOwnership)
          .where(eq(sessionOwnership.session_id, input.sessionId))
          .limit(1)
          .get();
        if (owned === undefined) {
          return enqueueMemoryProviderDeletionTransaction(transaction, {
            enqueuedAt: input.deletedAt,
            outboxId: input.outboxId,
            payload: deleteSessionPayload(input),
          })
            ? "AlreadyDeleted"
            : "Invalid";
        }
        if (owned.replacedAt === null) return "Current";
        const current = transaction
          .select({ sessionId: sessionOwnership.session_id })
          .from(sessionOwnership)
          .where(isNull(sessionOwnership.replaced_at))
          .limit(1)
          .get();
        if (current === undefined) return "Invalid";
        transaction
          .update(agentInitialization)
          .set({ initial_session_id: current.sessionId })
          .where(eq(agentInitialization.initial_session_id, input.sessionId))
          .run();
        transaction
          .delete(committedTurns)
          .where(eq(committedTurns.session_id, input.sessionId))
          .run();
        transaction
          .update(memoryProviderOutbox)
          .set({
            claim_expires_at: null,
            claim_token: null,
            completed_at: input.deletedAt,
            last_error: null,
            status: "completed",
          })
          .where(
            and(
              eq(memoryProviderOutbox.operation_type, "saveConversation"),
              inArray(memoryProviderOutbox.status, ["failed", "pending"]),
              sql`json_extract(${memoryProviderOutbox.payload_json}, '$.projection.sessionId') = ${input.sessionId}`,
            ),
          )
          .run();
        transaction
          .delete(sessionOwnership)
          .where(eq(sessionOwnership.session_id, input.sessionId))
          .run();
        return enqueueMemoryProviderDeletionTransaction(transaction, {
          enqueuedAt: input.deletedAt,
          outboxId: input.outboxId,
          payload: deleteSessionPayload(input),
        })
          ? "Deleted"
          : "Invalid";
      }),
    );
    if (outcome === "Current") {
      return yield* new AgentStoreRecordInvalid({
        message: "The current Session must be replaced before deletion",
        operation: "deleteSession",
      });
    }
    if (outcome === "Invalid") return yield* invalidStoreRecord("deleteSession");
    return { _tag: "SessionDeleted", sessionId: input.sessionId } as const;
  });

  const readPrimaryFacts = (operation: AgentStoreOperation) =>
    Effect.gen(function* () {
      const facts = yield* execute(operation, () =>
        db
          .select({
            agentId: agentInitialization.agent_id,
            routeId: conversationRoutes.route_id,
            sessionId: sessionOwnership.session_id,
          })
          .from(agentInitialization)
          .innerJoin(conversationRoutes, eq(conversationRoutes.is_primary, true))
          .innerJoin(
            sessionOwnership,
            and(
              eq(sessionOwnership.route_id, conversationRoutes.route_id),
              isNull(sessionOwnership.replaced_at),
            ),
          )
          .limit(1)
          .get(),
      );
      if (facts === undefined) {
        return yield* new AgentStateNotFound({
          message: "The named Agent is not initialized",
          subject: "agent",
        });
      }
      return yield* decodePrimaryFacts(operation, facts);
    });

  const readRouteSessions = (routeId: ConversationRouteId, operation: AgentStoreOperation) =>
    Effect.gen(function* () {
      const rows = yield* execute(operation, () =>
        db
          .select({
            replacedAt: sessionOwnership.replaced_at,
            sessionId: sessionOwnership.session_id,
          })
          .from(sessionOwnership)
          .where(eq(sessionOwnership.route_id, routeId))
          .orderBy(asc(sessionOwnership.ownership_sequence))
          .all(),
      );
      if (rows.length === 0) {
        return yield* new AgentStateNotFound({
          message: "The conversation route does not exist",
          subject: "route",
        });
      }
      return yield* Effect.forEach(rows, (row) => decodeRouteSession(operation, row));
    });

  return {
    deleteHistoricalSession,
    initialize,
    inspect,
    ownsSession,
    readCommittedTurns,
    readPrimarySessionId,
    readRoute,
    readRouteSessionPage,
    readSessionIds,
    recordCommittedTurn,
    replaceCurrentSession,
  };
};

const deleteSessionPayload = (
  input: DeleteHistoricalSessionInput,
): MemoryProviderDeletionPayload => {
  const payload = {
    _tag: "DeleteSessionConversation" as const,
    sessionId: input.sessionId,
    userId: input.userId,
  };
  if (input.authorization === undefined) return payload;
  return { ...payload, authorization: input.authorization };
};

interface RecordCommittedTurnTransactionInput {
  readonly enqueuedAt: DbTimestamp;
  readonly projection: ConversationSnapshotProjection | undefined;
  readonly reference: CommittedTurnObservation;
}

type SnapshotReceiptPolicy = "acceptExisting" | "requireMissing";

const recordCommittedTurnTransaction = (
  transaction: AgentTransaction,
  input: RecordCommittedTurnTransactionInput,
) => {
  const { enqueuedAt, projection, reference } = input;
  if (
    projection !== undefined &&
    (projection.lastMessageId !== reference.assistantMessageId ||
      projection.sessionId !== reference.sessionId)
  ) {
    return { _tag: "InvalidRecord" } as const;
  }
  const snapshotState =
    projection === undefined
      ? "missing"
      : inspectConversationSnapshotTransaction(transaction, projection);
  if (snapshotState === "conflict") return { _tag: "InvalidRecord" } as const;

  const persistSnapshotWithReceipt = (
    receipt: CommittedTurnRecord,
    policy: SnapshotReceiptPolicy,
  ) => {
    if (projection !== undefined) {
      if (snapshotState === "existing" && policy === "requireMissing") {
        return { _tag: "InvalidRecord" } as const;
      }
      if (
        snapshotState === "missing" &&
        !enqueueConversationSnapshotTransaction(transaction, projection, enqueuedAt)
      ) {
        return { _tag: "InvalidRecord" } as const;
      }
    }
    return { _tag: "Receipt", receipt } as const;
  };
  const findByThinkRequestId = (thinkRequestId: ThinkRequestId) =>
    decodeCommittedTurnRecord(
      transaction
        .select(committedTurnReceiptFields)
        .from(committedTurns)
        .where(eq(committedTurns.think_request_id, thinkRequestId))
        .limit(1)
        .get(),
    );
  const matchingMessage = decodeCommittedTurnRecord(
    transaction
      .select(committedTurnReceiptFields)
      .from(committedTurns)
      .where(eq(committedTurns.assistant_message_id, reference.assistantMessageId))
      .limit(1)
      .get(),
  );
  if (matchingMessage === invalidCommittedTurnRecord) {
    return { _tag: "InvalidRecord" } as const;
  }
  if (matchingMessage !== undefined) {
    if (matchingMessage.sessionId !== reference.sessionId) {
      return {
        _tag: "Conflict",
        existing: matchingMessage,
        message: "The assistant message is already observed for another Session",
      } as const;
    }
    if (
      matchingMessage.thinkRequestId !== null &&
      reference.thinkRequestId !== null &&
      matchingMessage.thinkRequestId !== reference.thinkRequestId
    ) {
      return {
        _tag: "Conflict",
        existing: matchingMessage,
        message: "The assistant message is already observed for another Think request",
      } as const;
    }
    if (matchingMessage.thinkRequestId === null && reference.thinkRequestId !== null) {
      const matchingRequest = findByThinkRequestId(reference.thinkRequestId);
      if (matchingRequest === invalidCommittedTurnRecord) {
        return { _tag: "InvalidRecord" } as const;
      }
      if (matchingRequest !== undefined) {
        return {
          _tag: "Conflict",
          existing: matchingRequest,
          message: "The Think request is already observed for another assistant message",
        } as const;
      }
      const enriched = transaction
        .update(committedTurns)
        .set({ source: reference.source, think_request_id: reference.thinkRequestId })
        .where(eq(committedTurns.observation_sequence, matchingMessage.observationSequence))
        .returning(committedTurnReceiptFields)
        .get();
      return enriched === undefined
        ? ({ _tag: "InvalidRecord" } as const)
        : persistSnapshotWithReceipt(enriched, "acceptExisting");
    }
    return persistSnapshotWithReceipt(matchingMessage, "acceptExisting");
  }

  if (reference.thinkRequestId !== null) {
    const matchingRequest = findByThinkRequestId(reference.thinkRequestId);
    if (matchingRequest === invalidCommittedTurnRecord) {
      return { _tag: "InvalidRecord" } as const;
    }
    if (matchingRequest !== undefined) {
      return {
        _tag: "Conflict",
        existing: matchingRequest,
        message: "The Think request is already observed for another assistant message",
      } as const;
    }
  }
  if (snapshotState === "existing") return { _tag: "InvalidRecord" } as const;
  const inserted = transaction
    .insert(committedTurns)
    .values({
      assistant_message_id: reference.assistantMessageId,
      session_id: reference.sessionId,
      source: reference.source,
      think_request_id: reference.thinkRequestId,
    })
    .returning(committedTurnReceiptFields)
    .get();
  return inserted === undefined
    ? ({ _tag: "InvalidRecord" } as const)
    : persistSnapshotWithReceipt(inserted, "requireMissing");
};

type RecordCommittedTurnOutcome = ReturnType<typeof recordCommittedTurnTransaction>;

const decodeRecordCommittedTurnOutcome = (
  reference: CommittedTurnObservation,
  outcome: RecordCommittedTurnOutcome,
) => {
  if (outcome["_tag"] === "InvalidRecord") {
    return Effect.fail(invalidStoreRecord("recordCommittedTurn"));
  }
  if (outcome["_tag"] === "Conflict") {
    return Effect.fail(
      new CommittedTurnConflict({
        assistantMessageId: reference.assistantMessageId,
        existingAssistantMessageId: outcome.existing.assistantMessageId,
        existingSessionId: outcome.existing.sessionId,
        existingThinkRequestId: outcome.existing.thinkRequestId,
        message: outcome.message,
        sessionId: reference.sessionId,
        thinkRequestId: reference.thinkRequestId,
      }),
    );
  }
  return decodeCommittedTurnReceipt("recordCommittedTurn", outcome.receipt);
};

const committedTurnReceiptFields = {
  assistantMessageId: committedTurns.assistant_message_id,
  observationSequence: committedTurns.observation_sequence,
  observedAt: committedTurns.observed_at,
  sessionId: committedTurns.session_id,
  source: committedTurns.source,
  thinkRequestId: committedTurns.think_request_id,
};

const agentInitializationRecordFields = {
  agentId: agentInitialization.agent_id,
  initializationId: agentInitialization.initialization_id,
  initializedAt: agentInitialization.initialized_at,
  initialRouteId: agentInitialization.initial_route_id,
  initialSessionId: agentInitialization.initial_session_id,
};

interface CommittedTurnRecord {
  readonly assistantMessageId: AssistantMessageId;
  readonly observationSequence: number;
  readonly observedAt: string;
  readonly sessionId: SessionId;
  readonly source: "hook" | "reconciliation";
  readonly thinkRequestId: ThinkRequestId | null;
}

const invalidCommittedTurnRecord: unique symbol = Symbol("invalidCommittedTurnRecord");

const decodeCommittedTurnRecord = (
  row: CommittedTurnRecord | undefined,
): CommittedTurnReceipt | typeof invalidCommittedTurnRecord | undefined => {
  if (row === undefined) return undefined;
  return Option.getOrElse(
    Schema.decodeOption(CommittedTurnReceipt)(row),
    () => invalidCommittedTurnRecord,
  );
};

const decodeCommittedTurnReceipt = (operation: AgentStoreOperation, row: CommittedTurnRecord) =>
  Schema.decodeEffect(CommittedTurnReceipt)(row).pipe(
    Effect.mapError(
      () =>
        new AgentStoreRecordInvalid({
          message: "Agent SQLite returned an invalid committed-turn receipt",
          operation,
        }),
    ),
  );

const decodeAgentInitializationRecord = (
  operation: AgentStoreOperation,
  row: typeof AgentInitializationRecord.Encoded,
): Effect.Effect<typeof AgentInitializationRecord.Type, AgentStoreRecordInvalid> =>
  Schema.decodeEffect(AgentInitializationRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord(operation)),
  );

const decodePrimaryFacts = (
  operation: AgentStoreOperation,
  row: typeof PrimaryFactsRecord.Encoded,
): Effect.Effect<typeof PrimaryFactsRecord.Type, AgentStoreRecordInvalid> =>
  Schema.decodeEffect(PrimaryFactsRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord(operation)),
  );

const decodeRouteSession = (
  operation: AgentStoreOperation,
  row: typeof RouteSessionRecord.Encoded,
): Effect.Effect<typeof RouteSessionRecord.Type, AgentStoreRecordInvalid> =>
  Schema.decodeEffect(RouteSessionRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord(operation)),
  );

const decodeSessionId = (
  operation: AgentStoreOperation,
  row: typeof SessionIdRecord.Encoded,
): Effect.Effect<typeof SessionIdRecord.Type, AgentStoreRecordInvalid> =>
  Schema.decodeEffect(SessionIdRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord(operation)),
  );

const decodeRouteSessionPageRecord = (
  operation: AgentStoreOperation,
  row: RouteSessionPageDatabaseRecord,
): Effect.Effect<RouteSessionPageRecord, AgentStoreRecordInvalid> =>
  Schema.decodeUnknownEffect(RouteSessionPageRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord(operation)),
  );

const decodeSessionRecallCursorState = (
  row: typeof SessionRecallCursorStateRecord.Encoded,
): Effect.Effect<SessionRecallCursorStateRecord, AgentStoreRecordInvalid> =>
  Schema.decodeEffect(SessionRecallCursorStateRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord("readRouteSessionPage")),
  );

const invalidSessionRecallCursor = (cursor: SessionRecallCursor) =>
  new SessionRecallCursorInvalid({
    cursor,
    message: "The Session Recall cursor is invalid",
  });

const invalidStoreRecord = (operation: AgentStoreOperation) =>
  new AgentStoreRecordInvalid({
    message: "Agent SQLite returned an invalid Osfo-owned record",
    operation,
  });

/** Translate only synchronous Drizzle dependency failures at the store seam. */
const execute = <A>(operation: AgentStoreOperation, query: () => A) =>
  Effect.try({
    try: query,
    catch: (cause) =>
      new AgentStoreUnavailable({
        cause,
        message: "Agent SQLite could not complete the Osfo store operation",
        operation,
      }),
  });

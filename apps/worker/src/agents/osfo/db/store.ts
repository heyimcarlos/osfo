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
  type ThinkRequestId as ThinkRequestIdType,
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
  sessionRecallCursors,
  sessionOwnership,
} from "./schema";

const sqliteCurrentTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

interface ReplaceCurrentSessionRecordInput {
  readonly expectedCurrentSessionId: SessionId;
  readonly replacedAt: DbTimestamp;
  readonly replacementSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

type AgentTransaction = Parameters<Parameters<AgentDb["transaction"]>[0]>[0];

const replaceCurrentSessionTransaction = (
  transaction: AgentTransaction,
  input: ReplaceCurrentSessionRecordInput,
) => {
  const current = transaction
    .select({ sessionId: sessionOwnership.sessionId })
    .from(sessionOwnership)
    .where(and(eq(sessionOwnership.routeId, input.routeId), isNull(sessionOwnership.replacedAt)))
    .limit(1)
    .get();
  if (current?.sessionId !== input.expectedCurrentSessionId) {
    return { actualCurrentSessionId: current?.sessionId ?? null, kind: "Stale" as const };
  }
  const replacementOwner = transaction
    .select({ routeId: sessionOwnership.routeId })
    .from(sessionOwnership)
    .where(eq(sessionOwnership.sessionId, input.replacementSessionId))
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
      .select({ value: max(sessionOwnership.ownershipSequence) })
      .from(sessionOwnership)
      .get()?.value ?? 0;
  const updated = transaction
    .update(sessionOwnership)
    .set({ replacedAt: input.replacedAt })
    .where(
      and(
        eq(sessionOwnership.routeId, input.routeId),
        eq(sessionOwnership.sessionId, input.expectedCurrentSessionId),
        isNull(sessionOwnership.replacedAt),
      ),
    )
    .returning({ sessionId: sessionOwnership.sessionId })
    .all();
  if (updated.length !== 1) {
    return { actualCurrentSessionId: current.sessionId, kind: "Stale" as const };
  }
  transaction
    .insert(sessionOwnership)
    .values({
      becameCurrentAt: input.replacedAt,
      ownershipSequence: maximumOwnershipSequence + 1,
      replacedAt: null,
      routeId: input.routeId,
      sessionId: input.replacementSessionId,
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
            .values({ isPrimary: true, routeId: input.routeId })
            .run();
          transaction
            .insert(sessionOwnership)
            .values({
              becameCurrentAt: input.initializedAt,
              ownershipSequence: 1,
              replacedAt: null,
              routeId: input.routeId,
              sessionId: input.sessionId,
            })
            .run();
          transaction
            .insert(agentInitialization)
            .values({
              agentId: input.agentId,
              initializationId: input.initializationId,
              initializedAt: input.initializedAt,
              initialRouteId: input.routeId,
              initialSessionId: input.sessionId,
              singletonKey: "agent",
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
            expired: sql<number>`${sessionRecallCursors.expiresAt} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          })
          .from(sessionRecallCursors)
          .orderBy(asc(sessionRecallCursors.expiresAt))
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
                    ownershipSequence: sessionOwnership.ownershipSequence,
                    sessionId: sessionOwnership.sessionId,
                  })
                  .from(sessionOwnership)
                  .where(
                    and(eq(sessionOwnership.routeId, routeId), isNull(sessionOwnership.replacedAt)),
                  )
                  .limit(1)
                  .get();
                const maximum = transaction
                  .select({
                    snapshotMaxOwnershipSequence: max(sessionOwnership.ownershipSequence),
                  })
                  .from(sessionOwnership)
                  .where(eq(sessionOwnership.routeId, routeId))
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
                  afterOwnershipSequence: sessionRecallCursors.afterOwnershipSequence,
                  snapshotCurrentSessionId: sessionRecallCursors.snapshotCurrentSessionId,
                  snapshotMaxOwnershipSequence: sessionRecallCursors.snapshotMaxOwnershipSequence,
                })
                .from(sessionRecallCursors)
                .where(
                  and(
                    eq(sessionRecallCursors.cursor, cursor),
                    eq(sessionRecallCursors.routeId, routeId),
                    gt(sessionRecallCursors.expiresAt, sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`),
                  ),
                )
                .limit(1)
                .get();
        if (rawState === undefined) return undefined;

        const historicalLimit = cursor === null ? Math.max(0, limit - 1) : limit;
        const historicalRows = transaction
          .select({
            ownershipSequence: sessionOwnership.ownershipSequence,
            sessionId: sessionOwnership.sessionId,
          })
          .from(sessionOwnership)
          .where(
            and(
              eq(sessionOwnership.routeId, routeId),
              isNotNull(sessionOwnership.replacedAt),
              ne(sessionOwnership.sessionId, rawState.snapshotCurrentSessionId),
              lte(
                sessionOwnership.ownershipSequence,
                rawState.afterOwnershipSequence === null
                  ? (rawState.snapshotMaxOwnershipSequence ?? 0)
                  : rawState.afterOwnershipSequence - 1,
              ),
            ),
          )
          .orderBy(desc(sessionOwnership.ownershipSequence))
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
            afterOwnershipSequence: candidate.afterOwnershipSequence,
            cursor: candidate.cursor,
            routeId,
            snapshotCurrentSessionId: state.snapshotCurrentSessionId,
            snapshotMaxOwnershipSequence: state.snapshotMaxOwnershipSequence,
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
          .select({ sessionId: sessionOwnership.sessionId })
          .from(sessionOwnership)
          .where(
            and(eq(sessionOwnership.routeId, input.routeId), isNull(sessionOwnership.replacedAt)),
          )
          .limit(1)
          .get();
        const historical = transaction
          .select({ replacedAt: sessionOwnership.replacedAt })
          .from(sessionOwnership)
          .where(
            and(
              eq(sessionOwnership.routeId, input.routeId),
              eq(sessionOwnership.sessionId, input.expectedCurrentSessionId),
              isNotNull(sessionOwnership.replacedAt),
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
        .select({ sessionId: sessionOwnership.sessionId })
        .from(sessionOwnership)
        .where(eq(sessionOwnership.sessionId, sessionId))
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
      .select({ sessionId: sessionOwnership.sessionId })
      .from(sessionOwnership)
      // julianday keeps valid ISO timestamps chronological across fractional precision variants.
      .orderBy(
        asc(sql`julianday(${sessionOwnership.becameCurrentAt})`),
        asc(sessionOwnership.sessionId),
      )
      .all(),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeSessionId("readSessionOwnership", row)),
    ),
    Effect.map((rows) => rows.map(({ sessionId }) => sessionId)),
  );

  const recordCommittedTurn = (reference: CommittedTurnObservation) =>
    Effect.gen(function* () {
      const outcome = yield* execute("recordCommittedTurn", () =>
        // The Durable SQLite driver implements this exact local transaction with transactionSync.
        db.transaction((transaction) => {
          const findByThinkRequestId = (thinkRequestId: ThinkRequestIdType) =>
            decodeCommittedTurnRecord(
              transaction
                .select(committedTurnReceiptFields)
                .from(committedTurns)
                .where(eq(committedTurns.thinkRequestId, thinkRequestId))
                .limit(1)
                .get(),
            );
          const matchingMessage = decodeCommittedTurnRecord(
            transaction
              .select(committedTurnReceiptFields)
              .from(committedTurns)
              .where(eq(committedTurns.assistantMessageId, reference.assistantMessageId))
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
                .set({ source: reference.source, thinkRequestId: reference.thinkRequestId })
                .where(eq(committedTurns.observationSequence, matchingMessage.observationSequence))
                .returning(committedTurnReceiptFields)
                .get();
              return { _tag: "Receipt", receipt: enriched } as const;
            }
            return { _tag: "Receipt", receipt: matchingMessage } as const;
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
          const inserted = transaction
            .insert(committedTurns)
            .values(reference)
            .returning(committedTurnReceiptFields)
            .get();
          return { _tag: "Receipt", receipt: inserted } as const;
        }),
      );
      if (outcome["_tag"] === "InvalidRecord") {
        return yield* invalidStoreRecord("recordCommittedTurn");
      }
      if (outcome["_tag"] === "Conflict") {
        return yield* new CommittedTurnConflict({
          assistantMessageId: reference.assistantMessageId,
          existingAssistantMessageId: outcome.existing.assistantMessageId,
          existingSessionId: outcome.existing.sessionId,
          existingThinkRequestId: outcome.existing.thinkRequestId,
          message: outcome.message,
          sessionId: reference.sessionId,
          thinkRequestId: reference.thinkRequestId,
        });
      }
      return yield* decodeCommittedTurnReceipt("recordCommittedTurn", outcome.receipt);
    });

  const readCommittedTurns = execute("readCommittedTurns", () =>
    db
      .select(committedTurnReceiptFields)
      .from(committedTurns)
      .orderBy(asc(committedTurns.observationSequence))
      .all(),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeCommittedTurnReceipt("readCommittedTurns", row)),
    ),
  );

  const readPrimaryFacts = (operation: AgentStoreOperation) =>
    Effect.gen(function* () {
      const facts = yield* execute(operation, () =>
        db
          .select({
            agentId: agentInitialization.agentId,
            routeId: conversationRoutes.routeId,
            sessionId: sessionOwnership.sessionId,
          })
          .from(agentInitialization)
          .innerJoin(conversationRoutes, eq(conversationRoutes.isPrimary, true))
          .innerJoin(
            sessionOwnership,
            and(
              eq(sessionOwnership.routeId, conversationRoutes.routeId),
              isNull(sessionOwnership.replacedAt),
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
            replacedAt: sessionOwnership.replacedAt,
            sessionId: sessionOwnership.sessionId,
          })
          .from(sessionOwnership)
          .where(eq(sessionOwnership.routeId, routeId))
          .orderBy(asc(sessionOwnership.ownershipSequence))
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

const committedTurnReceiptFields = {
  assistantMessageId: committedTurns.assistantMessageId,
  observationSequence: committedTurns.observationSequence,
  observedAt: committedTurns.observedAt,
  sessionId: committedTurns.sessionId,
  source: committedTurns.source,
  thinkRequestId: committedTurns.thinkRequestId,
};

const agentInitializationRecordFields = {
  agentId: agentInitialization.agentId,
  initializationId: agentInitialization.initializationId,
  initializedAt: agentInitialization.initializedAt,
  initialRouteId: agentInitialization.initialRouteId,
  initialSessionId: agentInitialization.initialSessionId,
};

type CommittedTurnRecord = typeof committedTurns.$inferSelect;

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

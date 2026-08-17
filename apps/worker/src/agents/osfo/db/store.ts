import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";

import { DbTimestamp } from "../../../db";
import {
  AgentId,
  AgentInitializationId,
  AssistantMessageId,
  type ChannelBindingId,
  ConversationRouteId,
  type ProviderMessageId,
  SessionId,
  ThinkRequestId,
  type ThinkRequestId as ThinkRequestIdType,
} from "../../../domain";
import {
  AcceptanceReceipt,
  type AcceptanceReceiptInput,
} from "../../../services/whatsapp-acceptance-receipt";
import type { AgentDb } from "./client";
import {
  AgentInitializationConflict,
  AcceptanceReceiptConflict,
  AgentStateNotFound,
  type AgentStoreOperation,
  AgentStoreRecordInvalid,
  AgentStoreUnavailable,
  CommittedTurnConflict,
  CurrentSessionReplacementConflict,
} from "./errors";
import {
  acceptanceReceipts,
  agentInitialization,
  committedTurns,
  conversationRoutes,
  sessionOwnership,
} from "./schema";

const sqliteCurrentTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

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

/** Stable input for replacing a route's current Session without deleting history. */
export const ReplaceCurrentSessionInput = Schema.Struct({
  expectedCurrentSessionId: SessionId,
  replacedAt: DbTimestamp,
  replacementSessionId: SessionId,
  routeId: ConversationRouteId,
});

/** Parsed input for replacing a route's current Session. */
export type ReplaceCurrentSessionInput = typeof ReplaceCurrentSessionInput.Type;

/** RPC representation of current Session replacement input. */
export type ReplaceCurrentSessionEncoded = typeof ReplaceCurrentSessionInput.Encoded;

/** Successful replacement of one route's current Session. */
export const CurrentSessionReplaced = Schema.TaggedStruct("CurrentSessionReplaced", {
  currentSessionId: SessionId,
  historicalSessionId: SessionId,
  routeId: ConversationRouteId,
});

/** Successful replacement of one route's current Session. */
export type CurrentSessionReplaced = typeof CurrentSessionReplaced.Type;

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
const RouteOwnerRecord = Schema.Struct({ routeId: ConversationRouteId });

/** Construct deep Agent-local persistence operations over a typed Durable SQLite client. */
export const makeAgentStore = (db: AgentDb) => {
  const readAcceptanceReceipt = (
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
  ) =>
    execute("readAcceptanceReceipt", () =>
      db
        .select(acceptanceReceiptFields)
        .from(acceptanceReceipts)
        .where(
          and(
            eq(acceptanceReceipts.channelBindingId, channelBindingId),
            eq(acceptanceReceipts.providerMessageId, providerMessageId),
          ),
        )
        .limit(1)
        .get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined
          ? Effect.succeed(null)
          : decodeAcceptanceReceipt("readAcceptanceReceipt", row),
      ),
    );

  const recordAcceptanceReceipt = (input: AcceptanceReceiptInput) =>
    Effect.gen(function* () {
      const existing = yield* readAcceptanceReceipt(
        input.channelBindingId,
        input.providerMessageId,
      );
      if (existing !== null) {
        if (
          existing.allowancePeriodId === input.allowancePeriodId &&
          existing.receiptId === input.receiptId &&
          existing.sessionId === input.sessionId &&
          existing.thinkSubmissionId === input.thinkSubmissionId &&
          existing.userMessageId === input.userMessageId
        ) {
          return existing;
        }
        return yield* new AcceptanceReceiptConflict({
          channelBindingId: input.channelBindingId,
          existingReceiptId: existing.receiptId,
          existingThinkSubmissionId: existing.thinkSubmissionId,
          existingUserMessageId: existing.userMessageId,
          message: "The Channel Message Key already has different acceptance facts",
          providerMessageId: input.providerMessageId,
          receiptId: input.receiptId,
          thinkSubmissionId: input.thinkSubmissionId,
          userMessageId: input.userMessageId,
        });
      }
      const inserted = yield* execute("recordAcceptanceReceipt", () =>
        db.insert(acceptanceReceipts).values(input).returning(acceptanceReceiptFields).get(),
      );
      return yield* decodeAcceptanceReceipt("recordAcceptanceReceipt", inserted);
    });

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

  const replaceCurrentSession = Effect.fn("AgentStore.replaceCurrentSession")(function* (
    input: ReplaceCurrentSessionInput,
  ) {
    const sessions = yield* readRouteSessions(input.routeId, "replaceCurrentSession");
    const current = sessions.find(({ replacedAt }) => replacedAt === null);
    const historical = sessions.find(
      ({ sessionId }) => sessionId === input.expectedCurrentSessionId,
    );
    if (
      current?.sessionId === input.replacementSessionId &&
      historical?.replacedAt === input.replacedAt
    ) {
      return CurrentSessionReplaced.make({
        currentSessionId: input.replacementSessionId,
        historicalSessionId: input.expectedCurrentSessionId,
        routeId: input.routeId,
      });
    }
    if (current?.sessionId !== input.expectedCurrentSessionId) {
      return yield* new CurrentSessionReplacementConflict({
        actualCurrentSessionId: current?.sessionId ?? null,
        expectedCurrentSessionId: input.expectedCurrentSessionId,
        message: "The route's current Session does not match the replacement request",
        replacementOwnerRouteId: null,
        replacementSessionId: input.replacementSessionId,
        routeId: input.routeId,
      });
    }
    const replacementOwner = yield* execute("replaceCurrentSession", () =>
      db
        .select({ routeId: sessionOwnership.routeId })
        .from(sessionOwnership)
        .where(eq(sessionOwnership.sessionId, input.replacementSessionId))
        .limit(1)
        .get(),
    );
    if (replacementOwner !== undefined) {
      const owner = yield* decodeRouteOwner("replaceCurrentSession", replacementOwner);
      return yield* new CurrentSessionReplacementConflict({
        actualCurrentSessionId: current.sessionId,
        expectedCurrentSessionId: input.expectedCurrentSessionId,
        message: "The replacement Session is already owned by an Agent route",
        replacementOwnerRouteId: owner.routeId,
        replacementSessionId: input.replacementSessionId,
        routeId: input.routeId,
      });
    }

    yield* execute("replaceCurrentSession", () =>
      // The Durable SQLite driver implements this Drizzle transaction with transactionSync.
      db.transaction((transaction) => {
        transaction
          .update(sessionOwnership)
          .set({ replacedAt: input.replacedAt })
          .where(
            and(
              eq(sessionOwnership.routeId, input.routeId),
              eq(sessionOwnership.sessionId, input.expectedCurrentSessionId),
              isNull(sessionOwnership.replacedAt),
            ),
          )
          .run();
        transaction
          .insert(sessionOwnership)
          .values({
            becameCurrentAt: input.replacedAt,
            replacedAt: null,
            routeId: input.routeId,
            sessionId: input.replacementSessionId,
          })
          .run();
      }),
    );
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
          .orderBy(asc(sessionOwnership.becameCurrentAt), asc(sessionOwnership.sessionId))
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
    readAcceptanceReceipt,
    recordAcceptanceReceipt,
    initialize,
    inspect,
    ownsSession,
    readCommittedTurns,
    readPrimarySessionId,
    readRoute,
    readSessionIds,
    recordCommittedTurn,
    replaceCurrentSession,
  };
};

const acceptanceReceiptFields = {
  acceptedAt: acceptanceReceipts.acceptedAt,
  allowancePeriodId: acceptanceReceipts.allowancePeriodId,
  channelBindingId: acceptanceReceipts.channelBindingId,
  providerMessageId: acceptanceReceipts.providerMessageId,
  receiptId: acceptanceReceipts.receiptId,
  sessionId: acceptanceReceipts.sessionId,
  thinkSubmissionId: acceptanceReceipts.thinkSubmissionId,
  userMessageId: acceptanceReceipts.userMessageId,
};

const decodeAcceptanceReceipt = (
  operation: AgentStoreOperation,
  row: typeof acceptanceReceipts.$inferSelect,
) =>
  Schema.decodeEffect(AcceptanceReceipt)({
    ...row,
    _tag: "AcceptanceReceipt",
    acceptedAt: `${row.acceptedAt.replace(" ", "T")}Z`,
  }).pipe(Effect.mapError(() => invalidStoreRecord(operation)));

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

const decodeRouteOwner = (
  operation: AgentStoreOperation,
  row: typeof RouteOwnerRecord.Encoded,
): Effect.Effect<typeof RouteOwnerRecord.Type, AgentStoreRecordInvalid> =>
  Schema.decodeEffect(RouteOwnerRecord)(row).pipe(
    Effect.mapError(() => invalidStoreRecord(operation)),
  );

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

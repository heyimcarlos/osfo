import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { DbTimestamp } from "../../../db";
import { AgentId, AgentInitializationId, ConversationRouteId, SessionId } from "../../../domain";
import type { AgentDb } from "./client";
import {
  AgentInitializationConflict,
  AgentStateNotFound,
  type AgentStoreOperation,
  AgentStoreUnavailable,
  CommittedTurnConflict,
  CurrentSessionReplacementConflict,
} from "./errors";
import {
  agentInitialization,
  committedTurns,
  conversationRoutes,
  sessionOwnership,
} from "./schema";

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
  assistantMessageId: Schema.String,
  sessionId: SessionId,
  source: Schema.Literals(["hook", "reconciliation"]),
  thinkRequestId: Schema.NullOr(Schema.String),
});

/** Stable observation accepted after a committed Think turn. */
export type CommittedTurnObservation = typeof CommittedTurnObservation.Type;

/** Durable Osfo receipt for one observed committed Think turn. */
export const CommittedTurnReceipt = Schema.Struct({
  ...CommittedTurnObservation.fields,
  observationSequence: Schema.Natural,
  observedAt: Schema.String,
});

/** Durable Osfo receipt for one observed committed Think turn. */
export type CommittedTurnReceipt = typeof CommittedTurnReceipt.Type;

/** Construct deep Agent-local persistence operations over a typed Durable SQLite client. */
export const makeAgentStore = (db: AgentDb) => {
  const initialize = (namedAgentId: AgentId, input: AgentInitializationInput) =>
    Effect.gen(function* () {
      if (input.agentId !== namedAgentId) {
        return yield* new AgentInitializationConflict({
          message: "The AgentId does not match the named Durable Object",
        });
      }
      const existingInitialization = yield* execute("initialize", () =>
        db.select().from(agentInitialization).limit(1).get(),
      );
      if (existingInitialization !== undefined) {
        const existing = yield* readPrimaryFacts("initialize");
        if (
          existing.agentId !== input.agentId ||
          existing.initializationId !== input.initializationId ||
          existing.routeId !== input.routeId ||
          existing.sessionId !== input.sessionId
        ) {
          return yield* new AgentInitializationConflict({
            message: "The named Agent is already initialized with different stable facts",
          });
        }
        return AgentInitialized.make({
          agentId: existing.agentId,
          currentSessionId: existing.sessionId,
          routeId: existing.routeId,
        });
      }

      yield* execute("initialize", () =>
        // The Durable SQLite driver implements this Drizzle transaction with transactionSync.
        db.transaction((transaction) => {
          transaction
            .insert(agentInitialization)
            .values({
              agentId: input.agentId,
              initializationId: input.initializationId,
              initializedAt: input.initializedAt,
              singletonKey: "agent",
            })
            .run();
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
        message: "The route's current Session does not match the replacement request",
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
      return yield* new CurrentSessionReplacementConflict({
        message: "The replacement Session is already owned by an Agent route",
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
    ).pipe(Effect.map((row) => row !== undefined));

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
  ).pipe(Effect.map((rows) => rows.map(({ sessionId }) => sessionId)));

  const recordCommittedTurn = (reference: CommittedTurnObservation) =>
    Effect.gen(function* () {
      const outcome = yield* execute("recordCommittedTurn", () =>
        // The Durable SQLite driver implements this exact local transaction with transactionSync.
        db.transaction((transaction) => {
          const findByThinkRequestId = (thinkRequestId: string) =>
            transaction
              .select({ assistantMessageId: committedTurns.assistantMessageId })
              .from(committedTurns)
              .where(eq(committedTurns.thinkRequestId, thinkRequestId))
              .limit(1)
              .get();
          const matchingMessage = transaction
            .select(committedTurnReceiptFields)
            .from(committedTurns)
            .where(eq(committedTurns.assistantMessageId, reference.assistantMessageId))
            .limit(1)
            .get();
          if (matchingMessage !== undefined) {
            if (matchingMessage.sessionId !== reference.sessionId) {
              return {
                _tag: "Conflict",
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
                message: "The assistant message is already observed for another Think request",
              } as const;
            }
            if (matchingMessage.thinkRequestId === null && reference.thinkRequestId !== null) {
              const matchingRequest = findByThinkRequestId(reference.thinkRequestId);
              if (matchingRequest !== undefined) {
                return {
                  _tag: "Conflict",
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
            if (matchingRequest !== undefined) {
              return {
                _tag: "Conflict",
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
      if ("message" in outcome) {
        return yield* new CommittedTurnConflict({
          assistantMessageId: reference.assistantMessageId,
          message: outcome.message,
          sessionId: reference.sessionId,
          thinkRequestId: reference.thinkRequestId,
        });
      }
      return CommittedTurnReceipt.make(outcome.receipt);
    });

  const readCommittedTurns = execute("readCommittedTurns", () =>
    db
      .select(committedTurnReceiptFields)
      .from(committedTurns)
      .orderBy(asc(committedTurns.observationSequence))
      .all(),
  ).pipe(Effect.map((rows) => rows.map((row) => CommittedTurnReceipt.make(row))));

  const readPrimaryFacts = (operation: AgentStoreOperation) =>
    execute(operation, () =>
      db
        .select({
          agentId: agentInitialization.agentId,
          initializationId: agentInitialization.initializationId,
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
    ).pipe(
      Effect.flatMap((facts) =>
        facts === undefined
          ? Effect.fail(
              new AgentStateNotFound({
                message: "The named Agent is not initialized",
                subject: "agent",
              }),
            )
          : Effect.succeed(facts),
      ),
    );

  const readRouteSessions = (routeId: ConversationRouteId, operation: AgentStoreOperation) =>
    execute(operation, () =>
      db
        .select({
          replacedAt: sessionOwnership.replacedAt,
          sessionId: sessionOwnership.sessionId,
        })
        .from(sessionOwnership)
        .where(eq(sessionOwnership.routeId, routeId))
        .orderBy(asc(sessionOwnership.becameCurrentAt), asc(sessionOwnership.sessionId))
        .all(),
    ).pipe(
      Effect.flatMap((sessions) =>
        sessions.length === 0
          ? Effect.fail(
              new AgentStateNotFound({
                message: "The conversation route does not exist",
                subject: "route",
              }),
            )
          : Effect.succeed(sessions),
      ),
    );

  return {
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

const committedTurnReceiptFields = {
  assistantMessageId: committedTurns.assistantMessageId,
  observationSequence: committedTurns.observationSequence,
  observedAt: committedTurns.observedAt,
  sessionId: committedTurns.sessionId,
  source: committedTurns.source,
  thinkRequestId: committedTurns.thinkRequestId,
};

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

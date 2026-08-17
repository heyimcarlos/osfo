import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Session } from "@cloudflare/think";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";

import { AgentId, AgentInitializationId, ConversationRouteId, SessionId } from "../src/domain";
import { DbTimestamp } from "../src/db";
import { makeAgentDb } from "../src/agents/osfo/db/client";
import { makeAgentStore } from "../src/agents/osfo/db/store";
import {
  makeSessionRecallTools,
  makeThinkSessionRecallSearch,
} from "../src/agents/osfo/session-recall";
import { ManagedTurnMetadata } from "../src/domain/managed-conversation";
import {
  makeSessionRecall,
  SessionRecallCursor,
  SessionRecallStoreUnavailable,
  type SessionRecall,
} from "../src/services/session-recall";
import {
  conversationRoutes,
  sessionOwnership,
  sessionRecallCursors,
} from "../src/agents/osfo/db/schema";
import { replaceOwnedSession } from "./support/session-store";

/* oxlint-disable effecttsgo/async-function, effecttsgo/prefer-typed-schema-decoder, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Worker integration tests cross Promise, RPC, Effect, and raw SQLite test boundaries. */

const managedTurnMetadata = (routeId: ConversationRouteId, sessionId: SessionId) =>
  Schema.decodeSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn" as const,
    allowancePeriodId: "period-session-recall",
    authorityIdentity: {
      _tag: "AuthSession" as const,
      authSessionId: "auth-session-session-recall",
      userId: "user-session-recall",
    },
    conservativeVendorUsdMicros: 30_000,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxRetries: 0 as const,
    maxSteps: 6,
    originatingAuthority: {
      _tag: "AuthSession" as const,
      authSessionId: "auth-session-session-recall",
    },
    plan: "free" as const,
    planPolicyVersion: "launch-v1",
    route: "dynamic/osfo-free-v1",
    routeId,
    sessionId,
    submissionId: "submission-session-recall",
    targetInputTokens: 18_000,
  });

const makeAuthorizedRecallTools = (
  metadata: ManagedTurnMetadata,
  recall: SessionRecall["recall"],
) =>
  makeSessionRecallTools({
    authorize: () => Effect.void,
    readActiveTurn: () => metadata,
    recall,
  });

const makeRecall = (
  instance: Parameters<typeof Session.create>[0],
  store: ReturnType<typeof makeAgentStore>,
) =>
  makeSessionRecall({
    search: makeThinkSessionRecallSearch((sessionId, query, limit) =>
      Session.create(instance).forSession(sessionId).search(query, { limit }),
    ),
    store: {
      readRecallPage: (routeId, cursor, limit) =>
        store.readRouteSessionPage(routeId, cursor, limit).pipe(
          Effect.mapError((failure) =>
            Predicate.isTagged(failure, "SessionRecallCursorInvalid")
              ? failure
              : new SessionRecallStoreUnavailable({
                  cause: failure,
                  message: "Session Recall storage is unavailable",
                }),
          ),
        ),
    },
  });

describe("Osfo Session Recall", () => {
  it.effect("refreshes authorization before model-invoked recall", () =>
    Effect.gen(function* () {
      const routeId = ConversationRouteId.make("route-recall-order");
      const sessionId = SessionId.make("session-recall-order");
      const calls: Array<string> = [];
      const recall = makeSessionRecallTools({
        authorize: () => Effect.sync(() => calls.push("authorize")).pipe(Effect.asVoid),
        readActiveTurn: () => managedTurnMetadata(routeId, sessionId),
        recall: (request) =>
          Effect.sync(() => {
            calls.push("recall");
            return {
              _tag: "SessionRecallCompleted" as const,
              currentSessionId: sessionId,
              nextCursor: null,
              results: [],
              routeId: request.routeId,
            };
          }),
      }).sessionRecall;
      if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
        return yield* Effect.die("Session Recall tool must be exposed");
      }
      const execute = recall.execute;

      const result = yield* Effect.promise(() =>
        execute(
          { query: "orchid" },
          { context: undefined, messages: [], toolCallId: "tool-call-recall-order" },
        ),
      );

      expect(calls).toEqual(["authorize", "recall"]);
      expect(result).toMatchObject({ _tag: "SessionRecallCompleted", routeId });
      return undefined;
    }),
  );

  it.effect(
    "recalls lexical evidence from current and historical route Sessions only on demand",
    () =>
      Effect.gen(function* () {
        const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-recall");
        const initializationId =
          Schema.decodeUnknownSync(AgentInitializationId)("init-session-recall");
        const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-session-recall");
        const historicalSessionId = Schema.decodeUnknownSync(SessionId)("session-recall-history");
        const currentSessionId = Schema.decodeUnknownSync(SessionId)("session-recall-current");
        const otherRouteId = Schema.decodeUnknownSync(ConversationRouteId)("route-recall-other");
        const otherSessionId = Schema.decodeUnknownSync(SessionId)("session-recall-other");
        const agent = env.OSFO_AGENT.getByName(agentId);

        yield* Effect.promise(
          async () =>
            await agent.initialize({
              agentId,
              initializationId,
              initializedAt: "2026-08-15T12:00:00.000Z",
              routeId,
              sessionId: historicalSessionId,
            }),
        );
        yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance) => {
            await Session.create(instance)
              .forSession(historicalSessionId)
              .appendMessage({
                id: "message-historical-orchid",
                parts: [{ text: "The orchid invoice was paid", type: "text" }],
                role: "assistant",
              });
          }),
        );
        yield* Effect.promise(
          async () =>
            await replaceOwnedSession(agent, {
              expectedCurrentSessionId: historicalSessionId,
              replacedAt: "2026-08-15T13:00:00.000Z",
              replacementSessionId: currentSessionId,
              routeId,
            }),
        );
        yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance, state) => {
            await Session.create(instance)
              .forSession(currentSessionId)
              .appendMessage({
                id: "message-current-orchid",
                parts: [{ text: "The orchid shipment arrives Friday", type: "text" }],
                role: "assistant",
              });
            const db = makeAgentDb(state.storage);
            db.insert(conversationRoutes).values({ isPrimary: false, routeId: otherRouteId }).run();
            db.insert(sessionOwnership)
              .values({
                becameCurrentAt: Schema.decodeUnknownSync(DbTimestamp)("2026-08-15T14:00:00.000Z"),
                ownershipSequence: 3,
                replacedAt: null,
                routeId: otherRouteId,
                sessionId: otherSessionId,
              })
              .run();
            await Session.create(instance)
              .forSession(otherSessionId)
              .appendMessage({
                id: "message-other-orchid",
                parts: [
                  {
                    text: "The orchid secret belongs to another route",
                    type: "text",
                  },
                ],
                role: "assistant",
              });
          }),
        );

        const historyBeforeRecall = yield* Effect.promise(
          async () => await agent.readSession(currentSessionId),
        );
        const toolRecall = yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance, state) => {
            const search = vi.spyOn(Session.prototype, "search");
            const activeTurnMetadata = vi
              .spyOn(instance, "activeTurnMetadata", "get")
              .mockReturnValue(managedTurnMetadata(routeId, currentSessionId));
            try {
              const productionRecall = instance.getTools().sessionRecall;
              await instance.readSession(currentSessionId);
              const searchesBeforeInvocation = search.mock.calls.length;
              if (
                productionRecall === undefined ||
                !("execute" in productionRecall) ||
                productionRecall.execute === undefined
              ) {
                return null;
              }
              const recall = makeAuthorizedRecallTools(
                managedTurnMetadata(routeId, currentSessionId),
                makeRecall(instance, makeAgentStore(makeAgentDb(state.storage))).recall,
              ).sessionRecall;
              if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
                return null;
              }
              const result = await recall.execute(
                { query: "orchid" },
                {
                  context: undefined,
                  messages: [],
                  toolCallId: "tool-call-session-recall",
                },
              );
              return {
                result,
                productionToolExposed: true,
                searchesAfterInvocation: search.mock.calls.length,
                searchesBeforeInvocation,
              };
            } finally {
              activeTurnMetadata.mockRestore();
              search.mockRestore();
            }
          }),
        );
        const historyAfterRecall = yield* Effect.promise(
          async () => await agent.readSession(currentSessionId),
        );
        const otherRouteToolRecall = yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance, state) => {
            const activeTurnMetadata = vi
              .spyOn(instance, "activeTurnMetadata", "get")
              .mockReturnValue(managedTurnMetadata(otherRouteId, otherSessionId));
            try {
              const recall = makeAuthorizedRecallTools(
                managedTurnMetadata(otherRouteId, otherSessionId),
                makeRecall(instance, makeAgentStore(makeAgentDb(state.storage))).recall,
              ).sessionRecall;
              if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
                return null;
              }
              return await recall.execute(
                { limit: 10, query: "orchid" },
                {
                  context: undefined,
                  messages: [],
                  toolCallId: "tool-call-other-route-recall",
                },
              );
            } finally {
              activeTurnMetadata.mockRestore();
            }
          }),
        );
        const unavailableToolRecall = yield* Effect.promise(() =>
          runInDurableObject(
            env.OSFO_AGENT.getByName(
              Schema.decodeUnknownSync(AgentId)("agent-session-recall-uninitialized"),
            ),
            async (instance) => {
              const recall = instance.getTools().sessionRecall;
              if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
                return null;
              }
              return await recall.execute(
                { query: "orchid" },
                {
                  context: undefined,
                  messages: [],
                  toolCallId: "tool-call-session-unavailable",
                },
              );
            },
          ),
        );
        const malformedCursorToolRecall = yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance, state) => {
            const activeTurnMetadata = vi
              .spyOn(instance, "activeTurnMetadata", "get")
              .mockReturnValue(managedTurnMetadata(routeId, currentSessionId));
            try {
              const recall = makeAuthorizedRecallTools(
                managedTurnMetadata(routeId, currentSessionId),
                makeRecall(instance, makeAgentStore(makeAgentDb(state.storage))).recall,
              ).sessionRecall;
              if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
                return null;
              }
              return await recall.execute(
                {
                  cursor: SessionRecallCursor.make("00000000-0000-4000-8000-000000000000"),
                  query: "orchid",
                },
                {
                  context: undefined,
                  messages: [],
                  toolCallId: "tool-call-malformed-cursor",
                },
              );
            } finally {
              activeTurnMetadata.mockRestore();
            }
          }),
        );

        const recalled = {
          _tag: "SessionRecallCompleted",
          currentSessionId,
          nextCursor: null,
          results: [
            {
              content: "The orchid shipment arrives Friday",
              messageId: "message-current-orchid",
              role: "assistant",
              sessionId: currentSessionId,
              sessionState: "current",
            },
            {
              content: "The orchid invoice was paid",
              messageId: "message-historical-orchid",
              role: "assistant",
              sessionId: historicalSessionId,
              sessionState: "historical",
            },
          ],
          routeId,
        };
        expect(historyAfterRecall).toEqual(historyBeforeRecall);
        expect(toolRecall).toEqual({
          productionToolExposed: true,
          result: recalled,
          searchesAfterInvocation: 2,
          searchesBeforeInvocation: 0,
        });
        expect(otherRouteToolRecall).toEqual({
          _tag: "SessionRecallCompleted",
          currentSessionId: otherSessionId,
          nextCursor: null,
          results: [
            {
              content: "The orchid secret belongs to another route",
              messageId: "message-other-orchid",
              role: "assistant",
              sessionId: otherSessionId,
              sessionState: "current",
            },
          ],
          routeId: otherRouteId,
        });
        expect(unavailableToolRecall).toEqual({
          _tag: "SessionRecallUnavailable",
          message: "Session Recall is unavailable",
        });
        expect(malformedCursorToolRecall).toEqual({
          _tag: "SessionRecallUnavailable",
          message: "Session Recall is unavailable",
        });
        expect(
          "results" in recalled &&
            recalled.results.every(({ content }) => !content.includes("another route")),
        ).toBe(true);
      }),
  );

  it.effect("bounds lexical recall work across retained Sessions", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-recall-bounded");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-session-recall-bounded",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-recall-bounded");
      const initialSessionId = Schema.decodeUnknownSync(SessionId)("session-recall-bounded-0");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: initialSessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await Session.create(instance)
            .forSession(initialSessionId)
            .appendMessage({
              id: "message-oldest-archive-marker",
              parts: [{ text: "The archive-marker is in the oldest Session", type: "text" }],
              role: "assistant",
            });
        }),
      );
      let currentSessionId = initialSessionId;
      for (let index = 1; index <= 25; index += 1) {
        const replacementSessionId = Schema.decodeUnknownSync(SessionId)(
          `session-recall-bounded-${index}`,
        );
        yield* Effect.promise(
          async () =>
            await replaceOwnedSession(agent, {
              expectedCurrentSessionId: currentSessionId,
              replacedAt:
                index === 25
                  ? "2026-08-01T12:00:00.000Z"
                  : `2026-09-${String(index).padStart(2, "0")}T12:00:00.000Z`,
              replacementSessionId,
              routeId,
            }),
        );
        currentSessionId = replacementSessionId;
      }
      const latestHistoricalSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-recall-bounded-24",
      );
      const replacementAfterSnapshotId = Schema.decodeUnknownSync(SessionId)(
        "session-recall-after-snapshot",
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await Session.create(instance)
            .forSession(currentSessionId)
            .appendMessage({
              id: "message-current-page-stop",
              parts: [{ text: "The page-stop is current", type: "text" }],
              role: "assistant",
            });
          await Session.create(instance)
            .forSession(latestHistoricalSessionId)
            .appendMessage({
              id: "message-historical-page-stop",
              parts: [{ text: "The page-stop is historical", type: "text" }],
              role: "assistant",
            });
        }),
      );

      const recallWork = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance, state) => {
          const search = vi.spyOn(Session.prototype, "search");
          const activeTurnMetadata = vi
            .spyOn(instance, "activeTurnMetadata", "get")
            .mockReturnValue(managedTurnMetadata(routeId, currentSessionId));
          try {
            const recall = makeAuthorizedRecallTools(
              managedTurnMetadata(routeId, currentSessionId),
              makeRecall(instance, makeAgentStore(makeAgentDb(state.storage))).recall,
            ).sessionRecall;
            if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
              return null;
            }
            const firstPage = await recall.execute(
              { limit: 20, query: "archive-marker" },
              {
                context: undefined,
                messages: [],
                toolCallId: "tool-call-bounded-recall",
              },
            );
            const firstPageSearches = search.mock.calls.length;
            const firstPageCursor = "nextCursor" in firstPage ? firstPage.nextCursor : null;
            search.mockClear();
            if (firstPageCursor === null) return null;
            const tamperedCursor = SessionRecallCursor.make(
              `${firstPageCursor.slice(0, -1)}${firstPageCursor.endsWith("0") ? "1" : "0"}`,
            );
            const tamperedPage = await recall.execute(
              { cursor: tamperedCursor, limit: 20, query: "archive-marker" },
              {
                context: undefined,
                messages: [],
                toolCallId: "tool-call-tampered-recall",
              },
            );
            search.mockClear();
            const olderPageInput = {
              cursor: firstPageCursor,
              limit: 20,
              query: "archive-marker",
            };
            const olderPage = await recall.execute(olderPageInput, {
              context: undefined,
              messages: [],
              toolCallId: "tool-call-older-recall",
            });
            const olderPageSearches = search.mock.calls.length;
            search.mockClear();
            const resultLimitedPage = await recall.execute(
              { limit: 1, query: "page-stop" },
              {
                context: undefined,
                messages: [],
                toolCallId: "tool-call-result-limited-recall",
              },
            );
            const resultLimitedPageSearches = search.mock.calls.length;
            const resultLimitedPageCursor =
              "nextCursor" in resultLimitedPage ? resultLimitedPage.nextCursor : null;
            search.mockClear();
            if (resultLimitedPageCursor === null) return null;
            const resumedPageInput = {
              cursor: resultLimitedPageCursor,
              limit: 1,
              query: "page-stop",
            };
            const resumedPage = await recall.execute(resumedPageInput, {
              context: undefined,
              messages: [],
              toolCallId: "tool-call-resumed-recall",
            });
            const resumedPageSearches = search.mock.calls.length;
            search.mockClear();
            const replacementAfterSnapshot = await Effect.runPromise(
              makeAgentStore(makeAgentDb(state.storage)).replaceCurrentSession({
                expectedCurrentSessionId: currentSessionId,
                replacedAt: Schema.decodeUnknownSync(DbTimestamp)("2026-10-01T12:00:00.000Z"),
                replacementSessionId: replacementAfterSnapshotId,
                routeId,
              }),
            );
            const olderPageAfterReplacement = await recall.execute(olderPageInput, {
              context: undefined,
              messages: [],
              toolCallId: "tool-call-older-recall-after-replacement",
            });
            return {
              firstPage,
              firstPageCursorIsOpaque: Schema.is(SessionRecallCursor)(firstPageCursor),
              firstPageSearches,
              olderPage,
              olderPageAfterReplacement,
              olderPageAfterReplacementSearches: search.mock.calls.length,
              olderPageSearches,
              resultLimitedPage,
              resultLimitedPageCursorIsOpaque:
                Schema.is(SessionRecallCursor)(resultLimitedPageCursor),
              resultLimitedPageSearches,
              resumedPage,
              resumedPageSearches,
              replacementAfterSnapshot,
              tamperedPage,
            };
          } finally {
            activeTurnMetadata.mockRestore();
            search.mockRestore();
          }
        }),
      );

      expect(recallWork).toEqual({
        firstPage: {
          _tag: "SessionRecallCompleted",
          currentSessionId,
          nextCursor: expect.any(String),
          results: [],
          routeId,
        },
        firstPageCursorIsOpaque: true,
        firstPageSearches: 20,
        olderPage: {
          _tag: "SessionRecallCompleted",
          currentSessionId,
          nextCursor: null,
          results: [
            {
              content: "The archive-marker is in the oldest Session",
              messageId: "message-oldest-archive-marker",
              role: "assistant",
              sessionId: initialSessionId,
              sessionState: "historical",
            },
          ],
          routeId,
        },
        olderPageSearches: 6,
        olderPageAfterReplacement: {
          _tag: "SessionRecallCompleted",
          currentSessionId,
          nextCursor: null,
          results: [
            {
              content: "The archive-marker is in the oldest Session",
              messageId: "message-oldest-archive-marker",
              role: "assistant",
              sessionId: initialSessionId,
              sessionState: "historical",
            },
          ],
          routeId,
        },
        olderPageAfterReplacementSearches: 6,
        resultLimitedPage: {
          _tag: "SessionRecallCompleted",
          currentSessionId,
          nextCursor: expect.any(String),
          results: [
            {
              content: "The page-stop is current",
              messageId: "message-current-page-stop",
              role: "assistant",
              sessionId: currentSessionId,
              sessionState: "current",
            },
          ],
          routeId,
        },
        resultLimitedPageCursorIsOpaque: true,
        resultLimitedPageSearches: 1,
        resumedPage: {
          _tag: "SessionRecallCompleted",
          currentSessionId,
          nextCursor: expect.any(String),
          results: [
            {
              content: "The page-stop is historical",
              messageId: "message-historical-page-stop",
              role: "assistant",
              sessionId: latestHistoricalSessionId,
              sessionState: "historical",
            },
          ],
          routeId,
        },
        resumedPageSearches: 1,
        replacementAfterSnapshot: {
          _tag: "CurrentSessionReplaced",
          currentSessionId: replacementAfterSnapshotId,
          historicalSessionId: currentSessionId,
          routeId,
        },
        tamperedPage: {
          _tag: "SessionRecallUnavailable",
          message: "Session Recall is unavailable",
        },
      });
    }),
  );

  it.effect("keeps late ownership keyset pages bounded across deep history", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-recall-deep");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-session-recall-deep",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-recall-deep");
      const currentSessionId = Schema.decodeUnknownSync(SessionId)("session-recall-deep-current");
      const replacementSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-recall-deep-replacement",
      );
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: currentSessionId,
          }),
      );

      const pageEvidence = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const db = makeAgentDb(state.storage);
          const historicalRows = Array.from({ length: 200 }, (_, index) => ({
            becameCurrentAt: Schema.decodeUnknownSync(DbTimestamp)(
              `2026-08-01T00:00:00.${String(index).padStart(3, "0")}Z`,
            ),
            ownershipSequence: index + 2,
            replacedAt: Schema.decodeUnknownSync(DbTimestamp)("2026-08-15T11:00:00.000Z"),
            routeId,
            sessionId: Schema.decodeUnknownSync(SessionId)(`session-recall-deep-${index}`),
          }));
          for (let rowIndex = 0; rowIndex < historicalRows.length; rowIndex += 20) {
            db.insert(sessionOwnership)
              .values(historicalRows.slice(rowIndex, rowIndex + 20))
              .run();
          }
          const expiredCursorRows = Array.from({ length: 80 }, (_, index) => ({
            afterOwnershipSequence: null,
            cursor: SessionRecallCursor.make(
              `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            ),
            expiresAt: Schema.decodeUnknownSync(DbTimestamp)("2020-01-01T00:00:00.000Z"),
            routeId,
            snapshotCurrentSessionId: currentSessionId,
            snapshotMaxOwnershipSequence: 201,
          }));
          for (let rowIndex = 0; rowIndex < expiredCursorRows.length; rowIndex += 10) {
            db.insert(sessionRecallCursors)
              .values(expiredCursorRows.slice(rowIndex, rowIndex + 10))
              .run();
          }
          const store = makeAgentStore(db);
          const candidateCounts: Array<number> = [];
          const cursorCounts: Array<number> = [];
          const expiredCursorCounts: Array<number> = [];
          const currentSessionIds: Array<SessionId> = [];
          const materializedSessionIds: Array<SessionId> = [];
          const rowsReadPerPage: Array<number> = [];
          let cursor: SessionRecallCursor | null = null;
          let completed = false;

          for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
            const exec = vi.spyOn(state.storage.sql, "exec");
            const page: {
              readonly candidates: ReadonlyArray<{
                readonly cursor: SessionRecallCursor;
                readonly sessionId: SessionId;
              }>;
              readonly currentSessionId: SessionId;
              readonly hasMore: boolean;
            } = await Effect.runPromise(store.readRouteSessionPage(routeId, cursor, 20));
            candidateCounts.push(page.candidates.length);
            currentSessionIds.push(page.currentSessionId);
            materializedSessionIds.push(...page.candidates.map(({ sessionId }) => sessionId));
            rowsReadPerPage.push(
              exec.mock.results.reduce(
                (total, result) =>
                  result.type === "return" ? total + result.value.rowsRead : total,
                0,
              ),
            );
            exec.mockRestore();
            cursorCounts.push(
              db.select({ cursor: sessionRecallCursors.cursor }).from(sessionRecallCursors).all()
                .length,
            );
            expiredCursorCounts.push(
              db
                .select({ expiresAt: sessionRecallCursors.expiresAt })
                .from(sessionRecallCursors)
                .all()
                .filter(({ expiresAt }) => expiresAt === "2020-01-01T00:00:00.000Z").length,
            );
            if (pageIndex === 0) {
              await Effect.runPromise(
                store.replaceCurrentSession({
                  expectedCurrentSessionId: currentSessionId,
                  replacedAt: Schema.decodeUnknownSync(DbTimestamp)("2026-08-16T00:00:00.000Z"),
                  replacementSessionId,
                  routeId,
                }),
              );
            }
            cursor = page.candidates.at(-1)?.cursor ?? null;
            if (!page.hasMore) {
              completed = true;
              break;
            }
          }

          const invalidCursorFailure = await Effect.runPromise(
            Effect.flip(
              store.readRouteSessionPage(
                routeId,
                SessionRecallCursor.make("00000000-0000-4000-8000-000000000000"),
                20,
              ),
            ),
          );

          return {
            candidateCounts,
            completed,
            cursorCounts,
            currentSessionIds,
            expiredCursorCounts,
            invalidCursorFailureTag: invalidCursorFailure._tag,
            materializedSessionIds,
            rowsReadPerPage,
          };
        }),
      );

      expect(pageEvidence.candidateCounts).toEqual([...Array.from({ length: 10 }, () => 20), 1]);
      expect(pageEvidence.completed).toBe(true);
      expect(pageEvidence.currentSessionIds).toEqual(
        Array.from({ length: 11 }, () => currentSessionId),
      );
      expect(pageEvidence.cursorCounts.slice(0, 2)).toEqual([60, 40]);
      expect(pageEvidence.expiredCursorCounts.slice(0, 4)).toEqual([40, 0, 0, 0]);
      expect(pageEvidence.invalidCursorFailureTag).toBe("SessionRecallCursorInvalid");
      expect(pageEvidence.materializedSessionIds).toEqual([
        currentSessionId,
        ...Array.from({ length: 200 }, (_, index) =>
          Schema.decodeUnknownSync(SessionId)(`session-recall-deep-${199 - index}`),
        ),
      ]);
      expect(new Set(pageEvidence.materializedSessionIds).size).toBe(201);
      expect(new Set(pageEvidence.rowsReadPerPage.slice(2, -1)).size).toBe(1);
      expect(Math.max(...pageEvidence.rowsReadPerPage)).toBeLessThanOrEqual(182);
    }),
  );

  it.effect("returns unavailable when Session Recall exceeds its global latency budget", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-recall-timeout");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-session-recall-timeout",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-recall-timeout");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-recall-timeout");
      const agent = env.OSFO_AGENT.getByName(agentId);
      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );

      const result = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance, state) => {
          vi.useFakeTimers();
          const search = vi.spyOn(Session.prototype, "search").mockImplementation(() => {
            // oxlint-disable-next-line effecttsgo/new-promise -- The Think Promise boundary must stay pending past the policy deadline.
            return new Promise((resolve) => {
              // oxlint-disable-next-line effecttsgo/global-timers -- Fake timers control this vendor-boundary delay deterministically.
              setTimeout(() => resolve([]), 1_500);
            });
          });
          const activeTurnMetadata = vi
            .spyOn(instance, "activeTurnMetadata", "get")
            .mockReturnValue(managedTurnMetadata(routeId, sessionId));
          try {
            const recall = makeAuthorizedRecallTools(
              managedTurnMetadata(routeId, sessionId),
              makeRecall(instance, makeAgentStore(makeAgentDb(state.storage))).recall,
            ).sessionRecall;
            if (recall === undefined || !("execute" in recall) || recall.execute === undefined) {
              return null;
            }
            const execution = recall.execute(
              { query: "slow" },
              {
                context: undefined,
                messages: [],
                toolCallId: "tool-call-timeout-recall",
              },
            );
            await vi.advanceTimersByTimeAsync(2_000);
            return { result: await execution, searches: search.mock.calls.length };
          } finally {
            activeTurnMetadata.mockRestore();
            search.mockRestore();
            vi.useRealTimers();
          }
        }),
      );

      expect(result).toEqual({
        result: {
          _tag: "SessionRecallUnavailable",
          message: "Session Recall is unavailable",
        },
        searches: 1,
      });
    }),
  );
});

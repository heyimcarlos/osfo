import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  AgentId,
  AgentInitializationId,
  AllowancePeriodId,
  AssistantMessageId,
  ConversationRouteId,
  SessionId,
  ThinkRequestId,
} from "../src/domain";
import { ModelCallAttemptId } from "../src/domain/model-call-attempt";
import { DbTimestamp } from "../src/db";
import { makeAgentDb } from "../src/agents/osfo/db/client";
import {
  agentMigrations,
  type AgentMigration,
  applyMigrationChain,
} from "../src/agents/osfo/db/migrate";
import { makeAgentStore } from "../src/agents/osfo/db/store";
import {
  agentInitialization,
  committedTurns,
  conversationRoutes,
  sessionOwnership,
} from "../src/agents/osfo/db/schema";

/* oxlint-disable effecttsgo/async-function, effecttsgo/prefer-typed-schema-decoder, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Worker integration tests cross Promise, RPC, Effect, and raw SQLite test boundaries. */

describe("Osfo Agent and Think Session foundation", () => {
  it.effect("commits one localized welcome from accepted setup facts only", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-personal-welcome");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-personal-welcome");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-personal-welcome");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-personal-welcome");
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

      const input = {
        channelBindingId: "channel-binding-welcome",
        helpAreas: ["scheduling-reminders", "writing-email"],
        locale: "es",
        preferredName: "Sol",
      } as const;
      const committed = yield* Effect.promise(async () => await agent.commitWelcome(input));
      const repeated = yield* Effect.promise(async () => await agent.commitWelcome(input));
      const history = yield* Effect.promise(async () => await agent.readSession(sessionId));
      const receipts = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(repeated).toEqual(committed);
      expect(committed).toEqual({
        _tag: "PersonalWelcomeCommitted",
        messageId: "welcome-channel-binding-welcome",
        sessionId,
        text: "Hola Sol, estoy listo. Elegiste agenda y recordatorios y redacción y correo. ¿En qué trabajamos primero?",
      });
      expect(history).toEqual({
        _tag: "SessionHistoryFound",
        messages: [
          {
            id: "welcome-channel-binding-welcome",
            parts: [
              {
                text: "Hola Sol, estoy listo. Elegiste agenda y recordatorios y redacción y correo. ¿En qué trabajamos primero?",
                type: "text",
              },
            ],
            role: "assistant",
          },
        ],
        sessionId,
      });
      expect(receipts).toHaveLength(1);
    }),
  );

  it.effect("keeps managed inference private and disables blind Action replay", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(
        Schema.decodeUnknownSync(AgentId)("agent-managed-runtime-policy"),
      );
      const policy = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => ({
          actionLedgerPendingRetryLeaseMs: instance.actionLedgerPendingRetryLeaseMs,
          actionPendingApprovalTtlMs: instance.actionPendingApprovalTtlMs,
          chatRecovery: instance.chatRecovery,
          hydrationByteBudget: instance.hydrationByteBudget,
          includeMcpTools: instance.includeMcpTools,
          maxSteps: instance.maxSteps,
          sendReasoning: instance.sendReasoning,
          storeMessages: instance.storeMessages,
          storeTools: instance.storeTools,
          workspaceBash: instance.workspaceBash,
        })),
      );

      expect(policy).toEqual({
        actionLedgerPendingRetryLeaseMs: false,
        actionPendingApprovalTtlMs: 900_000,
        chatRecovery: false,
        hydrationByteBudget: 512_000,
        includeMcpTools: false,
        maxSteps: 6,
        sendReasoning: false,
        storeMessages: false,
        storeTools: false,
        workspaceBash: false,
      });
    }),
  );

  it.effect("delegates managed conversation cancellation to Think's Submission ledger", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(
        Schema.decodeUnknownSync(AgentId)("agent-managed-cancellation"),
      );
      const canceled = yield* Effect.promise(
        async () =>
          await agent.cancelManagedConversation({
            reason: "The User canceled the request",
            submissionId: "submission-not-created",
          }),
      );

      expect(canceled).toBeNull();
    }),
  );

  it.effect("keeps a missing AI Gateway cost pending before conservative settlement", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(
        Schema.decodeUnknownSync(AgentId)("agent-gateway-cost-settlement"),
      );
      yield* Effect.promise(() =>
        agent.settleGatewayModelUsage({
          allowancePeriodId: AllowancePeriodId.make("period-gateway-cost"),
          attemptId: ModelCallAttemptId.make("model-call-attempt:submission-gateway-cost:1"),
          conservativeVendorUsdMicros: 5_000,
          gatewayLogId: "missing-gateway-log",
          lookupAttempt: 1,
        }),
      );

      const state = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => ({
          delayed: (await instance.listSchedules({ type: "delayed" })).map(
            ({ callback, payload, type }) => ({ callback, payload, type }),
          ),
          usageRows: instance.sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM osfo_model_call_usage_evidence
          `,
        })),
      );

      expect(state.delayed).toEqual([
        {
          callback: "settleGatewayModelUsage",
          payload: {
            allowancePeriodId: "period-gateway-cost",
            attemptId: "model-call-attempt:submission-gateway-cost:1",
            conservativeVendorUsdMicros: 5_000,
            gatewayLogId: "missing-gateway-log",
            lookupAttempt: 2,
          },
          type: "delayed",
        },
      ]);
      expect(state.usageRows).toEqual([{ count: 0 }]);
    }),
  );

  it.effect("keeps the Agent identity stable when its activation is replaced", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-stable");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)("init-stable");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-primary");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-primary");
      const agent = env.OSFO_AGENT.getByName(agentId);

      const initialized = yield* Effect.promise(() =>
        (async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }))(),
      );
      const repeatedInitialization = yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      const conflictingInitialization = yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId: "init-conflicting",
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      const changedTimestampInitialization = yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:01.000Z",
            routeId,
            sessionId,
          }),
      );
      const firstActivation = yield* Effect.promise(async () => await agent.probeRuntime());

      yield* Effect.promise(() => evictDurableObject(agent));

      const found = yield* Effect.promise(async () => await agent.inspect());
      const replacementActivation = yield* Effect.promise(async () => await agent.probeRuntime());

      expect(initialized).toEqual({
        _tag: "AgentInitialized",
        agentId: "agent-stable",
        currentSessionId: "session-primary",
        routeId: "route-primary",
      });
      expect(repeatedInitialization).toEqual(initialized);
      expect(conflictingInitialization).toMatchObject({
        _tag: "AgentInitializationConflict",
        existingInitializationId: "init-stable",
        message: "The named Agent is already initialized with different stable facts",
        requestedInitializationId: "init-conflicting",
      });
      expect(changedTimestampInitialization).toMatchObject({
        _tag: "AgentInitializationConflict",
        existingInitializationId: "init-stable",
        message: "The named Agent is already initialized with different stable facts",
        requestedInitializationId: "init-stable",
      });
      expect(found).toEqual({
        _tag: "AgentFound",
        agentId: "agent-stable",
        currentSessionId: "session-primary",
        routeId: "route-primary",
      });
      expect(replacementActivation).toHaveProperty("activationId");
      expect(firstActivation).toHaveProperty("activationId");
      if ("activationId" in replacementActivation && "activationId" in firstActivation) {
        expect(replacementActivation.activationId).not.toBe(firstActivation.activationId);
      }
    }),
  );

  it.effect("keeps exactly one current Session and retains route history", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-route-history");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-route-history");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-history");
      const initialSessionId = Schema.decodeUnknownSync(SessionId)("session-initial");
      const replacementSessionId = Schema.decodeUnknownSync(SessionId)("session-replacement");
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
          await instance.session.appendMessage({
            id: "historical-user-message",
            parts: [{ text: "Keep this history", type: "text" }],
            role: "user",
          });
        }),
      );

      const firstReplacement = yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: initialSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId,
            routeId,
          }),
      );
      const repeatedReplacement = yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: initialSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId,
            routeId,
          }),
      );
      yield* Effect.promise(() => evictDurableObject(agent));
      const replayedInitialization = yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: initialSessionId,
          }),
      );
      const historicalReuse = yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: replacementSessionId,
            replacedAt: "2026-08-15T14:00:00.000Z",
            replacementSessionId: initialSessionId,
            routeId,
          }),
      );
      const route = yield* Effect.promise(async () => await agent.readRoute(routeId));
      const historicalSession = yield* Effect.promise(
        async () => await agent.readSession(initialSessionId),
      );

      expect(firstReplacement).toEqual({
        _tag: "CurrentSessionReplaced",
        currentSessionId: "session-replacement",
        historicalSessionId: "session-initial",
        routeId: "route-history",
      });
      expect(repeatedReplacement).toEqual(firstReplacement);
      expect(replayedInitialization).toEqual({
        _tag: "AgentInitialized",
        agentId: "agent-route-history",
        currentSessionId: "session-replacement",
        routeId: "route-history",
      });
      expect(historicalReuse).toMatchObject({
        _tag: "CurrentSessionReplacementConflict",
        replacementOwnerRouteId: "route-history",
      });
      expect(route).toEqual({
        _tag: "ConversationRouteFound",
        currentSessionId: "session-replacement",
        historicalSessionIds: ["session-initial"],
        routeId: "route-history",
      });
      expect(historicalSession).toEqual({
        _tag: "SessionHistoryFound",
        messages: [
          {
            id: "historical-user-message",
            parts: [{ text: "Keep this history", type: "text" }],
            role: "user",
          },
        ],
        sessionId: "session-initial",
      });
    }),
  );

  it.effect("enforces Agent-local ownership and idempotency invariants in SQLite", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-database-invariants");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-database-invariants",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-database-invariants");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-database-invariants");
      const otherAgentId = Schema.decodeUnknownSync(AgentId)("other-agent");
      const otherInitializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("other-initialization");
      const secondaryRouteId = Schema.decodeUnknownSync(ConversationRouteId)("secondary-route");
      const missingRouteId = Schema.decodeUnknownSync(ConversationRouteId)("missing-route");
      const secondarySessionId = Schema.decodeUnknownSync(SessionId)("secondary-current");
      const secondCurrentSessionId = Schema.decodeUnknownSync(SessionId)("second-current");
      const orphanSessionId = Schema.decodeUnknownSync(SessionId)("orphan-session");
      const initializedAt = Schema.decodeUnknownSync(DbTimestamp)("2026-08-15T12:00:00.000Z");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00Z",
            routeId,
            sessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const db = makeAgentDb(state.storage);
          expect(() =>
            db
              .insert(agentInitialization)
              .values({
                agentId: otherAgentId,
                initialRouteId: routeId,
                initialSessionId: sessionId,
                initializationId: otherInitializationId,
                initializedAt,
                singletonKey: "agent",
              })
              .run(),
          ).toThrow(/constraint/i);
          expect(
            db
              .select({ routeId: conversationRoutes.routeId })
              .from(conversationRoutes)
              .where(eq(conversationRoutes.isPrimary, true))
              .all(),
          ).toHaveLength(1);
          expect(
            db
              .select({ sessionId: sessionOwnership.sessionId })
              .from(sessionOwnership)
              .where(
                and(eq(sessionOwnership.routeId, routeId), isNull(sessionOwnership.replacedAt)),
              )
              .all(),
          ).toHaveLength(1);
          expect(() =>
            db
              .insert(conversationRoutes)
              .values({ isPrimary: true, routeId: secondaryRouteId })
              .run(),
          ).toThrow(/constraint/i);

          db.insert(conversationRoutes)
            .values({ isPrimary: false, routeId: secondaryRouteId })
            .run();
          db.insert(sessionOwnership)
            .values({
              becameCurrentAt: initializedAt,
              replacedAt: null,
              routeId: secondaryRouteId,
              sessionId: secondarySessionId,
            })
            .run();
          expect(() =>
            db
              .insert(sessionOwnership)
              .values({
                becameCurrentAt: initializedAt,
                replacedAt: null,
                routeId: secondaryRouteId,
                sessionId: secondCurrentSessionId,
              })
              .run(),
          ).toThrow(/constraint/i);
          expect(() =>
            db
              .insert(sessionOwnership)
              .values({
                becameCurrentAt: initializedAt,
                replacedAt: null,
                routeId: missingRouteId,
                sessionId: orphanSessionId,
              })
              .run(),
          ).toThrow(/constraint/i);

          db.insert(committedTurns)
            .values({
              assistantMessageId: AssistantMessageId.make("assistant-one"),
              sessionId,
              source: "hook",
              thinkRequestId: ThinkRequestId.make("stable-think-request"),
            })
            .run();
          expect(() =>
            db
              .insert(committedTurns)
              .values({
                assistantMessageId: AssistantMessageId.make("assistant-two"),
                sessionId,
                source: "hook",
                thinkRequestId: ThinkRequestId.make("stable-think-request"),
              })
              .run(),
          ).toThrow(/constraint/i);
        }),
      );
    }),
  );

  it.effect("reads canonical conversation history from the owned Think Session", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-canonical-read");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-canonical-read");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-canonical-read");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-canonical-read");
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
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.session.appendMessage({
            id: "message-user",
            parts: [{ text: "Hello Osfo", type: "text" }],
            role: "user",
          });
          await instance.session.appendMessage({
            id: "message-assistant",
            parts: [{ text: "Hello back", type: "text" }],
            role: "assistant",
          });
        }),
      );

      const read = yield* Effect.promise(async () => await agent.readSession(sessionId));

      expect(read).toEqual({
        _tag: "SessionHistoryFound",
        messages: [
          {
            id: "message-user",
            parts: [{ text: "Hello Osfo", type: "text" }],
            role: "user",
          },
          {
            id: "message-assistant",
            parts: [{ text: "Hello back", type: "text" }],
            role: "assistant",
          },
        ],
        sessionId: "session-canonical-read",
      });
    }),
  );

  it.effect("assigns and preserves committed-turn observation order through the hook", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-committed-hook");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-committed-hook");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-committed-hook");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-committed-hook");
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
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          const completed = {
            continuation: false,
            message: {
              id: "assistant-z-first",
              parts: [{ text: "Committed response", type: "text" as const }],
              role: "assistant" as const,
            },
            requestId: "think-request-completed",
            status: "completed" as const,
          };
          await instance.session.appendMessage(completed.message);
          await instance.onChatResponse(completed);
          const second = {
            ...completed,
            message: { ...completed.message, id: "assistant-a-second" },
            requestId: "think-request-second",
          };
          await instance.session.appendMessage(second.message);
          await instance.onChatResponse(second);
          await instance.onChatResponse(completed);
          await instance.onChatResponse({
            ...completed,
            message: { ...completed.message, id: "assistant-aborted" },
            requestId: "think-request-aborted",
            status: "aborted",
          });
        }),
      );

      const turns = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(turns).toEqual([
        {
          assistantMessageId: "assistant-z-first",
          observationSequence: 1,
          observedAt: expect.any(String),
          sessionId: "session-committed-hook",
          source: "hook",
          thinkRequestId: "think-request-completed",
        },
        {
          assistantMessageId: "assistant-a-second",
          observationSequence: 2,
          observedAt: expect.any(String),
          sessionId: "session-committed-hook",
          source: "hook",
          thinkRequestId: "think-request-second",
        },
      ]);
    }),
  );

  it.effect("records a delayed hook against the Think Session that owns its message", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-delayed-hook");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)("init-delayed-hook");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-delayed-hook");
      const originalSessionId = Schema.decodeUnknownSync(SessionId)("session-delayed-original");
      const replacementSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-delayed-replacement",
      );
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: originalSessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.session.appendMessage({
            id: "assistant-delayed-hook",
            parts: [{ text: "Committed before replacement", type: "text" }],
            role: "assistant",
          });
          await instance.session.appendMessage(
            {
              id: "user-new-active-branch",
              parts: [{ text: "Start another branch", type: "text" }],
              role: "user",
            },
            null,
          );
        }),
      );
      yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: originalSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId,
            routeId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.onChatResponse({
            continuation: false,
            message: {
              id: "assistant-delayed-hook",
              parts: [{ text: "Committed before replacement", type: "text" }],
              role: "assistant",
            },
            requestId: "think-request-delayed-hook",
            status: "completed",
          });
        }),
      );

      const turns = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(turns).toEqual([
        {
          assistantMessageId: "assistant-delayed-hook",
          observationSequence: 1,
          observedAt: expect.any(String),
          sessionId: "session-delayed-original",
          source: "hook",
          thinkRequestId: "think-request-delayed-hook",
        },
      ]);
    }),
  );

  it.effect("reconciles Sessions and Think history messages in deterministic order", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-turn-reconciliation");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-turn-reconciliation",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-turn-reconciliation");
      const firstSessionId = Schema.decodeUnknownSync(SessionId)("session-turn-first");
      const secondSessionId = Schema.decodeUnknownSync(SessionId)("session-turn-second");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00Z",
            routeId,
            sessionId: firstSessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          for (const id of ["assistant-z-first", "assistant-a-second"]) {
            await instance.session.appendMessage({
              id,
              parts: [{ text: id, type: "text" }],
              role: "assistant",
            });
          }
        }),
      );
      yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: firstSessionId,
            replacedAt: "2026-08-15T12:00:00.1Z",
            replacementSessionId: secondSessionId,
            routeId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          for (const id of ["assistant-m-third", "assistant-b-fourth"]) {
            await instance.session.appendMessage({
              id,
              parts: [{ text: id, type: "text" }],
              role: "assistant",
            });
          }
        }),
      );
      yield* Effect.promise(() => evictDurableObject(agent));

      const firstActivation = yield* Effect.promise(async () => await agent.readCommittedTurns());
      yield* Effect.promise(() => evictDurableObject(agent));
      const secondActivation = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(firstActivation).toEqual([
        {
          assistantMessageId: "assistant-z-first",
          observationSequence: 1,
          observedAt: expect.any(String),
          sessionId: "session-turn-first",
          source: "reconciliation",
          thinkRequestId: null,
        },
        {
          assistantMessageId: "assistant-a-second",
          observationSequence: 2,
          observedAt: expect.any(String),
          sessionId: "session-turn-first",
          source: "reconciliation",
          thinkRequestId: null,
        },
        {
          assistantMessageId: "assistant-m-third",
          observationSequence: 3,
          observedAt: expect.any(String),
          sessionId: "session-turn-second",
          source: "reconciliation",
          thinkRequestId: null,
        },
        {
          assistantMessageId: "assistant-b-fourth",
          observationSequence: 4,
          observedAt: expect.any(String),
          sessionId: "session-turn-second",
          source: "reconciliation",
          thinkRequestId: null,
        },
      ]);
      expect(secondActivation).toEqual(firstActivation);
    }),
  );

  it.effect("enriches a reconciled receipt without changing its observation identity", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-turn-enrichment");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-turn-enrichment");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-turn-enrichment");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-turn-enrichment");
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
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.session.appendMessage({
            id: "assistant-enriched",
            parts: [{ text: "Recovered response", type: "text" }],
            role: "assistant",
          });
        }),
      );
      const reconciled = yield* Effect.promise(async () => await agent.readCommittedTurns());

      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.onChatResponse({
            continuation: false,
            message: {
              id: "assistant-enriched",
              parts: [{ text: "Recovered response", type: "text" }],
              role: "assistant",
            },
            requestId: "think-request-enriched",
            status: "completed",
          });
        }),
      );
      const enriched = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(reconciled).toHaveLength(1);
      const reconciledReceipt = Array.isArray(reconciled) ? reconciled[0] : undefined;
      expect(enriched).toEqual([
        {
          assistantMessageId: "assistant-enriched",
          observationSequence: reconciledReceipt?.observationSequence,
          observedAt: reconciledReceipt?.observedAt,
          sessionId: "session-turn-enrichment",
          source: "hook",
          thinkRequestId: "think-request-enriched",
        },
      ]);
    }),
  );

  it.effect("returns typed conflicts for incompatible committed-turn identities", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-turn-conflicts");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-turn-conflicts");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-turn-conflicts");
      const firstSessionId = Schema.decodeUnknownSync(SessionId)("session-conflict-first");
      const secondSessionId = Schema.decodeUnknownSync(SessionId)("session-conflict-second");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: firstSessionId,
          }),
      );
      yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: firstSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId: secondSessionId,
            routeId,
          }),
      );

      const conflicts = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const store = makeAgentStore(makeAgentDb(state.storage));
          await Effect.runPromise(
            store.recordCommittedTurn({
              assistantMessageId: AssistantMessageId.make("assistant-stable-identity"),
              sessionId: firstSessionId,
              source: "hook",
              thinkRequestId: ThinkRequestId.make("think-request-stable-identity"),
            }),
          );
          const sessionConflict = await Effect.runPromise(
            Effect.flip(
              store.recordCommittedTurn({
                assistantMessageId: AssistantMessageId.make("assistant-stable-identity"),
                sessionId: secondSessionId,
                source: "reconciliation",
                thinkRequestId: null,
              }),
            ),
          );
          const requestConflict = await Effect.runPromise(
            Effect.flip(
              store.recordCommittedTurn({
                assistantMessageId: AssistantMessageId.make("assistant-conflicting-identity"),
                sessionId: secondSessionId,
                source: "hook",
                thinkRequestId: ThinkRequestId.make("think-request-stable-identity"),
              }),
            ),
          );
          return { requestConflict, sessionConflict };
        }),
      );

      expect(conflicts.sessionConflict).toMatchObject({
        _tag: "CommittedTurnConflict",
        existingAssistantMessageId: "assistant-stable-identity",
        existingSessionId: "session-conflict-first",
        existingThinkRequestId: "think-request-stable-identity",
        message: "The assistant message is already observed for another Session",
      });
      expect(conflicts.requestConflict).toMatchObject({
        _tag: "CommittedTurnConflict",
        existingAssistantMessageId: "assistant-stable-identity",
        existingSessionId: "session-conflict-first",
        existingThinkRequestId: "think-request-stable-identity",
        message: "The Think request is already observed for another assistant message",
      });
    }),
  );

  it.effect("fails with a typed store error for an invalid committed-turn timestamp", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-invalid-observed-at");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-invalid-observed-at",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-invalid-observed-at");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-invalid-observed-at");
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
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const db = makeAgentDb(state.storage);
          db.insert(committedTurns)
            .values({
              assistantMessageId: AssistantMessageId.make("assistant-invalid-observed-at"),
              sessionId,
              source: "reconciliation",
              thinkRequestId: null,
            })
            .run();
          db.update(committedTurns)
            .set({ observedAt: "not-a-sqlite-timestamp" })
            .where(
              eq(
                committedTurns.assistantMessageId,
                AssistantMessageId.make("assistant-invalid-observed-at"),
              ),
            )
            .run();
        }),
      );

      const read = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(read).toMatchObject({
        _tag: "AgentStoreRecordInvalid",
        operation: "readCommittedTurns",
      });
    }),
  );

  it.effect("migrates every synthetic Agent SQLite source version and repeats safely", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-source-versions");
      const reports = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const observed = [];
          for (
            let sourceVersion = 0;
            sourceVersion <= syntheticMigrations.length;
            sourceVersion++
          ) {
            resetOsfoTables(state.storage);
            state.storage.sql.exec("DROP TABLE IF EXISTS synthetic_agent_state");
            const source = await Effect.runPromise(
              applyMigrationChain(state.storage, syntheticMigrations.slice(0, sourceVersion)),
            );
            const upgraded = await Effect.runPromise(
              applyMigrationChain(state.storage, syntheticMigrations),
            );
            const repeated = await Effect.runPromise(
              applyMigrationChain(state.storage, syntheticMigrations),
            );
            observed.push({ repeated, source, sourceVersion, upgraded });
          }
          return observed;
        }),
      );

      for (const report of reports) {
        expect(report.source.currentVersion).toBe(report.sourceVersion);
        expect(report.upgraded.appliedVersions).toEqual(
          syntheticMigrations.slice(report.sourceVersion).map(({ version }) => version),
        );
        expect(report.repeated).toEqual({
          appliedVersions: [],
          currentVersion: syntheticMigrations.length,
        });
      }
    }),
  );

  it.effect("rolls back an interrupted migration and retries it safely", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-interruption");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          state.storage.sql.exec("CREATE TABLE osfo_committed_turns (blocked TEXT) STRICT");

          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, agentMigrations)),
          );
          const initializationTableAfterFailure = state.storage.sql
            .exec<Record<string, SqlStorageValue>>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'osfo_agent_initialization'",
            )
            .toArray();

          state.storage.sql.exec("DROP TABLE osfo_committed_turns");
          const retry = await Effect.runPromise(
            applyMigrationChain(state.storage, agentMigrations),
          );
          return {
            failureTag: failure._tag,
            failureVersion: failure.version,
            retry,
            initializationTableAfterFailure,
          };
        }),
      );

      expect(observed).toEqual({
        failureTag: "AgentMigrationFailed",
        failureVersion: 1,
        initializationTableAfterFailure: [],
        retry: {
          appliedVersions: agentMigrations.map(({ version }) => version),
          currentVersion: agentMigrations.length,
        },
      });
    }),
  );

  it.effect("fails closed when an applied migration digest changes", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-digest");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          await Effect.runPromise(applyMigrationChain(state.storage, agentMigrations));
          state.storage.sql.exec(
            "UPDATE osfo_schema_migrations SET digest = ? WHERE version = ?",
            "sha256:changed-after-application",
            1,
          );

          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, agentMigrations)),
          );
          return {
            actualDigest:
              failure._tag === "AgentMigrationDigestMismatch" ? failure.actualDigest : undefined,
            failureTag: failure._tag,
            failureVersion: failure.version,
          };
        }),
      );

      expect(observed).toEqual({
        actualDigest: "sha256:changed-after-application",
        failureTag: "AgentMigrationDigestMismatch",
        failureVersion: 1,
      });
    }),
  );

  it.effect("rejects generated migration SQL that does not match its manifest digest", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-definition-digest");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          const changed = agentMigrations.map((migration) => ({
            ...migration,
            sql: `${migration.sql}\nSELECT 1;`,
          }));
          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, changed)),
          );
          const ledger = state.storage.sql
            .exec<Record<string, SqlStorageValue>>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'osfo_schema_migrations'",
            )
            .toArray();
          return { failureTag: failure._tag, ledger };
        }),
      );

      expect(observed).toEqual({ failureTag: "AgentMigrationDefinitionMismatch", ledger: [] });
    }),
  );

  it.effect("fails closed when Agent SQLite contains an unsupported future version", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-future-version");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          state.storage.sql.exec(`CREATE TABLE osfo_schema_migrations (
            version INTEGER PRIMARY KEY,
            digest TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT`);
          state.storage.sql.exec(
            "INSERT INTO osfo_schema_migrations (version, digest) VALUES (?, ?)",
            agentMigrations.length + 1,
            "sha256:future-release",
          );
          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, agentMigrations)),
          );
          return { failureTag: failure._tag, failureVersion: failure.version };
        }),
      );

      expect(observed).toEqual({
        failureTag: "AgentMigrationHistoryUnsupported",
        failureVersion: agentMigrations.length + 1,
      });
    }),
  );

  it.effect("leaves all Think-owned tables unchanged during Osfo migration", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-think-isolation");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          const before = readNonOsfoTableDefinitions(state.storage);
          await Effect.runPromise(applyMigrationChain(state.storage, agentMigrations));
          return { after: readNonOsfoTableDefinitions(state.storage), before };
        }),
      );

      expect(observed.after).toEqual(observed.before);
      expect(observed.before.length).toBeGreaterThan(0);
    }),
  );
});

const resetOsfoTables = (storage: DurableObjectStorage): void => {
  storage.sql.exec("DROP TABLE IF EXISTS osfo_model_call_usage_evidence");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_committed_turns");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_session_ownership");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_conversation_routes");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_agent_initialization");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_schema_migrations");
};

const readNonOsfoTableDefinitions = (
  storage: DurableObjectStorage,
): ReadonlyArray<Record<string, SqlStorageValue>> =>
  storage.sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'osfo_%' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .toArray();

const syntheticMigrations: ReadonlyArray<AgentMigration> = [
  {
    digest: "sha256:789ea8ca6fb02be481041b135659dbb205327d4015c228a8c4c7c9b16fab3f1e",
    sql: "CREATE TABLE synthetic_agent_state (id INTEGER PRIMARY KEY) STRICT",
    version: 1,
  },
  {
    digest: "sha256:5a3b7e272697e0395811e8706a0c277d7dd15b8ee82c1be1114bfc94e39f9804",
    sql: "ALTER TABLE synthetic_agent_state ADD COLUMN value TEXT",
    version: 2,
  },
  {
    digest: "sha256:7b8866281e4b0cc27e6945617130a048e1e6f6cb476b7c3c25e5421ebdea90dd",
    sql: "CREATE INDEX synthetic_agent_state_value ON synthetic_agent_state(value)",
    version: 3,
  },
];

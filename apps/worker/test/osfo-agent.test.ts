import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Session } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { getAgentByName } from "agents";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import {
  AgentId,
  AgentInitializationId,
  AcceptanceReceiptId,
  AllowancePeriodId,
  AssistantMessageId,
  ChannelBindingId,
  ConversationRouteId,
  PlanPolicyVersion,
  ProviderMessageId,
  SessionId,
  ThinkSubmissionId,
  ThinkRequestId,
  UserId,
  UserMessageId,
} from "../src/domain";
import { ManagedTurnMetadata } from "../src/domain/managed-conversation";
import { ModelCallAttemptId } from "../src/domain/model-call-attempt";
import { DbTimestamp } from "../src/db";
import { makeAgentDb } from "../src/agents/osfo/db/client";
import {
  agentMigrations,
  type AgentMigration,
  applyMigrationChain,
} from "../src/agents/osfo/db/migrate";
import { makeAgentStore } from "../src/agents/osfo/db/store";
import { coreMemoryClearActionName } from "../src/agents/osfo/action-registry";
import type { OsfoAgent } from "../src/agents/osfo/agent";
import { ActionPresentationId } from "../src/agents/osfo/think-action-approvals";
import {
  currentTestAuthorization,
  testProtectedActionUserId,
} from "../src/agents/osfo/test-protected-action";
import { coreMemoryTools } from "../src/agents/osfo/core-memory";
import {
  AuthorizationContext,
  snapshotCoreMemoryAuthorization,
} from "../src/services/authorization";
import { CoreMemoryAuthorizationSnapshot } from "../src/domain/core-memory-authorization";
import { currentPolicy } from "../src/domain/plan-policy";
import { launchModelAccessPolicy } from "../src/domain/model-access-policy";
import {
  agentInitialization,
  committedTurns,
  conversationRoutes,
  sessionOwnership,
} from "../src/agents/osfo/db/schema";
import { admitManagedConversation } from "../src/services/managed-conversation";
import { replaceOwnedSession } from "./support/session-store";

/* oxlint-disable effecttsgo/async-function, effecttsgo/prefer-typed-schema-decoder, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect, eslint/no-await-in-loop, eslint/no-underscore-dangle, osfo/no-chained-type-assertions, osfo/no-unknown-parameters, osfo/no-unknown-returns, typescript/await-thenable, typescript/no-unsafe-type-assertion -- Worker integration tests cross Promise, RPC, Effect, Think's private Action compiler, and raw SQLite test boundaries. */

describe("Osfo Agent and Think Session foundation", () => {
  it.effect("starts the first turn with empty independently bounded Core Memory blocks", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("first-turn");

      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "first-turn"));

      expect(memory).toEqual({
        _tag: "CoreMemoryInspected",
        agentNotes: { content: "", maxTokens: 800, tokens: 0 },
        userContext: { content: "", maxTokens: 1_200, tokens: 0 },
      });
    }),
  );

  it.effect("applies a User correction immediately and keeps Core Memory across Sessions", () =>
    Effect.gen(function* () {
      const {
        agent,
        routeId,
        sessionId: initialSessionId,
      } = yield* initializeCoreMemoryAgent("correction");
      const replacementSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-core-memory-correction-replacement",
      );

      yield* Effect.promise(async () =>
        correctAgentMemory(agent, "correction-long", {
          block: "userContext",
          content: "The User prefers long replies.",
        }),
      );
      yield* Effect.promise(async () =>
        correctAgentMemory(agent, "correction-notes", {
          block: "agentNotes",
          content: "Commitment: send the itinerary on Friday.",
        }),
      );
      const corrected = yield* Effect.promise(async () =>
        correctAgentMemory(agent, "correction-concise", {
          block: "userContext",
          content: "The User prefers concise replies.",
        }),
      );
      yield* Effect.promise(async () =>
        replaceOwnedSession(agent, {
          expectedCurrentSessionId: initialSessionId,
          replacedAt: "2026-08-15T13:00:00.000Z",
          replacementSessionId,
          routeId,
        }),
      );
      yield* Effect.promise(() => evictDurableObject(agent));
      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "correction-inspect"));

      expect(corrected).toMatchObject({
        _tag: "CoreMemoryCorrected",
        block: "userContext",
        content: "The User prefers concise replies.",
      });
      expect(memory).toMatchObject({
        _tag: "CoreMemoryInspected",
        agentNotes: { content: "Commitment: send the itinerary on Friday." },
        userContext: { content: "The User prefers concise replies." },
      });
    }),
  );

  it.effect("keeps a direct User correction authoritative for sensitive facts", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("sensitive-correction");
      const corrected = yield* Effect.promise(async () =>
        correctAgentMemory(agent, "sensitive-correction", {
          block: "userContext",
          content: "I have medical debt.",
        }),
      );
      const memory = yield* Effect.promise(() =>
        inspectAgentMemory(agent, "sensitive-correction-proof"),
      );

      expect(corrected).toMatchObject({
        _tag: "CoreMemoryCorrected",
        content: "I have medical debt.",
      });
      expect(memory).toMatchObject({ userContext: { content: "I have medical debt." } });
    }),
  );

  it.effect("clears one Core Memory block without changing the other block", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("clear");
      yield* Effect.promise(async () =>
        correctAgentMemory(agent, "clear-user", {
          block: "userContext",
          content: "The User lives in Toronto.",
        }),
      );
      yield* Effect.promise(async () =>
        correctAgentMemory(agent, "clear-notes", {
          block: "agentNotes",
          content: "Goal: prepare the itinerary.",
        }),
      );

      const parked = yield* Effect.promise(() =>
        parkCoreMemoryClearAction(agent, "action-clear-user-context", "userContext"),
      );
      const beforeApproval = yield* Effect.promise(() => inspectAgentMemory(agent, "clear-before"));
      yield* Effect.promise(() => evictDurableObject(agent));
      const reactivated = yield* Effect.promise(
        async () => await getAgentByName(env.OSFO_AGENT, "agent-core-memory-clear"),
      );
      const actor = {
        _tag: "ChannelBinding" as const,
        channelBindingId: "test-protected-action-binding",
        userId: testProtectedActionUserId,
      };
      const presentationId = ActionPresentationId.make(parked.executionId);
      const presentation = yield* Effect.promise(async () =>
        reactivated.readActionPresentation({ actor, presentationId }),
      );
      const decided = yield* Effect.promise(async () =>
        reactivated.decideActionApproval({
          actor,
          authorization: approvalAuthorization("active"),
          decision: "approve",
          presentationId,
        }),
      );
      const memory = yield* Effect.promise(() => inspectAgentMemory(reactivated, "clear-after"));

      expect(parked).toMatchObject({ action: coreMemoryClearActionName, status: "paused" });
      expect(beforeApproval).toMatchObject({
        userContext: { content: "The User lives in Toronto." },
      });
      expect(presentation).toMatchObject({
        _tag: "ActionPresentationFound",
        presentation: {
          actionId: "action-clear-user-context",
          fields: [{ label: "Block", name: "block", value: "User Context" }],
          operation: "memory.clear",
          presentationId,
        },
      });
      expect(decided).toEqual({
        _tag: "ApprovalDecisionAccepted",
        decision: "approved",
        presentationId,
      });
      expect(memory).toMatchObject({
        _tag: "CoreMemoryInspected",
        agentNotes: { content: "Goal: prepare the itinerary." },
        userContext: { content: "", tokens: 0 },
      });
    }),
  );

  it.effect("denies Core Memory inspection and correction when authority is revoked", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("revoked-rpc");
      const authorization = revokedCoreMemoryAuthorization();

      const correction = yield* Effect.promise(
        async () =>
          await agent.correctCoreMemory({
            actionId: "revoked-correction",
            authorization,
            block: "userContext",
            content: "The User prefers hidden changes.",
          }),
      );
      const inspection = yield* Effect.promise(
        async () =>
          await agent.inspectCoreMemory({ actionId: "revoked-inspection", authorization }),
      );
      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "revoked-proof"));

      expect(correction).toMatchObject({ _tag: "Denied", reason: "authorityRevoked" });
      expect(inspection).toMatchObject({ _tag: "Denied", reason: "authorityRevoked" });
      expect(memory).toMatchObject({ userContext: { content: "" } });
    }),
  );

  it.effect("rechecks clear authority immediately before deletion", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("clear-recheck");
      yield* Effect.promise(async () =>
        correctAgentMemory(agent, "clear-recheck-correction", {
          block: "userContext",
          content: "The User lives in Ottawa.",
        }),
      );
      const parked = yield* Effect.promise(() =>
        parkCoreMemoryClearAction(agent, "action-clear-recheck", "userContext"),
      );
      const presentationId = ActionPresentationId.make(parked.executionId);
      const decision = yield* Effect.promise(
        async () =>
          await agent.decideActionApproval({
            actor: {
              _tag: "ChannelBinding",
              channelBindingId: "test-protected-action-binding",
              userId: testProtectedActionUserId,
            },
            authorization: approvalAuthorization("revoked"),
            decision: "approve",
            presentationId,
          }),
      );
      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "clear-recheck-proof"));

      expect(decision).toEqual({
        _tag: "ApprovalDecisionAccepted",
        decision: "approved",
        presentationId,
      });
      expect(memory).toMatchObject({
        userContext: { content: "The User lives in Ottawa." },
      });
    }),
  );

  it.effect("loads changed Core Memory into the next real model turn", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("next-turn");
      yield* Effect.promise(() =>
        correctAgentMemory(agent, "next-turn-correction", {
          block: "userContext",
          content: "The User prefers the name River.",
        }),
      );

      const turnSystem = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          const beforeTurn = instance.beforeTurn.bind(instance);
          let system: string | undefined;
          Object.defineProperty(instance, "beforeTurn", {
            value: async (...parameters: Parameters<typeof beforeTurn>) => {
              const config = await beforeTurn(...parameters);
              system = config.system;
              return config;
            },
          });
          Object.defineProperty(instance, "_streamResult", {
            value: async () => ({ status: "completed" }),
          });
          await instance.runTurn({
            input: {
              id: "next-turn-user",
              metadata: { turnMetadata: managedTurnMetadata("next-turn") },
              parts: [{ text: "What name should you use?", type: "text" }],
              role: "user",
            },
            mode: "wait",
          });
          return system;
        }),
      );

      expect(turnSystem).toContain("The User prefers the name River.");
    }),
  );

  it.effect("gives every turn proactive memory tools with inference and reasoning safeguards", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("policy");

      const context = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          const tools = coreMemoryTools(instance.session);
          const setContext = tools.set_context;
          if (setContext?.execute === undefined) {
            return {
              prompt: await instance.session.refreshSystemPrompt(),
              rejectedNamedSensitive: [],
              rejectedReasoning: null,
              rejectedSensitive: [],
              tools: [],
            };
          }
          const rejectedSensitive: Array<string | null> = [];
          const sensitiveContent = [
            "The User has cancer.",
            "The User is Muslim.",
            "The User is gay.",
            "The User is undocumented.",
            "The User is insolvent.",
          ];
          for (const [index, content] of sensitiveContent.entries()) {
            await setContext.execute(
              { action: "replace", block: "userContext", content },
              { context: {}, messages: [], toolCallId: `tool-core-memory-sensitive-${index}` },
            );
            await instance.session.refreshSystemPrompt();
            rejectedSensitive.push(
              instance.session.getContextBlock("User Context")?.content ?? null,
            );
          }
          await setContext.execute(
            {
              action: "replace",
              block: "agentNotes",
              content: "Reasoning: private chain-of-thought about the User.",
            },
            { context: {}, messages: [], toolCallId: "tool-core-memory-reasoning" },
          );
          await instance.session.refreshSystemPrompt();
          const rejectedReasoning =
            instance.session.getContextBlock("Agent Notes")?.content ?? null;
          const rejectedNamedSensitive: Array<string | null> = [];
          for (const [index, content] of [
            "River has cancer.",
            "River has debt.",
            "The financial report says River has debt.",
          ].entries()) {
            await setContext.execute(
              { action: "replace", block: "agentNotes", content },
              { context: {}, messages: [], toolCallId: `tool-core-memory-named-${index}` },
            );
            await instance.session.refreshSystemPrompt();
            rejectedNamedSensitive.push(
              instance.session.getContextBlock("Agent Notes")?.content ?? null,
            );
          }
          const safeAgentNotes = [
            "Review the quarterly financial results.",
            "Monitor database health.",
            "Vote on the release proposal.",
            "Use conservative backoff.",
          ].join("\n");
          await setContext.execute(
            { action: "replace", block: "agentNotes", content: safeAgentNotes },
            { context: {}, messages: [], toolCallId: "tool-core-memory-safe-agent-notes" },
          );
          await setContext.execute(
            {
              action: "replace",
              block: "userContext",
              content: "The User prefers calendar times in Eastern Time.",
            },
            { context: {}, messages: [], toolCallId: "tool-core-memory-proactive" },
          );
          return {
            prompt: await instance.session.refreshSystemPrompt(),
            rejectedNamedSensitive,
            rejectedReasoning,
            rejectedSensitive,
            tools: Object.keys(tools),
          };
        }),
      );
      yield* Effect.promise(() => evictDurableObject(agent));
      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "policy-inspect"));

      expect(context.tools).toContain("set_context");
      expect(context.rejectedNamedSensitive).toEqual(["", "", ""]);
      expect(context.rejectedReasoning).toBe("");
      expect(context.rejectedSensitive).toEqual(["", "", "", "", ""]);
      expect(context.prompt).toContain("Proactively keep only narrow durable User facts");
      expect(context.prompt).toContain("require strong direct evidence or User confirmation");
      expect(context.prompt).toContain("Never store hidden reasoning, chain-of-thought");
      expect(context.prompt).toContain("Store the narrowest durable conclusion");
      expect(memory).toMatchObject({
        agentNotes: {
          content:
            "Review the quarterly financial results.\nMonitor database health.\nVote on the release proposal.\nUse conservative backoff.",
        },
        userContext: { content: "The User prefers calendar times in Eastern Time." },
      });
    }),
  );

  it.effect("enforces each Core Memory block budget independently", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("budgets");
      const content = "fact ".repeat(690).trim();

      const agentNotes = yield* Effect.promise(async () =>
        correctAgentMemory(agent, "budget-notes", { block: "agentNotes", content }),
      );
      const userContext = yield* Effect.promise(async () =>
        correctAgentMemory(agent, "budget-user", { block: "userContext", content }),
      );
      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "budget-inspect"));

      expect(agentNotes).toMatchObject({
        _tag: "CoreMemoryBudgetExceeded",
        block: "agentNotes",
        maxTokens: 800,
      });
      expect(userContext).toMatchObject({
        _tag: "CoreMemoryCorrected",
        block: "userContext",
        maxTokens: 1_200,
      });
      expect(memory).toMatchObject({
        agentNotes: { content: "", tokens: 0 },
        userContext: { content },
      });
    }),
  );

  it.effect("persists independent User-selected Core Memory bounds", () =>
    Effect.gen(function* () {
      const { agent } = yield* initializeCoreMemoryAgent("user-bounds");

      yield* Effect.promise(async () =>
        boundAgentMemory(agent, "bound-user", { block: "userContext", maxTokens: 900 }),
      );
      yield* Effect.promise(async () =>
        boundAgentMemory(agent, "bound-notes", { block: "agentNotes", maxTokens: 400 }),
      );
      const overBound = yield* Effect.promise(async () =>
        correctAgentMemory(agent, "bound-over", {
          block: "agentNotes",
          content: "fact ".repeat(350).trim(),
        }),
      );
      yield* Effect.promise(() => evictDurableObject(agent));
      const memory = yield* Effect.promise(() => inspectAgentMemory(agent, "bound-inspect"));

      expect(memory).toMatchObject({
        _tag: "CoreMemoryInspected",
        agentNotes: { maxTokens: 400 },
        userContext: { maxTokens: 900 },
      });
      expect(overBound).toMatchObject({
        _tag: "CoreMemoryBudgetExceeded",
        block: "agentNotes",
        maxTokens: 400,
      });
    }),
  );

  it.effect("exposes bounded document generation through the Agent ToolCall boundary", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(AgentId.make("agent-document-tools"));
      const registered = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) =>
          Promise.resolve({
            actions: Object.keys(instance.getActions()),
            tools: Object.keys(instance.getTools()),
          }),
        ),
      );

      expect(registered.actions).toContain("generateDocument");
      expect(registered.actions).toContain("deleteDocument");
      expect(registered.tools).toContain("exportDocument");
    }),
  );

  it.effect("identifies malformed WhatsApp recovery RPC input", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(AgentId.make("agent-invalid-whatsapp-recovery"));
      const invalid = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          // @ts-expect-error Test the public RPC decoder with a malformed wire value.
          return await instance.recoverWhatsAppMessage({});
        }),
      );

      expect(invalid).toMatchObject({
        _tag: "AgentRequestInvalid",
        message: "The Agent RPC input is invalid",
        operation: "recoverWhatsAppMessage",
      });
    }),
  );

  it.effect("recovers Telegram acceptance in the established canonical Session", () =>
    Effect.gen(function* () {
      const agentId = AgentId.make("agent-telegram-acceptance");
      const channelBindingId = ChannelBindingId.make("binding-telegram-acceptance");
      const sessionId = SessionId.make("session-telegram-canonical");
      const agent = env.OSFO_AGENT.getByName(agentId);
      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId: "init-telegram-acceptance",
            initializedAt: "2026-08-17T00:00:00.000Z",
            routeId: "route-telegram-acceptance",
            sessionId,
          }),
      );
      const input = {
        channelBindingId,
        message: "Plan my day",
        providerMessageId: "telegram-update-9001",
        receiptId: "receipt-telegram-acceptance",
        submissionId: "submission-telegram-acceptance",
        userMessageId: "message-telegram-acceptance",
      } as const;
      const receipt = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance, state) => {
          state.storage.sql.exec(
            `INSERT INTO osfo_acceptance_receipts
              (allowance_period_id, channel_binding_id, provider_message_id, receipt_id,
               session_id, think_submission_id, user_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            "period-telegram-acceptance",
            channelBindingId,
            input.providerMessageId,
            input.receiptId,
            sessionId,
            input.submissionId,
            input.userMessageId,
          );
          return await instance.acceptTelegramMessage(input);
        }),
      );

      expect(receipt).toMatchObject({
        _tag: "AcceptanceReceipt",
        channelBindingId,
        providerMessageId: input.providerMessageId,
        sessionId,
        thinkSubmissionId: input.submissionId,
      });
    }),
  );

  it.effect("returns the exact Acceptance Receipt when one WhatsApp message is replayed", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-whatsapp-acceptance");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-whatsapp-acceptance",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-whatsapp-acceptance");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-whatsapp-acceptance");
      const channelBindingId = Schema.decodeUnknownSync(ChannelBindingId)(
        "binding-whatsapp-acceptance",
      );
      const agent = env.OSFO_AGENT.getByName(agentId);
      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-16T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );

      const input = {
        channelBindingId,
        message: "Please help with my schedule",
        providerMessageId: "wamid.whatsapp-acceptance",
        receiptId: "receipt-whatsapp-acceptance",
        submissionId: "submission-whatsapp-acceptance",
        userMessageId: "message-whatsapp-acceptance",
      } as const;
      const results = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance, state) => {
          state.storage.sql.exec(
            `INSERT INTO osfo_acceptance_receipts
              (allowance_period_id, channel_binding_id, provider_message_id, receipt_id,
               session_id, think_submission_id, user_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            "period-whatsapp-acceptance",
            channelBindingId,
            input.providerMessageId,
            input.receiptId,
            sessionId,
            input.submissionId,
            input.userMessageId,
          );
          const first = await instance.acceptWhatsAppMessage(input);
          const repeated = await instance.acceptWhatsAppMessage(input);
          const conflict = await instance.acceptWhatsAppMessage({
            ...input,
            userMessageId: "message-whatsapp-conflict",
          });
          return { conflict, first, repeated };
        }),
      );

      expect(results.repeated).toEqual(results.first);
      expect(results.first).toEqual({
        _tag: "AcceptanceReceipt",
        acceptedAt: expect.any(String),
        allowancePeriodId: "period-whatsapp-acceptance",
        channelBindingId,
        providerMessageId: "wamid.whatsapp-acceptance",
        receiptId: "receipt-whatsapp-acceptance",
        sessionId,
        thinkSubmissionId: "submission-whatsapp-acceptance",
        userMessageId: "message-whatsapp-acceptance",
      });
      expect(results.conflict).toMatchObject({
        _tag: "AcceptanceReceiptConflict",
        existingUserMessageId: "message-whatsapp-acceptance",
        userMessageId: "message-whatsapp-conflict",
      });
    }),
  );

  it.effect("atomically replaces the current Session with one immutable command receipt", () =>
    Effect.gen(function* () {
      const agentId = AgentId.make("agent-command-receipt-atomic");
      const routeId = ConversationRouteId.make("route-command-receipt-atomic");
      const initialSessionId = SessionId.make("session-command-receipt-initial");
      const replacementSessionId = SessionId.make("session-command-receipt-replacement");
      const agent = env.OSFO_AGENT.getByName(agentId);
      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId: AgentInitializationId.make("init-command-receipt-atomic"),
            initializedAt: "2026-08-16T12:00:00.000Z",
            routeId,
            sessionId: initialSessionId,
          }),
      );

      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const store = makeAgentStore(makeAgentDb(state.storage));
          const input = {
            expectedCurrentSessionId: initialSessionId,
            receipt: {
              allowancePeriodId: AllowancePeriodId.make("period-command-receipt"),
              channelBindingId: ChannelBindingId.make("binding-command-receipt"),
              command: "/new" as const,
              providerMessageId: ProviderMessageId.make("provider-command-receipt"),
              receiptId: Schema.decodeUnknownSync(AcceptanceReceiptId)("receipt-command-receipt"),
              userMessageId: UserMessageId.make("message-command-receipt"),
            },
            replacedAt: DbTimestamp.make("2026-08-16T12:01:00.000Z"),
            replacementSessionId,
            routeId,
          };
          const [first, replay] = await Promise.all([
            Effect.runPromise(store.replaceCurrentSessionWithCommandReceipt(input)),
            Effect.runPromise(store.replaceCurrentSessionWithCommandReceipt(input)),
          ]);
          const conflict = await Effect.runPromise(
            Effect.flip(
              store.replaceCurrentSessionWithCommandReceipt({
                ...input,
                receipt: {
                  ...input.receipt,
                  userMessageId: UserMessageId.make("message-command-receipt-conflict"),
                },
              }),
            ),
          );
          const replacementConflict = await Effect.runPromise(
            Effect.flip(
              store.replaceCurrentSessionWithCommandReceipt({
                ...input,
                replacementSessionId: SessionId.make("session-command-receipt-changed"),
              }),
            ),
          );
          const route = await Effect.runPromise(store.readRoute(routeId));
          return { conflict, first, replacementConflict, replay, route };
        }),
      );

      expect(observed.replay).toEqual(observed.first);
      expect(observed.first).toMatchObject({
        _tag: "SessionCommandReceipt",
        currentSessionId: replacementSessionId,
        historicalSessionId: initialSessionId,
      });
      expect(observed.conflict).toMatchObject({ _tag: "SessionCommandReceiptConflict" });
      expect(observed.replacementConflict).toMatchObject({
        _tag: "SessionCommandReceiptConflict",
        existingReplacementSessionId: replacementSessionId,
        requestedReplacementSessionId: "session-command-receipt-changed",
      });
      expect(observed.route).toMatchObject({
        currentSessionId: replacementSessionId,
        historicalSessionIds: [initialSessionId],
      });
    }),
  );

  it.effect("recovers a real Think acceptance into one SQLite Acceptance Receipt", () =>
    Effect.gen(function* () {
      const agentId = AgentId.make("agent-whatsapp-think-recovery");
      const channelBindingId = ChannelBindingId.make("binding-whatsapp-think-recovery");
      const routeId = ConversationRouteId.make("route-whatsapp-think-recovery");
      const sessionId = SessionId.make("session-whatsapp-think-recovery");
      const submissionId = ThinkSubmissionId.make("submission-whatsapp-think-recovery");
      const providerMessageId = ProviderMessageId.make("wamid.whatsapp-think-recovery");
      const userMessageId = UserMessageId.make("message-whatsapp-think-recovery");
      const receiptId = "receipt-whatsapp-think-recovery";
      const agent = env.OSFO_AGENT.getByName(agentId);
      const authorization = yield* Schema.decodeUnknownEffect(AuthorizationContext)(
        whatsappAuthorization(channelBindingId),
      );
      const managed = yield* admitManagedConversation(
        {
          authorization,
          idempotencyKey: `whatsapp-${receiptId}`,
          message: "Recover accepted work",
          routeId,
          submissionId,
        },
        { currentSessionId: sessionId, routeId },
      );
      const admitted = yield* Schema.decodeUnknownEffect(
        Schema.TaggedStruct("ManagedConversationAdmitted", {
          idempotencyKey: Schema.String,
          metadata: ManagedTurnMetadata,
          submissionId: ThinkSubmissionId,
        }),
      )(managed);
      const metadata = {
        ...admitted.metadata,
        whatsappAcceptance: {
          channelBindingId,
          providerMessageId,
          sessionId,
          userMessageId,
        },
      };
      const input = {
        authorization,
        channelBindingId,
        message: "Recover accepted work",
        providerMessageId,
        receiptId,
        submissionId,
        userMessageId,
      } as const;
      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId: "init-whatsapp-think-recovery",
            initializedAt: "2026-08-16T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );

      const recovered = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance, state) => {
          await instance.runTurn({
            idempotencyKey: admitted.idempotencyKey,
            input: {
              id: userMessageId,
              parts: [{ text: input.message, type: "text" }],
              role: "user",
            },
            metadata,
            mode: "submit",
            submissionId,
          });
          const acceptedSubmission = await instance.inspectSubmission(submissionId);
          const receipt = await instance.recoverWhatsAppMessage({
            channelBindingId: input.channelBindingId,
            providerMessageId: input.providerMessageId,
            receiptId: input.receiptId,
            submissionId: input.submissionId,
            userMessageId: input.userMessageId,
          });
          const receiptRows = Array.from(
            state.storage.sql.exec<{ count: number }>(
              "SELECT count(*) AS count FROM osfo_acceptance_receipts",
            ),
          );
          return {
            acceptedSubmission,
            receipt,
            receiptCount: receiptRows[0]?.count,
          };
        }),
      );

      expect(recovered.receipt).toMatchObject({
        _tag: "AcceptanceReceipt",
        channelBindingId,
        providerMessageId,
        receiptId,
        thinkSubmissionId: submissionId,
        userMessageId,
      });
      expect(recovered.acceptedSubmission).toMatchObject({
        idempotencyKey: admitted.idempotencyKey,
        submissionId,
      });
      expect(recovered.receiptCount).toBe(1);
    }),
  );

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
      const invalidSequenceSessionId = Schema.decodeUnknownSync(SessionId)("invalid-sequence");
      const duplicateSequenceSessionId = Schema.decodeUnknownSync(SessionId)("duplicate-sequence");
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
              ownershipSequence: 2,
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
                ownershipSequence: 0,
                replacedAt: initializedAt,
                routeId: secondaryRouteId,
                sessionId: invalidSequenceSessionId,
              })
              .run(),
          ).toThrow(/constraint/i);
          expect(() =>
            db
              .insert(sessionOwnership)
              .values({
                becameCurrentAt: initializedAt,
                ownershipSequence: 2,
                replacedAt: initializedAt,
                routeId: secondaryRouteId,
                sessionId: duplicateSequenceSessionId,
              })
              .run(),
          ).toThrow(/constraint/i);
          expect(() =>
            db
              .insert(sessionOwnership)
              .values({
                becameCurrentAt: initializedAt,
                ownershipSequence: 3,
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
                ownershipSequence: 4,
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
          await replaceOwnedSession(agent, {
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
          await replaceOwnedSession(agent, {
            expectedCurrentSessionId: firstSessionId,
            replacedAt: "2026-08-15T12:00:00.1Z",
            replacementSessionId: secondSessionId,
            routeId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          const secondSession = Session.create(instance).forSession(secondSessionId);
          for (const id of ["assistant-m-third", "assistant-b-fourth"]) {
            await secondSession.appendMessage({
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
          await replaceOwnedSession(agent, {
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

  it.effect("upgrades a populated 0002 Agent database through 0004 without losing receipts", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-populated-0002");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          await Effect.runPromise(applyMigrationChain(state.storage, agentMigrations.slice(0, 3)));
          state.storage.sql.exec(
            "INSERT INTO osfo_conversation_routes (is_primary, route_id) VALUES (1, ?)",
            "route-upgrade-0002",
          );
          state.storage.sql.exec(
            `INSERT INTO osfo_session_ownership
              (became_current_at, replaced_at, route_id, session_id)
             VALUES (?, NULL, ?, ?)`,
            "2026-08-16T12:00:00.000Z",
            "route-upgrade-0002",
            "session-upgrade-0002",
          );
          state.storage.sql.exec(
            `INSERT INTO osfo_acceptance_receipts
              (allowance_period_id, channel_binding_id, provider_message_id, receipt_id,
               session_id, think_submission_id, user_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            "period-upgrade-0002",
            "binding-upgrade-0002",
            "provider-upgrade-0002",
            "receipt-upgrade-0002",
            "session-upgrade-0002",
            "submission-upgrade-0002",
            "message-upgrade-0002",
          );

          const upgraded = await Effect.runPromise(
            applyMigrationChain(state.storage, agentMigrations),
          );
          const repeated = await Effect.runPromise(
            applyMigrationChain(state.storage, agentMigrations),
          );
          const ownership = state.storage.sql
            .exec<{ ownership_sequence: number; session_id: string }>(
              "SELECT session_id, ownership_sequence FROM osfo_session_ownership",
            )
            .one();
          const receipt = state.storage.sql
            .exec<{ receipt_id: string; session_id: string }>(
              "SELECT receipt_id, session_id FROM osfo_acceptance_receipts",
            )
            .one();
          return { ownership, receipt, repeated, upgraded };
        }),
      );

      expect(observed).toEqual({
        ownership: { ownership_sequence: 1, session_id: "session-upgrade-0002" },
        receipt: { receipt_id: "receipt-upgrade-0002", session_id: "session-upgrade-0002" },
        repeated: { appliedVersions: [], currentVersion: 5 },
        upgraded: { appliedVersions: [4, 5], currentVersion: 5 },
      });
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

      expect(observed).toEqual({
        failureTag: "AgentMigrationDefinitionMismatch",
        ledger: [],
      });
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
          return {
            failureTag: failure._tag,
            failureVersion: failure.version,
          };
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
          return {
            after: readNonOsfoTableDefinitions(state.storage),
            before,
          };
        }),
      );

      expect(observed.after).toEqual(observed.before);
      expect(observed.before.length).toBeGreaterThan(0);
    }),
  );
});

const initializeCoreMemoryAgent = (name: string) =>
  Effect.gen(function* () {
    const agentId = Schema.decodeUnknownSync(AgentId)(`agent-core-memory-${name}`);
    const routeId = Schema.decodeUnknownSync(ConversationRouteId)(`route-core-memory-${name}`);
    const sessionId = Schema.decodeUnknownSync(SessionId)(`session-core-memory-${name}`);
    const agent = env.OSFO_AGENT.getByName(agentId);
    yield* Effect.promise(
      async () =>
        await agent.initialize({
          agentId,
          initializationId: `init-core-memory-${name}`,
          initializedAt: "2026-08-15T12:00:00.000Z",
          routeId,
          sessionId,
        }),
    );
    return { agent, routeId, sessionId };
  });

const inspectAgentMemory = async (agent: DurableObjectStub<OsfoAgent>, actionId: string) =>
  await agent.inspectCoreMemory({ actionId, authorization: coreMemoryAuthorization() });

const correctAgentMemory = async (
  agent: DurableObjectStub<OsfoAgent>,
  actionId: string,
  input: { readonly block: "agentNotes" | "userContext"; readonly content: string },
) =>
  await agent.correctCoreMemory({ ...input, actionId, authorization: coreMemoryAuthorization() });

const boundAgentMemory = async (
  agent: DurableObjectStub<OsfoAgent>,
  actionId: string,
  input: { readonly block: "agentNotes" | "userContext"; readonly maxTokens: number },
) => await agent.boundCoreMemory({ ...input, actionId, authorization: coreMemoryAuthorization() });

const coreMemoryAuthorization = () =>
  AuthorizationContext.make({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: AllowancePeriodId.make("period-core-memory"),
      endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
      plan: "free",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      startsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "ChannelBinding",
      channelBindingId: ChannelBindingId.make("binding-core-memory"),
      userId: UserId.make("user-core-memory"),
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
    originatingAuthority: {
      _tag: "ChannelBinding",
      channelBindingId: ChannelBindingId.make("binding-core-memory"),
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: UserId.make("user-core-memory"),
    subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
    user: { _tag: "ActiveUser", userId: UserId.make("user-core-memory") },
  });

const revokedCoreMemoryAuthorization = () =>
  AuthorizationContext.make({
    ...coreMemoryAuthorization(),
    authority: {
      _tag: "RevokedChannelBinding",
      channelBindingId: ChannelBindingId.make("binding-core-memory"),
      userId: UserId.make("user-core-memory"),
    },
  });

const approvalAuthorization = (authority: "active" | "revoked") =>
  Schema.encodeSync(AuthorizationContext)(
    currentTestAuthorization({ authority, currentFact: "current", providerOutcome: "applied" }),
  );

const managedTurnMetadata = (name: string) => {
  const profile = launchModelAccessPolicy.plans.free;
  const authorization = coreMemoryAuthorization();
  return ManagedTurnMetadata.make({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: AllowancePeriodId.make(`period-${name}`),
    authorityIdentity: {
      _tag: "ChannelBinding",
      channelBindingId: ChannelBindingId.make("binding-core-memory"),
      userId: UserId.make("user-core-memory"),
    },
    conservativeVendorUsdMicros: 1,
    coreMemoryAuthorization: Schema.encodeSync(CoreMemoryAuthorizationSnapshot)(
      snapshotCoreMemoryAuthorization(authorization),
    ),
    maxInputTokens: profile.context.maxInputTokens,
    maxOutputTokens: profile.context.maxOutputTokens,
    maxRetries: profile.maxRetries,
    maxSteps: Number(currentPolicy.plans.free.operationLimits.modelStepsPerRequest),
    originatingAuthority: {
      _tag: "ChannelBinding",
      channelBindingId: "binding-core-memory",
    },
    plan: "free",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    routeId: ConversationRouteId.make(`route-${name}`),
    route: profile.route,
    sessionId: SessionId.make(`session-${name}`),
    submissionId: ThinkSubmissionId.make(`submission-${name}`),
    targetInputTokens: profile.context.targetInputTokens,
  });
};

const ParkedCoreMemoryAction = Schema.Struct({
  action: Schema.String,
  executionId: Schema.String,
  status: Schema.String,
});

const parkCoreMemoryClearAction = (
  agent: DurableObjectStub<OsfoAgent>,
  toolCallId: string,
  block: "agentNotes" | "userContext",
) =>
  runInDurableObject(agent, async (instance) => {
    // SAFETY: Think has no public test driver for registered Actions. This reaches the same compiler seam as Think's durable-pause tests.
    const compile = instance as unknown as {
      _compileActionTools: () => Promise<
        Record<
          string,
          {
            execute?: (
              input: unknown,
              options: { messages?: []; toolCallId?: string },
            ) => Promise<unknown>;
          }
        >
      >;
    };
    const tools = await compile._compileActionTools();
    const clear = tools[coreMemoryClearActionName];
    if (clear?.execute === undefined) throw new Error("Core Memory clear Action is not registered");
    return Schema.decodeUnknownSync(ParkedCoreMemoryAction)(
      await clear.execute({ block }, { messages: [], toolCallId }),
    );
  });

const whatsappAuthorization = (channelBindingId: string) => ({
  allowance: {
    _tag: "Metered" as const,
    allowancePeriodId: "period-whatsapp-acceptance",
    endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
    plan: "free" as const,
    planPolicyVersion: "launch-v1",
    startsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
    usage: [],
  },
  approval: null,
  authority: {
    _tag: "ChannelBinding" as const,
    channelBindingId,
    userId: "user-whatsapp-acceptance",
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" as const },
  gmailConnection: null,
  liveFacts: {
    activeGmSummonsInSession: 0n,
    activeReminders: 0n,
    concurrentWorkflows: 0n,
    retainedFileBytes: 0n,
  },
  now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
  originatingAuthority: { _tag: "ChannelBinding" as const, channelBindingId },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: "user-whatsapp-acceptance",
  subscription: { plan: "free" as const, planPolicyVersion: "launch-v1" },
  user: { _tag: "ActiveUser" as const, userId: "user-whatsapp-acceptance" },
});

const resetOsfoTables = (storage: DurableObjectStorage): void => {
  storage.sql.exec("DROP TABLE IF EXISTS osfo_file_deletions");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_file_analyses");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_files");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_acceptance_receipts");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_session_command_receipts");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_model_call_usage_evidence");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_session_recall_cursors");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_agent_initialization");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_committed_turns");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_session_ownership");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_conversation_routes");
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

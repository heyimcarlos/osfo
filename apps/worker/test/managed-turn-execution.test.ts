import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import {
  AgentId,
  AgentInitializationId,
  ChannelBindingId,
  ConversationRouteId,
  PlanPolicyVersion,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../src/domain";
import * as SessionRecallAuthorizationPostgres from "../src/integrations/postgres/session-recall-authorization";
import * as ProviderAuthorizationPostgres from "../src/integrations/postgres/provider-authorization";
import { AuthorizationContext } from "../src/services/authorization";
import { OsfoAgent } from "../src/agents/osfo/agent";

/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, eslint/no-underscore-dangle, unicorn/consistent-function-scoping -- The real Think lifecycle, AI SDK model, and drain orchestration are Promise-owned APIs. */

const emptyUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

describe("managed Think Submission execution", () => {
  it.effect(
    "pins Session authority through drain, Recall, observation, and completion while replacement waits",
    () =>
      Effect.gen(function* () {
        const agentId = AgentId.make("agent-managed-drain");
        const routeId = ConversationRouteId.make("route-managed-drain");
        const sessionId = SessionId.make("session-managed-drain");
        const submissionId = ThinkSubmissionId.make("submission-managed-drain");
        const replacementId = ThinkSubmissionId.make("submission-managed-new");
        const channelBindingId = ChannelBindingId.make("binding-managed-drain");
        const userId = UserId.make("user-managed-drain");
        const agent = env.OSFO_AGENT.getByName(agentId);
        yield* Effect.promise(async () => {
          await agent.initialize({
            agentId,
            initializationId: AgentInitializationId.make("init-managed-drain"),
            initializedAt: "2026-08-17T12:00:00.000Z",
            routeId,
            sessionId,
          });
        });

        const observed = yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance) => {
            let modelCalls = 0;
            let secondPrompt = "";
            let releaseCompletion: () => void = () => {};
            let markFirstStep: () => void = () => {};
            let markSecondStep: () => void = () => {};
            const completionGate = new Promise<void>((resolve) => {
              releaseCompletion = resolve;
            });
            const secondStepStarted = new Promise<void>((resolve) => {
              markSecondStep = resolve;
            });
            const firstStepStarted = new Promise<void>((resolve) => {
              markFirstStep = resolve;
            });
            const model = new MockLanguageModelV3({
              provider: "osfo-test",
              modelId: "managed-drain",
              doGenerate: async () => ({
                content: [{ text: "completed", type: "text" }],
                finishReason: { raw: "stop", unified: "stop" },
                usage: emptyUsage,
                warnings: [],
              }),
              doStream: async (options) => {
                modelCalls += 1;
                if (modelCalls === 1) {
                  markFirstStep();
                  return {
                    stream: simulateReadableStream({
                      chunks: [
                        { type: "stream-start", warnings: [] },
                        {
                          input: JSON.stringify({ query: "orchid" }),
                          toolCallId: "recall-managed-drain",
                          toolName: "sessionRecall",
                          type: "tool-call",
                        },
                        {
                          finishReason: { raw: "tool-calls", unified: "tool-calls" },
                          type: "finish",
                          usage: emptyUsage,
                        },
                      ],
                      initialDelayInMs: null,
                      chunkDelayInMs: null,
                    }),
                  };
                }
                secondPrompt = JSON.stringify(options.prompt);
                markSecondStep();
                await completionGate;
                return {
                  stream: simulateReadableStream({
                    chunks: [
                      { type: "stream-start", warnings: [] },
                      { id: "answer", type: "text-start" },
                      { delta: "completed", id: "answer", type: "text-delta" },
                      { id: "answer", type: "text-end" },
                      {
                        finishReason: { raw: "stop", unified: "stop" },
                        type: "finish",
                        usage: emptyUsage,
                      },
                    ],
                    initialDelayInMs: null,
                    chunkDelayInMs: null,
                  }),
                };
              },
            });
            vi.spyOn(instance, "getActions").mockReturnValue({});
            vi.spyOn(instance, "resolveModel").mockReturnValue(model);
            vi.spyOn(instance, "onStepEnd").mockImplementation(async () => {});
            const inspectAuthorization = vi
              .spyOn(SessionRecallAuthorizationPostgres, "inspect")
              .mockReturnValue(
                Effect.succeed({
                  authority: { _tag: "ChannelBinding", channelBindingId, userId },
                  deletionAccess: { _tag: "DeletionAccessAvailable" },
                  now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T12:00:00.000Z")),
                  resourceOwnerUserId: userId,
                  subscription: {
                    plan: "free",
                    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
                  },
                  user: { _tag: "ActiveUser", userId },
                }),
              );
            await instance.onStart();

            const authorization = managedAuthorization(channelBindingId, userId);
            const accepted = await instance.submitManagedConversation({
              authorization,
              idempotencyKey: "managed-drain",
              message: "Remember orchid",
              routeId,
              submissionId,
            });
            const drain = instance._drainThinkSubmissions();
            await firstStepStarted;

            let replacementFinished = false;
            const replacement = instance
              .submitManagedConversation({
                authorization,
                idempotencyKey: "managed-new",
                message: "/new",
                routeId,
                submissionId: replacementId,
              })
              .then((result) => {
                replacementFinished = true;
                return result;
              });
            await Promise.resolve();
            const replacementWaited = !replacementFinished;

            const recallCompleted = await Promise.race([
              secondStepStarted.then(() => true),
              drain.then(() => false),
            ]);
            if (recallCompleted) releaseCompletion();
            await drain;
            const replaced = await replacement;
            const inspection = await instance.inspectSubmission(submissionId);
            const committed = await instance.readCommittedTurns();
            const original = await instance.readSession(sessionId);
            return {
              accepted,
              committed,
              inspection,
              modelCalls,
              original,
              recallCompleted,
              replaced,
              replacementWaited,
              secondPrompt,
              authorizationInspections: inspectAuthorization.mock.calls.length,
            };
          }),
        );

        expect(observed.accepted).toMatchObject({ status: "pending", submissionId });
        expect(observed.replacementWaited).toBe(true);
        expect(observed.modelCalls).toBe(2);
        expect(observed.recallCompleted).toBe(true);
        expect(observed.authorizationInspections).toBe(1);
        expect(observed.secondPrompt).toContain("SessionRecallCompleted");
        expect(observed.secondPrompt).toContain("Remember orchid");
        expect(observed.inspection).toMatchObject({ status: "completed", submissionId });
        expect(observed.committed).toEqual([
          expect.objectContaining({ sessionId, source: "hook", thinkRequestId: submissionId }),
        ]);
        expect(observed.original).toMatchObject({
          _tag: "SessionHistoryFound",
          messages: [
            expect.objectContaining({ role: "user" }),
            expect.objectContaining({ role: "assistant" }),
          ],
          sessionId,
        });
        expect(observed.replaced).toMatchObject({
          _tag: "CurrentSessionReplaced",
          currentSessionId: `session-${replacementId}`,
        });
      }),
  );

  it.effect(
    "orders Telegram admission after a waiting /new and executes in the replacement Session",
    () =>
      Effect.gen(function* () {
        const agentId = AgentId.make("agent-telegram-reset-race");
        const routeId = ConversationRouteId.make("route-telegram-reset-race");
        const initialSessionId = SessionId.make("session-telegram-reset-race");
        const blockerId = ThinkSubmissionId.make("submission-telegram-reset-blocker");
        const replacementId = ThinkSubmissionId.make("submission-telegram-reset-new");
        const telegramSubmissionId = ThinkSubmissionId.make("submission-telegram-reset-message");
        const replacementSessionId = SessionId.make(`session-${replacementId}`);
        const channelBindingId = ChannelBindingId.make("binding-telegram-reset-race");
        const userId = UserId.make("user-telegram-reset-race");
        const authorization = managedAuthorization(channelBindingId, userId);
        const agent = env.OSFO_AGENT.getByName(agentId);
        yield* Effect.promise(async () => {
          await agent.initialize({
            agentId,
            initializationId: AgentInitializationId.make("init-telegram-reset-race"),
            initializedAt: "2026-08-17T12:00:00.000Z",
            routeId,
            sessionId: initialSessionId,
          });
        });

        const observed = yield* Effect.promise(() =>
          runInDurableObject(agent, async (instance) => {
            const model = new MockLanguageModelV3({
              provider: "osfo-test",
              modelId: "telegram-reset-race",
              doStream: async () => ({
                stream: simulateReadableStream({
                  chunks: [
                    { type: "stream-start", warnings: [] },
                    { id: "answer", type: "text-start" },
                    { delta: "completed", id: "answer", type: "text-delta" },
                    { id: "answer", type: "text-end" },
                    {
                      finishReason: { raw: "stop", unified: "stop" },
                      type: "finish",
                      usage: emptyUsage,
                    },
                  ],
                  initialDelayInMs: null,
                  chunkDelayInMs: null,
                }),
              }),
            });
            vi.spyOn(instance, "getActions").mockReturnValue({});
            vi.spyOn(instance, "resolveModel").mockReturnValue(model);
            vi.spyOn(instance, "onStepEnd").mockImplementation(async () => {});
            vi.spyOn(ProviderAuthorizationPostgres, "make").mockReturnValue(
              Effect.succeed({ admit: () => Effect.succeed(authorization) }),
            );
            await instance.onStart();

            await instance.submitManagedConversation({
              authorization,
              idempotencyKey: "telegram-reset-blocker",
              message: "Finish earlier work",
              routeId,
              submissionId: blockerId,
            });

            let replacementFinished = false;
            const replacement = instance
              .submitManagedConversation({
                authorization,
                idempotencyKey: "telegram-reset-new",
                message: "/new",
                routeId,
                submissionId: replacementId,
              })
              .then((result) => {
                replacementFinished = true;
                return result;
              });
            await Promise.resolve();

            let telegramFinished = false;
            const telegram = instance
              .acceptTelegramMessage({
                channelBindingId,
                message: "Use the new Session",
                providerMessageId: "telegram-reset-event",
                receiptId: "receipt-telegram-reset-event",
                submissionId: telegramSubmissionId,
                userMessageId: "message-telegram-reset-event",
              })
              .then((result) => {
                telegramFinished = true;
                return result;
              });
            await Promise.resolve();
            const telegramWaitedBehindReset = !telegramFinished && !replacementFinished;

            await instance._drainThinkSubmissions();
            const replaced = await replacement;
            const receipt = await telegram;
            await instance._drainThinkSubmissions();
            const telegramSubmission = await instance.inspectSubmission(telegramSubmissionId);
            const replacementSession = await instance.readSession(replacementSessionId);
            return {
              receipt,
              replaced,
              replacementSession,
              telegramSubmission,
              telegramWaitedBehindReset,
            };
          }),
        );

        expect(observed.telegramWaitedBehindReset).toBe(true);
        expect(observed.replaced).toMatchObject({
          _tag: "CurrentSessionReplaced",
          currentSessionId: replacementSessionId,
        });
        expect(observed.receipt).toMatchObject({
          _tag: "AcceptanceReceipt",
          sessionId: replacementSessionId,
          thinkSubmissionId: telegramSubmissionId,
        });
        expect(observed.telegramSubmission).toMatchObject({
          metadata: {
            sessionId: replacementSessionId,
            telegramAcceptance: { sessionId: replacementSessionId },
          },
          status: "completed",
        });
        expect(observed.replacementSession).toMatchObject({
          _tag: "SessionHistoryFound",
          messages: [
            expect.objectContaining({ role: "user" }),
            expect.objectContaining({ role: "assistant" }),
          ],
        });
      }),
  );

  it.effect("reconstructs a pending Submission pin from Think after Agent eviction", () =>
    Effect.gen(function* () {
      const agentId = AgentId.make("agent-managed-eviction");
      const routeId = ConversationRouteId.make("route-managed-eviction");
      const sessionId = SessionId.make("session-managed-eviction");
      const submissionId = ThinkSubmissionId.make("submission-managed-eviction");
      const replacementId = ThinkSubmissionId.make("submission-managed-eviction-new");
      const channelBindingId = ChannelBindingId.make("binding-managed-eviction");
      const userId = UserId.make("user-managed-eviction");
      const authorization = managedAuthorization(channelBindingId, userId);
      const agent = env.OSFO_AGENT.getByName(agentId);
      let releaseModel: () => void = () => {};
      let markModelStarted: () => void = () => {};
      const modelStarted = new Promise<void>((resolve) => {
        markModelStarted = resolve;
      });
      const modelGate = new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      const model = new MockLanguageModelV3({
        provider: "osfo-test",
        modelId: "managed-eviction",
        doGenerate: async () => ({
          content: [{ text: "completed", type: "text" }],
          finishReason: { raw: "stop", unified: "stop" },
          usage: emptyUsage,
          warnings: [],
        }),
        doStream: async () => {
          markModelStarted();
          await modelGate;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { id: "answer", type: "text-start" },
                { delta: "completed", id: "answer", type: "text-delta" },
                { id: "answer", type: "text-end" },
                {
                  finishReason: { raw: "stop", unified: "stop" },
                  type: "finish",
                  usage: emptyUsage,
                },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          };
        },
      });
      yield* Effect.promise(async () => {
        await agent.initialize({
          agentId,
          initializationId: AgentInitializationId.make("init-managed-eviction"),
          initializedAt: "2026-08-17T12:00:00.000Z",
          routeId,
          sessionId,
        });
        await runInDurableObject(agent, async (instance) => {
          const schedule = instance.schedule.bind(instance);
          vi.spyOn(instance, "schedule").mockImplementation((_when, callback, payload, options) =>
            schedule(3_600, callback, payload, options),
          );
          const accepted = await instance.submitManagedConversation({
            authorization,
            idempotencyKey: "managed-eviction",
            message: "Keep this Session pinned",
            routeId,
            submissionId,
          });
          expect(accepted).toMatchObject({ status: "pending", submissionId });
        });
        await evictDurableObject(agent);
      });
      vi.spyOn(OsfoAgent.prototype, "getActions").mockReturnValue({});
      vi.spyOn(OsfoAgent.prototype, "resolveModel").mockReturnValue(model);
      vi.spyOn(OsfoAgent.prototype, "onStepEnd").mockImplementation(async () => {});

      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          let replacementFinished = false;
          await instance.onStart();

          const replacement = instance
            .submitManagedConversation({
              authorization,
              idempotencyKey: "managed-eviction-new",
              message: "/new",
              routeId,
              submissionId: replacementId,
            })
            .then((result) => {
              replacementFinished = true;
              return result;
            });
          await Promise.resolve();
          const waitedBeforeDrain = !replacementFinished;
          const drain = instance._drainThinkSubmissions();
          await modelStarted;
          const waitedDuringExecution = !replacementFinished;
          releaseModel();
          await drain;
          const replaced = await replacement;
          const inspection = await instance.inspectSubmission(submissionId);
          const original = await instance.readSession(sessionId);
          return { inspection, original, replaced, waitedBeforeDrain, waitedDuringExecution };
        }),
      );

      expect(observed.waitedBeforeDrain).toBe(true);
      expect(observed.waitedDuringExecution).toBe(true);
      expect(observed.inspection).toMatchObject({ status: "completed", submissionId });
      expect(observed.original).toMatchObject({
        _tag: "SessionHistoryFound",
        messages: [
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ],
        sessionId,
      });
      expect(observed.replaced).toMatchObject({
        _tag: "CurrentSessionReplaced",
        currentSessionId: `session-${replacementId}`,
      });
    }),
  );

  it.effect("releases replacement after interruption and a terminal Submission retry", () =>
    Effect.gen(function* () {
      const agentId = AgentId.make("agent-managed-interruption");
      const routeId = ConversationRouteId.make("route-managed-interruption");
      const sessionId = SessionId.make("session-managed-interruption");
      const submissionId = ThinkSubmissionId.make("submission-managed-interruption");
      const replacementId = ThinkSubmissionId.make("submission-managed-interruption-new");
      const channelBindingId = ChannelBindingId.make("binding-managed-interruption");
      const userId = UserId.make("user-managed-interruption");
      const authorization = managedAuthorization(channelBindingId, userId);
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(async () => {
        await agent.initialize({
          agentId,
          initializationId: AgentInitializationId.make("init-managed-interruption"),
          initializedAt: "2026-08-17T12:00:00.000Z",
          routeId,
          sessionId,
        });
      });

      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          let markModelStarted: () => void = () => {};
          const modelStarted = new Promise<void>((resolve) => {
            markModelStarted = resolve;
          });
          const model = new MockLanguageModelV3({
            provider: "osfo-test",
            modelId: "managed-interruption",
            doGenerate: async () => ({
              content: [{ text: "unused", type: "text" }],
              finishReason: { raw: "stop", unified: "stop" },
              usage: emptyUsage,
              warnings: [],
            }),
            doStream: async () => {
              markModelStarted();
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: "stream-start", warnings: [] },
                    { id: "answer", type: "text-start" },
                    { delta: "late", id: "answer", type: "text-delta" },
                    { id: "answer", type: "text-end" },
                    {
                      finishReason: { raw: "stop", unified: "stop" },
                      type: "finish",
                      usage: emptyUsage,
                    },
                  ],
                  initialDelayInMs: 250,
                  chunkDelayInMs: null,
                }),
              };
            },
          });
          vi.spyOn(instance, "getActions").mockReturnValue({});
          vi.spyOn(instance, "resolveModel").mockReturnValue(model);
          vi.spyOn(instance, "onStepEnd").mockImplementation(async () => {});
          await instance.onStart();

          const input = {
            authorization,
            idempotencyKey: "managed-interruption",
            message: "Interrupt this managed turn",
            routeId,
            submissionId,
          };
          const accepted = await instance.submitManagedConversation(input);
          const drain = instance._drainThinkSubmissions();
          await modelStarted;
          await instance.cancelSubmission(submissionId, "test interruption");
          await drain;
          const terminal = await instance.inspectSubmission(submissionId);
          const replayed = await instance.submitManagedConversation(input);
          const replaced = await instance.submitManagedConversation({
            authorization,
            idempotencyKey: "managed-interruption-new",
            message: "/new",
            routeId,
            submissionId: replacementId,
          });
          return { accepted, replayed, replaced, terminal };
        }),
      );

      expect(observed.accepted).toMatchObject({ accepted: true, status: "pending", submissionId });
      expect(observed.terminal).toMatchObject({ status: "aborted", submissionId });
      expect(observed.replayed).toMatchObject({ accepted: false, status: "aborted", submissionId });
      expect(observed.replaced).toMatchObject({
        _tag: "CurrentSessionReplaced",
        currentSessionId: `session-${replacementId}`,
      });
    }),
  );

  it.effect("wakes a waiting replacement after invalid running work is cancelled", () =>
    Effect.gen(function* () {
      const agentId = AgentId.make("agent-invalid-running-wakeup");
      const routeId = ConversationRouteId.make("route-invalid-running-wakeup");
      const channelBindingId = ChannelBindingId.make("binding-invalid-running-wakeup");
      const userId = UserId.make("user-invalid-running-wakeup");
      const authorization = managedAuthorization(channelBindingId, userId);
      const submissionId = ThinkSubmissionId.make("submission-invalid-running-wakeup");
      const replacementId = ThinkSubmissionId.make("submission-invalid-running-new");
      const agent = env.OSFO_AGENT.getByName(agentId);
      yield* Effect.promise(async () => {
        await agent.initialize({
          agentId,
          initializationId: AgentInitializationId.make("init-invalid-running-wakeup"),
          initializedAt: "2026-08-17T12:00:00.000Z",
          routeId,
          sessionId: SessionId.make("session-invalid-running-wakeup"),
        });
      });

      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.onStart();
          await instance.submitManagedConversation({
            authorization,
            idempotencyKey: "invalid-running-wakeup",
            message: "queued",
            routeId,
            submissionId,
          });
          const pending = await instance.inspectSubmission(submissionId);
          if (pending === null) throw new Error("Expected pending Think Submission");
          vi.spyOn(instance, "listSubmissions")
            .mockResolvedValueOnce([pending])
            .mockResolvedValue([]);
          const cancel = vi.spyOn(instance, "cancelSubmission").mockResolvedValue(undefined);

          const replacement = instance.submitManagedConversation({
            authorization,
            idempotencyKey: "invalid-running-new",
            message: "/new",
            routeId,
            submissionId: replacementId,
          });
          await Promise.resolve();
          await instance.onSubmissionStatus({
            ...pending,
            status: "running",
            submissionId: "not-a-managed-submission-id",
          });
          return { cancelCalls: cancel.mock.calls.length, replaced: await replacement };
        }),
      );

      expect(observed.cancelCalls).toBe(1);
      expect(observed.replaced).toMatchObject({
        _tag: "CurrentSessionReplaced",
        currentSessionId: `session-${replacementId}`,
      });
    }),
  );
});

const managedAuthorization = (channelBindingId: ChannelBindingId, userId: UserId) =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered" as const,
      allowancePeriodId: "period-managed-drain",
      endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
      plan: "free" as const,
      planPolicyVersion: "launch-v1",
      startsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
      usage: [],
    },
    approval: null,
    authority: { _tag: "ChannelBinding" as const, channelBindingId, userId },
    deletionAccess: { _tag: "DeletionAccessAvailable" as const },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T12:00:00.000Z")),
    originatingAuthority: { _tag: "ChannelBinding" as const, channelBindingId },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: userId,
    subscription: { plan: "free" as const, planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser" as const, userId },
  });

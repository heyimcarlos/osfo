import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import {
  AgentId,
  AgentInitializationId,
  ConversationRouteId,
  SessionId,
  ThinkSubmissionId,
} from "../src/domain";
import { AgentStoreUnavailable } from "../src/agents/osfo/db/errors";
import { makeAgentSessionLifecycle } from "../src/agents/osfo/session-lifecycle";
import { AuthorizationContext } from "../src/services/authorization";
import { replaceOwnedSession } from "./support/session-store";

/* oxlint-disable effecttsgo/async-function, effecttsgo/prefer-typed-schema-decoder, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Worker integration tests cross Promise, RPC, Effect, and raw SQLite test boundaries. */

const sessionCommandAuthorizationContext = () =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: "period-session-new",
      endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
      plan: "free",
      planPolicyVersion: "launch-v1",
      startsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-new",
      expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-20T00:00:00.000Z")),
      userId: "user-session-new",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T00:00:00.000Z")),
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-new",
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: "user-session-new",
    subscription: { plan: "free", planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser", userId: "user-session-new" },
  });

describe("Osfo Session lifecycle", () => {
  it.effect("preserves replacement failures as replacement operations", () =>
    Effect.gen(function* () {
      const routeId = ConversationRouteId.make("route-replacement-failure");
      const currentSessionId = SessionId.make("session-replacement-failure-current");
      const failure = yield* makeAgentSessionLifecycle({
        activateCurrentSession: () => Promise.resolve(),
        store: {
          readRoute: () =>
            Effect.succeed({
              _tag: "ConversationRouteFound" as const,
              currentSessionId,
              historicalSessionIds: [],
              routeId,
            }),
          replaceCurrentSession: () =>
            Effect.fail(
              new AgentStoreUnavailable({
                cause: "database unavailable",
                message: "Agent SQLite operation failed",
                operation: "replaceCurrentSession",
              }),
            ),
        },
      })
        .replaceCurrent({
          _tag: "ManagedSessionReplacementAdmitted",
          routeId,
          submissionId: ThinkSubmissionId.make("submission-replacement-failure"),
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "SessionLifecycleUnavailable",
        operation: "replaceCurrentSession",
      });
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
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(agentId);

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
          await replaceOwnedSession(agent, {
            expectedCurrentSessionId: initialSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId,
            routeId,
          }),
      );
      const repeatedReplacement = yield* Effect.promise(
        async () =>
          await replaceOwnedSession(agent, {
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
          await replaceOwnedSession(agent, {
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

  it.effect("applies explicit /new and exposes the new current Session for authorization", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-new");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)("init-session-new");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-session-new");
      const initialSessionId = Schema.decodeUnknownSync(SessionId)("session-before-new");
      const submissionId = Schema.decodeUnknownSync(ThinkSubmissionId)("submission-session-new");
      const replacementSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-submission-session-new",
      );
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(agentId);

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
      const before = yield* Effect.promise(
        async () => await agent.readSessionAuthorizationFacts(routeId),
      );
      const replaced = yield* Effect.promise(
        async () =>
          await agent.submitManagedConversation({
            authorization: sessionCommandAuthorizationContext(),
            idempotencyKey: "message-session-new",
            message: "/new",
            routeId,
            submissionId,
          }),
      );
      const competingRetry = yield* Effect.promise(
        async () =>
          await agent.submitManagedConversation({
            authorization: sessionCommandAuthorizationContext(),
            idempotencyKey: "message-session-new",
            message: "/new",
            routeId,
            submissionId,
          }),
      );
      const after = yield* Effect.promise(
        async () => await agent.readSessionAuthorizationFacts(routeId),
      );

      expect(before).toEqual({
        _tag: "SessionAuthorizationFactsFound",
        agentId,
        currentSessionId: initialSessionId,
        routeId,
      });
      expect(replaced).toMatchObject({
        _tag: "CurrentSessionReplaced",
        currentSessionId: replacementSessionId,
        historicalSessionId: initialSessionId,
      });
      expect(competingRetry).toEqual(replaced);
      expect(after).toEqual({
        _tag: "SessionAuthorizationFactsFound",
        agentId,
        currentSessionId: replacementSessionId,
        routeId,
      });
      const commandSurface = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => ({
          hasRecallRpc: "recallSession" in instance,
          hasReplaceCurrentSessionRpc: "replaceCurrentSession" in instance,
          hasStartNewSessionRpc: "startNewSession" in instance,
        })),
      );
      expect(commandSurface).toEqual({
        hasRecallRpc: false,
        hasReplaceCurrentSessionRpc: false,
        hasStartNewSessionRpc: false,
      });
    }),
  );

  it.effect("allows one competing Session replacement and rejects the stale request", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-new-competing");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-session-new-competing",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-session-new-competing");
      const initialSessionId = Schema.decodeUnknownSync(SessionId)("session-new-competing-initial");
      const firstReplacementSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-new-competing-first",
      );
      const secondReplacementSessionId = Schema.decodeUnknownSync(SessionId)(
        "session-new-competing-second",
      );
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(agentId);

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
      const outcomes = yield* Effect.promise(
        async () =>
          await Promise.all([
            replaceOwnedSession(agent, {
              expectedCurrentSessionId: initialSessionId,
              replacedAt: "2026-08-16T12:00:00.000Z",
              replacementSessionId: firstReplacementSessionId,
              routeId,
            }),
            replaceOwnedSession(agent, {
              expectedCurrentSessionId: initialSessionId,
              replacedAt: "2026-08-16T12:00:00.001Z",
              replacementSessionId: secondReplacementSessionId,
              routeId,
            }),
          ]),
      );
      const current = yield* Effect.promise(
        async () => await agent.readSessionAuthorizationFacts(routeId),
      );
      const replaced = outcomes.find(({ _tag }) => _tag === "CurrentSessionReplaced");
      const conflict = outcomes.find(({ _tag }) => _tag === "CurrentSessionReplacementConflict");
      const winningSessionId =
        replaced !== undefined && "currentSessionId" in replaced
          ? replaced.currentSessionId
          : undefined;

      expect(replaced).toMatchObject({
        _tag: "CurrentSessionReplaced",
        historicalSessionId: initialSessionId,
        routeId,
      });
      expect(conflict).toMatchObject({
        _tag: "CurrentSessionReplacementConflict",
        actualCurrentSessionId: winningSessionId,
        expectedCurrentSessionId: initialSessionId,
        routeId,
      });
      expect(current).toMatchObject({
        _tag: "SessionAuthorizationFactsFound",
        currentSessionId: winningSessionId,
        routeId,
      });
    }),
  );

  it.effect("keeps one Session across topic, time, and repeated compaction changes", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-session-continuity");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-session-continuity");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-session-continuity");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-continuity");
      const agent = env.OSFO_AGENT_TEST_FACET.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-01T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.session.appendMessage({
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T12:00:00.000Z")),
            id: "message-old-personal-topic",
            parts: [{ text: "My favourite tea is sencha", type: "text" }],
            role: "user",
          });
          await instance.session.appendMessage({
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
            id: "message-new-work-topic",
            parts: [{ text: "Prepare the quarterly report", type: "text" }],
            role: "user",
          });
          await instance.session.addCompaction(
            "The User discussed tea.",
            "message-old-personal-topic",
            "message-old-personal-topic",
          );
          await instance.session.addCompaction(
            "The User discussed tea and a report.",
            "message-old-personal-topic",
            "message-new-work-topic",
          );
        }),
      );

      const route = yield* Effect.promise(async () => await agent.readRoute(routeId));

      expect(route).toEqual({
        _tag: "ConversationRouteFound",
        currentSessionId: sessionId,
        historicalSessionIds: [],
        routeId,
      });
    }),
  );
});

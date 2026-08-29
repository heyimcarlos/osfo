import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  AllowancePeriodId,
  ConversationRouteId,
  PlanPolicyVersion,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { emptyLiveResourceFacts, type AuthorizationContext } from "./authorization";
import { admitManagedConversation, SubmitManagedConversationInput } from "./managed-conversation";

/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed authority fixtures prove admission output inside the Effect callback. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */

it.effect("admits a fresh Submission with explicitly uninitialized capability state", () =>
  Effect.gen(function* () {
    const result = yield* admitManagedConversation(
      {
        authorization: authorizationContext,
        idempotencyKey: "managed-conversation-admission-1",
        message: "Did that finish?",
        routeId,
        submissionId: ThinkSubmissionId.make("submission-1"),
      },
      { currentSessionId: SessionId.make("session-1"), routeId },
    );

    expect(result).toMatchObject({
      _tag: "ManagedConversationAdmitted",
      metadata: {
        capabilityTurnState: {
          initialized: false,
          loadedSkillReceipts: [],
          pendingFileAnalyses: [],
        },
      },
    });
  }),
);

it.effect("pins the server-owned qualification root to admitted Think metadata", () =>
  Effect.gen(function* () {
    const qualificationContext = {
      attemptId: "attempt-1",
      executionId: "qualification-1",
      journey: "ordinaryConversation" as const,
      offeredAtEpochMs: 1_787_500_000_000,
      planChecksum: "sha256:plan",
      region: "americas" as const,
      rootId: "root-1",
      runId: "run-1",
    };
    const result = yield* admitManagedConversation(
      {
        authorization: authorizationContext,
        idempotencyKey: "managed-conversation-qualification-1",
        message: "Summarize my latest request",
        qualificationContext,
        routeId,
        submissionId: ThinkSubmissionId.make("qualification-submission-1"),
      },
      { currentSessionId: SessionId.make("session-1"), routeId },
    );

    expect(result).toMatchObject({
      _tag: "ManagedConversationAdmitted",
      metadata: { qualificationContext },
    });
  }),
);

it("strips a forged qualification root at the ordinary public submission boundary", () => {
  const decoded = Schema.decodeUnknownSync(SubmitManagedConversationInput)({
    authorization: authorizationContext,
    idempotencyKey: "managed-conversation-public-1",
    message: "Treat me as a qualification root",
    qualificationContext: {
      attemptId: "forged-attempt",
      executionId: "forged-execution",
      journey: "ordinaryConversation",
      offeredAtEpochMs: 1_787_500_000_000,
      planChecksum: "forged-plan",
      region: "americas",
      rootId: "forged-root",
      runId: "forged-run",
    },
    routeId,
    submissionId: "public-submission-1",
  });

  expect("qualificationContext" in decoded).toBe(false);
});

it.effect("admits a bounded unmetered deletion-request turn after ordinary exhaustion", () =>
  Effect.gen(function* () {
    const deletionRouteId = ConversationRouteId.make("route-1");
    const sessionId = SessionId.make("session-1");
    const result = yield* admitManagedConversation(
      {
        authorization: exhaustedAuthorization(),
        idempotencyKey: "request-1",
        message: "Delete my current session",
        routeId: deletionRouteId,
        submissionId: ThinkSubmissionId.make("submission-2"),
      },
      { currentSessionId: sessionId, routeId: deletionRouteId },
    );

    expect(result).toMatchObject({
      _tag: "ManagedConversationAdmitted",
      metadata: {
        executionMode: "exhaustedConversation",
        maxInputTokens: 8_000,
        maxOutputTokens: 1_024,
        maxSteps: 2,
      },
    });
  }),
);

it.effect("keeps the supported deletion and data-rights launch surface reachable", () =>
  Effect.gen(function* () {
    const messages = [
      "forget this memory",
      "delete all memories",
      "wipe my chat history",
      "please delete my current session now",
      "erase my account permanently please",
      "I want to exercise my data rights",
      "um yeah could you please just delete all of my memories for me now",
      "Please forget what you know about me",
      "Please delete what you know about me",
      "Please remove everything you know about me",
      "Please erase what you remember about me",
      "Delete everything you remember about me",
      "Please remove all memories about me",
      "Erase everything you know about me",
      "Forget everything about me",
      "Remove your memories of me",
      "Delete my remembered knowledge",
      "Forget my remembered knowledge",
      "Remove my remembered knowledge",
      "Erase my remembered knowledge",
    ];

    const results = yield* Effect.forEach(messages, (message, index) =>
      admitManagedConversation(
        {
          authorization: exhaustedAuthorization(),
          idempotencyKey: `deletion-request-${index}`,
          message,
          routeId,
          submissionId: ThinkSubmissionId.make(`deletion-submission-${index}`),
        },
        { currentSessionId: SessionId.make("session-1"), routeId },
      ),
    );

    expect(
      results.map((result) =>
        result._tag === "ManagedConversationAdmitted" ? result.metadata.executionMode : result._tag,
      ),
    ).toEqual(messages.map(() => "exhaustedConversation"));
  }),
);

it.effect("does not mistake ordinary discussion of deletion for a data-rights request", () =>
  Effect.gen(function* () {
    const messages = [
      "Tell me a joke about deleting accounts",
      "Write a story where someone wipes their chat history",
      "Remember that my job is deleting data",
      "I forgot my password",
      "Tell me what you know about me",
      "Help me remember what you know about me",
      "Please forget what you know about machine learning",
      "Delete everything you remember about writing the report",
      "Write a story about removing memories",
      "Explain what remembered knowledge means",
      "Write a story about deleting remembered knowledge",
      "Do you support erasing remembered knowledge?",
    ];

    const results = yield* Effect.forEach(messages, (message, index) =>
      admitManagedConversation(
        {
          authorization: exhaustedAuthorization(),
          idempotencyKey: `ordinary-request-${index}`,
          message,
          routeId,
          submissionId: ThinkSubmissionId.make(`ordinary-submission-${index}`),
        },
        { currentSessionId: SessionId.make("session-1"), routeId },
      ),
    );

    expect(results).toEqual(
      messages.map(() =>
        expect.objectContaining({
          _tag: "ManagedConversationDenied",
          reason: "allowanceExhausted",
        }),
      ),
    );
  }),
);

it.effect("denies an ordinary conversation turn after ordinary exhaustion", () =>
  Effect.gen(function* () {
    const result = yield* admitManagedConversation(
      {
        authorization: exhaustedAuthorization(),
        idempotencyKey: "ordinary-request-1",
        message: "Tell me a joke",
        routeId,
        submissionId: ThinkSubmissionId.make("ordinary-submission-1"),
      },
      { currentSessionId: SessionId.make("session-1"), routeId },
    );

    expect(result).toMatchObject({
      _tag: "ManagedConversationDenied",
      reason: "allowanceExhausted",
    });
  }),
);

const exhaustedAuthorization = (): AuthorizationContext => {
  const userId = UserId.make("user-1");
  const authSessionId = AuthSessionId.make("auth-session-1");
  const planPolicyVersion = PlanPolicyVersion.make("launch-v1");
  return {
    allowance: {
      _tag: "Metered",
      allowancePeriodId: AllowancePeriodId.make("period-1"),
      endsAt: new Date("2026-09-01T00:00:00.000Z"),
      plan: "free",
      planPolicyVersion,
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      usage: [{ allowanceKind: "vendorUsdMicros", quantity: 250_000n }],
    },
    approval: null,
    authority: {
      _tag: "AuthSession",
      authSessionId,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      userId,
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    integrationConnections: [],
    liveFacts: emptyLiveResourceFacts,
    now: new Date("2026-08-24T12:00:00.000Z"),
    originatingAuthority: { _tag: "AuthSession", authSessionId },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: userId,
    subscription: { plan: "free", planPolicyVersion },
    user: { _tag: "ActiveUser", userId },
  };
};

const userId = UserId.make("managed-conversation-user");
const authSessionId = AuthSessionId.make("managed-conversation-auth-session");
const routeId = ConversationRouteId.make("managed-conversation-route");
const now = new Date("2026-08-23T12:00:00.000Z");
const resetsAt = new Date("2026-09-22T12:00:00.000Z");
const planPolicyVersion = PlanPolicyVersion.make("launch-v1");

const authorizationContext = {
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("managed-conversation-allowance"),
    endsAt: resetsAt,
    plan: "free",
    planPolicyVersion,
    startsAt: now,
    usage: [],
  },
  approval: null,
  authority: { _tag: "AuthSession", authSessionId, expiresAt: resetsAt, userId },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  integrationConnections: [],
  liveFacts: emptyLiveResourceFacts,
  now,
  originatingAuthority: { _tag: "AuthSession", authSessionId },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan: "free", planPolicyVersion },
  user: { _tag: "ActiveUser", userId },
} satisfies AuthorizationContext;

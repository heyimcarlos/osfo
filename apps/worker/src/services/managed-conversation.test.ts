/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed times prove the boundary; assertions execute inside the Effect returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

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
import { admitManagedConversation } from "./managed-conversation";

it.effect("admits a bounded unmetered deletion-request turn after ordinary exhaustion", () =>
  Effect.gen(function* () {
    const routeId = ConversationRouteId.make("route-1");
    const sessionId = SessionId.make("session-1");
    const result = yield* admitManagedConversation(
      {
        authorization: exhaustedAuthorization(),
        idempotencyKey: "request-1",
        message: "Delete my current session",
        routeId,
        submissionId: ThinkSubmissionId.make("submission-1"),
      },
      { currentSessionId: sessionId, routeId },
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

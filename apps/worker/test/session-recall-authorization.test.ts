import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { ConversationRouteId, SessionId, ThinkSubmissionId, UserId } from "../src/domain";
import { ManagedTurnMetadata } from "../src/domain/managed-conversation";
import {
  makeSessionRecallAuthorization,
  SessionRecallCurrentAuthorizationFacts,
} from "../src/services/session-recall-authorization";

const userId = UserId.make("user-recall-authorization");
const routeId = ConversationRouteId.make("route-recall-authorization");
const sessionId = SessionId.make("session-recall-authorization");
const metadata = Schema.decodeSync(ManagedTurnMetadata)({
  _tag: "OsfoManagedTurn",
  allowancePeriodId: "period-recall-authorization",
  authorityIdentity: {
    _tag: "AuthSession",
    authSessionId: "auth-session-recall-authorization",
    userId,
  },
  conservativeVendorUsdMicros: 30_000,
  maxInputTokens: 32_000,
  maxOutputTokens: 4_000,
  maxRetries: 0,
  maxSteps: 6,
  plan: "free",
  planPolicyVersion: "launch-v1",
  route: "dynamic/osfo-free-v1",
  routeId,
  sessionId,
  submissionId: ThinkSubmissionId.make("submission-recall-authorization"),
  targetInputTokens: 18_000,
});

const currentFacts = (authority: "active" | "revoked" = "active") =>
  Schema.decodeSync(SessionRecallCurrentAuthorizationFacts)({
    authority:
      authority === "active"
        ? ({
            _tag: "AuthSession" as const,
            authSessionId: "auth-session-recall-authorization",
            expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")),
            userId,
          } as const)
        : ({
            _tag: "RevokedAuthSession" as const,
            authSessionId: "auth-session-recall-authorization",
            userId,
          } as const),
    deletionAccess: { _tag: "DeletionAccessAvailable" as const },
    now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T00:00:00.000Z")),
    resourceOwnerUserId: userId,
    subscription: { plan: "free" as const, planPolicyVersion: "launch-v1" as const },
    user: { _tag: "ActiveUser" as const, userId },
  });

describe("Session Recall current authorization", () => {
  it.effect("refreshes mutable authority on every invocation and stops after revocation", () =>
    Effect.gen(function* () {
      let inspections = 0;
      const authorization = makeSessionRecallAuthorization({
        inspectAuthorization: () =>
          Effect.sync(() => currentFacts(inspections++ === 0 ? "active" : "revoked")),
        readCurrentSession: () => Effect.succeed(sessionId),
      });

      yield* authorization.authorize(metadata);
      const denied = yield* authorization.authorize(metadata).pipe(Effect.flip);

      expect(inspections).toBe(2);
      expect(denied).toMatchObject({
        _tag: "SessionRecallAuthorizationDenied",
        reason: "authorityRevoked",
      });
    }),
  );

  it.effect("denies a replaced active Session before reading external authority", () =>
    Effect.gen(function* () {
      let inspections = 0;
      const authorization = makeSessionRecallAuthorization({
        inspectAuthorization: () => {
          inspections += 1;
          return Effect.succeed(currentFacts());
        },
        readCurrentSession: () => Effect.succeed(SessionId.make("session-replaced")),
      });

      const denied = yield* authorization.authorize(metadata).pipe(Effect.flip);

      expect(inspections).toBe(0);
      expect(denied).toMatchObject({
        _tag: "SessionRecallAuthorizationDenied",
        reason: "authorityMismatch",
        routeId,
        sessionId,
      });
    }),
  );
});

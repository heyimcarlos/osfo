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

/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed authority fixtures prove admission output inside the Effect callback. */

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

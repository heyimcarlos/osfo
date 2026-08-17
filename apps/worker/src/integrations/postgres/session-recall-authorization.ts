import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Predicate, Schema } from "effect";

import * as AccountAuthorities from "../../composition/account-authorities";
import * as Db from "../../db";
import type { AgentId } from "../../domain";
import type { ManagedTurnAuthorityIdentity } from "../../domain/managed-conversation";
import * as AgentDirectory from "../../services/agent-directory";
import { SessionRecallCurrentAuthorizationFacts } from "../../services/session-recall-authorization";
import { SessionRecallAuthorizationUnavailable } from "../../services/session-recall";

/** Read current Session Recall authorization facts from their authoritative PostgreSQL owners. */
export const inspect = (agentId: AgentId, identity: ManagedTurnAuthorityIdentity) =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    const authorities = yield* AccountAuthorities.make;
    const directory = yield* AgentDirectory.make;
    const owner = yield* directory.resolveAgent(agentId);
    const authority = Predicate.isTagged(identity, "AuthSession")
      ? yield* authorities.authSessions.inspect(identity.userId, identity.authSessionId)
      : Predicate.isTagged(identity, "ChannelBinding")
        ? yield* authorities.channelBindings.inspect(identity.userId, identity.channelBindingId)
        : identity;
    const [deletionAccess, user, subscriptionRows, now] = yield* Effect.all([
      authorities.deletionCases.inspect(identity.userId),
      authorities.userSuspensions.inspect(identity.userId),
      Db.execute("inspectBillingSubscription", () =>
        database
          .select({
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.planPolicyVersion,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.userId, identity.userId))
          .limit(1),
      ),
      DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    ]);
    const subscription = subscriptionRows[0];
    if (subscription === undefined) {
      return yield* new SessionRecallAuthorizationUnavailable({
        cause: { userId: identity.userId },
        message: "Current Session Recall subscription facts are unavailable",
      });
    }
    return yield* Schema.decodeEffect(SessionRecallCurrentAuthorizationFacts)({
      authority,
      deletionAccess,
      now,
      resourceOwnerUserId: owner.userId,
      subscription,
      user,
    });
  }).pipe(
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "SessionRecallAuthorizationUnavailable")
        ? cause
        : new SessionRecallAuthorizationUnavailable({
            cause,
            message: "Current Session Recall authorization facts are unavailable",
          }),
    ),
  );

import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Predicate, Schema } from "effect";

import { AccountAuthorities } from "../../composition/account-authorities";
import { Db } from "../../db";
import type { AgentId } from "../../domain";
import type { ManagedTurnAuthorityIdentity } from "../../domain/managed-conversation";
import { AgentDirectory } from "../../services/agent-directory";
import { SessionRecallCurrentAuthorizationFacts } from "../../services/session-recall-authorization";
import { SessionRecallAuthorizationUnavailable } from "../../services/session-recall";
import { ChannelLinks } from "../../services/channel-links";

/** Read current Session Recall authorization facts from their authoritative PostgreSQL owners. */
export const inspect = (agentId: AgentId, identity: ManagedTurnAuthorityIdentity) =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    const authorities = yield* AccountAuthorities.make;
    const channelLinks = yield* ChannelLinks.Service;
    const directory = yield* AgentDirectory.make;
    const owner = yield* directory.resolveAgent(agentId);
    const authority = Predicate.isTagged(identity, "AuthSession")
      ? yield* authorities.authSessions.inspect(identity.userId, identity.authSessionId)
      : Predicate.isTagged(identity, "ChannelLink")
        ? yield* inspectChannelLink(channelLinks, identity)
        : identity;
    const [deletionAccess, user, subscriptionRows, now] = yield* Effect.all([
      authorities.deletionCases.inspect(identity.userId),
      authorities.userSuspensions.inspect(identity.userId),
      Db.execute("inspectBillingSubscription", () =>
        database
          .select({
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.plan_policy_version,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, identity.userId))
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

const inspectChannelLink = (
  channelLinks: Pick<ChannelLinks.Interface, "resolve">,
  identity: Extract<ManagedTurnAuthorityIdentity, { readonly _tag: "ChannelLink" }>,
) =>
  channelLinks.resolve(identity.address).pipe(
    Effect.map((link) =>
      link !== null &&
      link.channelLinkId === identity.channelLinkId &&
      link.userId === identity.userId
        ? ({
            _tag: "ChannelLink",
            address: identity.address,
            channelLinkId: identity.channelLinkId,
            userId: identity.userId,
          } as const)
        : ({
            _tag: "RevokedChannelLink",
            address: identity.address,
            channelLinkId: identity.channelLinkId,
            userId: identity.userId,
          } as const),
    ),
  );

export * as SessionRecallAuthorizationPostgres from "./session-recall-authorization";

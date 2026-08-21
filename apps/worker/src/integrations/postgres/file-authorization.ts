import { agents } from "@osfo/db/schema/agents";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { and, eq } from "drizzle-orm";
import { Effect, Predicate, Schema } from "effect";

import type { Database } from "../../db";
import type { AgentId } from "../../domain";
import { PlanPolicyVersion, UserId } from "../../domain";
import { AuthorizationContext } from "../../services/authorization";
import type { ChannelLinks } from "../../services/channel-links";

/** Expected failure when current persisted file-authorization facts cannot be loaded. */
export class CurrentFileAuthorizationUnavailable extends Schema.TaggedError<CurrentFileAuthorizationUnavailable>()(
  "CurrentFileAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Load current persisted authority, User, subscription, and named-Agent ownership facts. */
export const loadCurrentFileAuthorization = (
  database: Database,
  channelLinks: Pick<ChannelLinks.Interface, "resolve">,
  agentId: AgentId,
  context: AuthorizationContext,
  now: Date,
): Effect.Effect<AuthorizationContext, CurrentFileAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const [userRows, agentRows, subscriptionRows] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          database
            .select({ userId: users.id })
            .from(users)
            .where(eq(users.id, context.user.userId))
            .limit(1),
          database
            .select({ userId: agents.user_id })
            .from(agents)
            .where(eq(agents.agent_id, agentId))
            .limit(1),
          database
            .select({
              plan: billingSubscriptions.plan,
              planPolicyVersion: billingSubscriptions.plan_policy_version,
              userId: billingSubscriptions.user_id,
            })
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.user_id, context.user.userId))
            .limit(1),
        ]),
      catch: (cause) => unavailable(cause),
    });
    const user = userRows[0];
    const agent = agentRows[0];
    const subscription = subscriptionRows[0];
    if (user === undefined || agent === undefined || subscription === undefined) {
      return yield* unavailable("A required current file-authorization fact does not exist");
    }
    const userId = yield* Schema.decodeEffect(UserId)(user.userId).pipe(
      Effect.mapError(unavailable),
    );
    const authority = yield* loadCurrentAuthority(channelLinks, database, context.authority, now);
    return yield* Schema.decodeEffect(AuthorizationContext)({
      ...context,
      authority: agent.userId === userId ? authority : null,
      // Launch has no separate stores for these facts, so a known restriction must survive recheck.
      deletionAccess: Predicate.isTagged(context.deletionAccess, "DeletionAccessRevoked")
        ? context.deletionAccess
        : { _tag: "DeletionAccessAvailable" },
      now,
      subscription: {
        plan: subscription.plan,
        planPolicyVersion: PlanPolicyVersion.make(subscription.planPolicyVersion),
      },
      user: Predicate.isTagged(context.user, "SuspendedUser")
        ? context.user
        : { _tag: "ActiveUser", userId },
    }).pipe(Effect.mapError(unavailable));
  });

const loadCurrentAuthority = (
  channelLinks: Pick<ChannelLinks.Interface, "resolve">,
  database: Database,
  authority: AuthorizationContext["authority"],
  now: Date,
) => {
  if (authority === null || Predicate.isTagged(authority, "DurableTrigger")) {
    return Effect.succeed(authority);
  }
  if (
    Predicate.isTagged(authority, "AuthSession") ||
    Predicate.isTagged(authority, "RevokedAuthSession")
  ) {
    return Effect.tryPromise({
      try: () =>
        database
          .select({ expiresAt: sessions.expiresAt, userId: sessions.userId })
          .from(sessions)
          .where(
            and(eq(sessions.id, authority.authSessionId), eq(sessions.userId, authority.userId)),
          )
          .limit(1),
      catch: (cause) => unavailable(cause),
    }).pipe(
      Effect.map(([session]) =>
        session !== undefined && session.expiresAt > now
          ? ({
              _tag: "AuthSession",
              authSessionId: authority.authSessionId,
              expiresAt: session.expiresAt,
              userId: authority.userId,
            } as const)
          : ({
              _tag: "RevokedAuthSession",
              authSessionId: authority.authSessionId,
              userId: authority.userId,
            } as const),
      ),
    );
  }
  if (
    Predicate.isTagged(authority, "ChannelLink") ||
    Predicate.isTagged(authority, "RevokedChannelLink")
  ) {
    return channelLinks.resolve(authority.address).pipe(
      Effect.mapError(unavailable),
      Effect.map((link) =>
        link !== null &&
        link.channelLinkId === authority.channelLinkId &&
        link.userId === authority.userId
          ? ({
              _tag: "ChannelLink",
              address: authority.address,
              channelLinkId: authority.channelLinkId,
              userId: authority.userId,
            } as const)
          : ({
              _tag: "RevokedChannelLink",
              address: authority.address,
              channelLinkId: authority.channelLinkId,
              userId: authority.userId,
            } as const),
      ),
    );
  }
  return Effect.succeed(authority);
};

const unavailable = (cause: unknown) =>
  new CurrentFileAuthorizationUnavailable({
    cause,
    message: "Current file authorization facts are unavailable",
  });

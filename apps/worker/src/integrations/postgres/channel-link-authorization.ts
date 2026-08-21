import { agents } from "@osfo/db/schema/agents";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { and, eq } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import { Db } from "../../db";
import { BillingDb } from "../../db/billing";
import { type AgentId, type ChannelLinkId, UserId } from "../../domain";
import type { ChannelAddress } from "../../domain/channel-link";
import { AuthorizationContext } from "../../services/authorization";
import { ChannelLinks } from "../../services/channel-links";
import { DeletionCasePostgres } from "./deletion-case";
import { UserSuspensionPostgres } from "./user-suspension";

/** Expected failure while reading current Channel Link authorization. */
export class ChannelLinkAuthorizationUnavailable extends Schema.TaggedError<ChannelLinkAuthorizationUnavailable>()(
  "ChannelLinkAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Build the current authorization context for one fixed Channel Link route. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const billing = BillingDb.make(database);
  const channelLinks = yield* ChannelLinks.Service;
  const deletionCases = yield* DeletionCasePostgres.make;
  const userSuspensions = yield* UserSuspensionPostgres.make;

  const admit = (fixedRoute: {
    readonly agentId: AgentId;
    readonly address: typeof ChannelAddress.Type;
    readonly channelLinkId: ChannelLinkId;
    readonly userId: UserId;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      const link = yield* channelLinks
        .resolve(fixedRoute.address)
        .pipe(Effect.mapError(unavailable));
      const facts = yield* Db.execute("inspectChannelLinkAuthorization", () =>
        database
          .select({
            agentId: agents.agent_id,
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.plan_policy_version,
            userId: agents.user_id,
          })
          .from(agents)
          .innerJoin(billingSubscriptions, eq(billingSubscriptions.user_id, agents.user_id))
          .where(
            and(eq(agents.agent_id, fixedRoute.agentId), eq(agents.user_id, fixedRoute.userId)),
          )
          .limit(1),
      ).pipe(Effect.mapError((cause) => unavailable(cause)));
      const record = facts[0];
      if (record === undefined) return yield* unavailable({ fixedRoute });
      const userId = yield* Schema.decodeEffect(UserId)(record.userId).pipe(
        Effect.mapError(unavailable),
      );
      const current =
        link !== null &&
        link.channelLinkId === fixedRoute.channelLinkId &&
        link.userId === fixedRoute.userId;
      const [allowance, deletionAccess, user] = yield* Effect.all([
        billing.admit(userId, now),
        deletionCases.inspect(userId),
        userSuspensions.inspect(userId),
      ]);
      return yield* Schema.decodeEffect(AuthorizationContext)({
        allowance: { _tag: "Metered", ...allowance },
        approval: null,
        authority: current
          ? {
              _tag: "ChannelLink",
              address: fixedRoute.address,
              channelLinkId: fixedRoute.channelLinkId,
              userId,
            }
          : {
              _tag: "RevokedChannelLink",
              address: fixedRoute.address,
              channelLinkId: fixedRoute.channelLinkId,
              userId,
            },
        deletionAccess,
        gmailConnection: null,
        liveFacts: {
          activeGmSummonsInSession: 0n,
          activeReminders: 0n,
          concurrentWorkflows: 0n,
          retainedFileBytes: 0n,
        },
        now,
        originatingAuthority: { _tag: "ChannelLink", channelLinkId: fixedRoute.channelLinkId },
        requestVendorUsdMicros: 0n,
        resourceOwnerUserId: userId,
        subscription: { plan: record.plan, planPolicyVersion: record.planPolicyVersion },
        user,
      }).pipe(Effect.mapError((cause) => unavailable(cause)));
    });

  return { admit };
});

const unavailable = (cause: unknown) =>
  new ChannelLinkAuthorizationUnavailable({
    cause,
    message: "PostgreSQL could not load Channel Link authorization facts",
  });

export * as ChannelLinkAuthorizationPostgres from "./channel-link-authorization";

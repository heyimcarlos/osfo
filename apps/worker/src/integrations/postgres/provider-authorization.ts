import { agents } from "@osfo/db/schema/agents";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import { database } from "../../db";
import * as Billing from "../../db/billing";
import { type AgentId, type ChannelBindingId, UserId } from "../../domain";
import type { ChannelProvider } from "../../services/onboarding";
import { AuthorizationContext } from "../../services/authorization";
import { readBinding } from "./channel-binding";
import * as DeletionCasePostgres from "./deletion-case";
import * as UserSuspensionPostgres from "./user-suspension";

/** Expected failure while reading current provider Channel Binding authorization. */
export class ProviderAuthorizationPersistenceUnavailable extends Schema.TaggedError<ProviderAuthorizationPersistenceUnavailable>()(
  "ProviderAuthorizationPersistenceUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    provider: Schema.Literals(["telegram", "whatsapp"]),
  },
) {}

/** Construct current Channel Binding authorization for either admitted provider. */
export const make = (options: {
  readonly now?: Effect.Effect<Date>;
  readonly provider: ChannelProvider;
}) =>
  Effect.gen(function* () {
    const db = yield* database;
    const billing = Billing.make(db);
    const deletionCases = yield* DeletionCasePostgres.make;
    const userSuspensions = yield* UserSuspensionPostgres.make;

    const admit = (fixedRoute: {
      readonly _tag: "Bound";
      readonly agentId: AgentId;
      readonly channelBindingId: ChannelBindingId;
    }) =>
      Effect.gen(function* () {
        const now = yield* options.now ?? DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
        const facts = yield* Effect.tryPromise({
          // oxlint-disable-next-line effecttsgo/async-function -- This adapter composes related Drizzle reads at one boundary.
          try: async () => {
            const binding = await readBinding(db, options.provider, fixedRoute.channelBindingId);
            if (binding === null) return null;
            const [record] = await db
              .select({
                agentId: agents.agentId,
                plan: billingSubscriptions.plan,
                planPolicyVersion: billingSubscriptions.planPolicyVersion,
              })
              .from(agents)
              .innerJoin(billingSubscriptions, eq(billingSubscriptions.userId, agents.userId))
              .where(eq(agents.userId, binding.userId))
              .limit(1);
            return record === undefined ? null : { ...binding, ...record };
          },
          catch: (cause) => unavailable(options.provider, cause),
        });
        if (facts === null || facts.agentId !== fixedRoute.agentId) {
          return yield* unavailable(options.provider, { facts, fixedRoute });
        }
        const userId = UserId.make(facts.userId);
        const [allowance, deletionAccess, user] = yield* Effect.all([
          billing.admit(userId, now),
          deletionCases.inspect(userId),
          userSuspensions.inspect(userId),
        ]);
        return yield* Schema.decodeEffect(AuthorizationContext)({
          allowance: { _tag: "Metered", ...allowance },
          approval: null,
          authority:
            facts.revokedAt === null
              ? { _tag: "ChannelBinding", channelBindingId: facts.channelBindingId, userId }
              : { _tag: "RevokedChannelBinding", channelBindingId: facts.channelBindingId, userId },
          deletionAccess,
          gmailConnection: null,
          liveFacts: {
            activeGmSummonsInSession: 0n,
            activeReminders: 0n,
            concurrentWorkflows: 0n,
            retainedFileBytes: 0n,
          },
          now,
          originatingAuthority: {
            _tag: "ChannelBinding",
            channelBindingId: facts.channelBindingId,
          },
          requestVendorUsdMicros: 0n,
          resourceOwnerUserId: userId,
          subscription: { plan: facts.plan, planPolicyVersion: facts.planPolicyVersion },
          user,
        }).pipe(Effect.mapError((cause) => unavailable(options.provider, cause)));
      });

    return { admit };
  });

const unavailable = (provider: ChannelProvider, cause: unknown) =>
  new ProviderAuthorizationPersistenceUnavailable({
    cause,
    message: "PostgreSQL could not load provider authorization facts",
    provider,
  });

import { Clock, DateTime, Effect, Predicate, Schema } from "effect";

import type { ChannelBindingId, UserId } from "../domain";
import type { DbUnavailable } from "../db";
import { ActionId } from "../domain/action-execution";
import type { ActionExecutionResult } from "../domain/action-execution";
import type { AuthSessionId } from "../domain/auth-session";
import type { AuthorizationOperation as AuthorizationOperationType } from "../domain/authorization-operation";
import type { AuthSession } from "./auth-session";
import type { ChannelBinding } from "./channel-binding";
import type { DeletionCase } from "./deletion-case";
import type { UserSuspension } from "./user-suspension";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Authority identities use the _tag discriminator. */

/** Failure while an owning module reloads one current protected-effect fact. */
export class ProtectedEffectFactUnavailable extends Schema.TaggedError<ProtectedEffectFactUnavailable>()(
  "ProtectedEffectFactUnavailable",
  { fact: Schema.String, message: Schema.String },
) {}

/** Stable identities retained from admission for one authority-protected effect. */
export type ProtectedEffectIdentities =
  | {
      readonly _tag: "AuthSession";
      readonly authSessionId: AuthSessionId;
      readonly userId: UserId;
    }
  | {
      readonly _tag: "ChannelBinding";
      readonly channelBindingId: ChannelBindingId;
      readonly userId: UserId;
    };

/** Operation-bound facts that remain stable across the short Approval wait. */
export interface ProtectedEffectContext {
  readonly requestVendorUsdMicros: bigint;
}

type CurrentFact<A> = Effect.Effect<A, ProtectedEffectFactUnavailable>;

/** Current exact Approval owner. */
export interface ApprovalOwner {
  readonly inspect: (
    userId: UserId,
    operation: AuthorizationOperationType,
  ) => CurrentFact<AuthorizationContext["approval"]>;
}

/** Current Integration Connection owner. */
export interface IntegrationConnectionOwner {
  readonly inspectGmail: (userId: UserId) => CurrentFact<AuthorizationContext["gmailConnection"]>;
}

/** Current live resource owner. */
export interface LiveResourceOwner {
  readonly inspect: (
    userId: UserId,
    operation: AuthorizationOperationType,
  ) => CurrentFact<AuthorizationContext["liveFacts"]>;
}

/** Current resource ownership owner. */
export interface ResourceOwnershipOwner {
  readonly inspect: (
    userId: UserId,
    operation: AuthorizationOperationType,
  ) => CurrentFact<AuthorizationContext["resourceOwnerUserId"]>;
}

/** Current Subscription and Plan Entitlement owner. */
export interface SubscriptionOwner {
  readonly inspect: (userId: UserId) => CurrentFact<AuthorizationContext["subscription"]>;
}

/** Separate current authority owners used by protected-effect rechecks. */
export interface AuthorityOwners {
  readonly approvals: ApprovalOwner;
  readonly authSessions: Pick<AuthSession.Interface, "inspect">;
  readonly channelBindings: Pick<ChannelBinding.Interface, "inspect">;
  readonly deletionCases: Pick<DeletionCase.Interface, "inspect">;
  readonly integrationConnections: IntegrationConnectionOwner;
  readonly liveResources: LiveResourceOwner;
  readonly resourceOwnership: ResourceOwnershipOwner;
  readonly subscriptions: SubscriptionOwner;
  readonly userSuspensions: Pick<UserSuspension.Interface, "inspect">;
}

/** Protected-effect executor that constructs current authority facts internally. */
export interface Interface {
  readonly executeThinkApprovedAction: (
    context: ProtectedEffectContext,
    identities: ProtectedEffectIdentities,
    operation: AuthorizationOperationType,
    contactProvider: (actionId: ActionId) => Effect.Effect<ActionExecutionResult>,
  ) => Effect.Effect<
    ActionExecutionResult | Denied,
    AuthSession.AuthSessionUnavailable | DbUnavailable | ProtectedEffectFactUnavailable
  >;
}

/** Construct the protected-effect executor from separate current authority owners. */
export const make = (authorization: Authorization, owners: AuthorityOwners): Interface => ({
  executeThinkApprovedAction: (context, identities, operation, contactProvider) => {
    return Effect.gen(function* () {
      const [
        approval,
        authority,
        deletionAccess,
        gmailConnection,
        liveFacts,
        resourceOwnerUserId,
        subscription,
        user,
        nowMillis,
      ] = yield* Effect.all([
        owners.approvals.inspect(identities.userId, operation),
        inspectAuthority(owners, identities),
        owners.deletionCases.inspect(identities.userId),
        owners.integrationConnections.inspectGmail(identities.userId),
        owners.liveResources.inspect(identities.userId, operation),
        owners.resourceOwnership.inspect(identities.userId, operation),
        owners.subscriptions.inspect(identities.userId),
        owners.userSuspensions.inspect(identities.userId),
        Clock.currentTimeMillis,
      ]);
      const recheck = authorization.recheck(
        {
          allowance: { _tag: "Unavailable" },
          approval,
          authority,
          deletionAccess,
          gmailConnection,
          liveFacts,
          now: DateTime.toDateUtc(DateTime.makeUnsafe(nowMillis)),
          originatingAuthority:
            identities._tag === "AuthSession"
              ? { _tag: "AuthSession", authSessionId: identities.authSessionId }
              : { _tag: "ChannelBinding", channelBindingId: identities.channelBindingId },
          requestVendorUsdMicros: context.requestVendorUsdMicros,
          resourceOwnerUserId,
          subscription,
          user,
        },
        operation,
      );
      if (Predicate.isTagged(recheck, "Denied")) return recheck;
      return yield* contactProvider(ActionId.make(operation.actionId));
    });
  },
});

const inspectAuthority = (owners: AuthorityOwners, identities: ProtectedEffectIdentities) =>
  identities._tag === "AuthSession"
    ? owners.authSessions.inspect(identities.userId, identities.authSessionId)
    : owners.channelBindings.inspect(identities.userId, identities.channelBindingId);

export * as ActionExecutor from "./action-executor";

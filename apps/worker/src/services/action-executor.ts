import { Clock, DateTime, Effect, Predicate, Schema } from "effect";

import type { ChannelBindingId, UserId } from "../domain";
import type { DbUnavailable } from "../db";
import { ActionId } from "../domain/action-execution";
import type { ActionExecutionResult } from "../domain/action-execution";
import type { AuthSessionId } from "../domain/auth-session";
import { AuthorizationOperation } from "../domain/authorization-operation";
import type * as AuthSession from "./auth-session";
import type * as ChannelBinding from "./channel-binding";
import type * as DeletionCase from "./deletion-case";
import type * as UserSuspension from "./user-suspension";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Authority identities use the _tag discriminator. */

/** Exact Action execution that Think released from one durable Approval. */
export const ThinkApprovedActionExecution = Schema.TaggedStruct("ThinkApprovedActionExecution", {
  actionId: ActionId,
  operation: Schema.Literal("gmail.send"),
});

/** Exact Action execution that Think released from one durable Approval. */
export type ThinkApprovedActionExecution = typeof ThinkApprovedActionExecution.Type;

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

/** Admitted facts that are stable across the short Approval wait. */
export type ProtectedEffectContext = Omit<
  AuthorizationContext,
  "approval" | "authority" | "deletionAccess" | "now" | "originatingAuthority" | "user"
>;

/** Separate current authority owners used by protected-effect rechecks. */
export interface AuthorityOwners {
  readonly authSessions: Pick<AuthSession.Interface, "inspect">;
  readonly channelBindings: Pick<ChannelBinding.Interface, "inspect">;
  readonly deletionCases: Pick<DeletionCase.Interface, "inspect">;
  readonly userSuspensions: Pick<UserSuspension.Interface, "inspect">;
}

/** Protected-effect executor that constructs current authority facts internally. */
export interface Interface {
  readonly executeThinkApprovedAction: (
    context: ProtectedEffectContext,
    identities: ProtectedEffectIdentities,
    approvedExecution: ThinkApprovedActionExecution,
    contactProvider: (actionId: ActionId) => Effect.Effect<ActionExecutionResult>,
  ) => Effect.Effect<
    ActionExecutionResult | Denied,
    AuthSession.AuthSessionUnavailable | DbUnavailable
  >;
}

/** Construct the protected-effect executor from separate current authority owners. */
export const make = (authorization: Authorization, owners: AuthorityOwners): Interface => ({
  executeThinkApprovedAction: (context, identities, approvedExecution, contactProvider) => {
    const operation = AuthorizationOperation.make({
      actionId: approvedExecution.actionId,
      kind: approvedExecution.operation,
    });
    return Effect.gen(function* () {
      const [authority, deletionAccess, user, nowMillis] = yield* Effect.all([
        inspectAuthority(owners, identities),
        owners.deletionCases.inspect(identities.userId),
        owners.userSuspensions.inspect(identities.userId),
        Clock.currentTimeMillis,
      ]);
      const recheck = authorization.recheck(
        {
          ...context,
          approval: {
            actionId: approvedExecution.actionId,
            operation: approvedExecution.operation,
            userId: identities.userId,
          },
          authority,
          deletionAccess,
          now: DateTime.toDateUtc(DateTime.makeUnsafe(nowMillis)),
          originatingAuthority:
            identities._tag === "AuthSession"
              ? { _tag: "AuthSession", authSessionId: identities.authSessionId }
              : { _tag: "ChannelBinding", channelBindingId: identities.channelBindingId },
          user,
        },
        operation,
      );
      if (Predicate.isTagged(recheck, "Denied")) return recheck;
      return yield* contactProvider(approvedExecution.actionId);
    });
  },
});

const inspectAuthority = (owners: AuthorityOwners, identities: ProtectedEffectIdentities) =>
  identities._tag === "AuthSession"
    ? owners.authSessions.inspect(identities.userId, identities.authSessionId)
    : owners.channelBindings.inspect(identities.userId, identities.channelBindingId);

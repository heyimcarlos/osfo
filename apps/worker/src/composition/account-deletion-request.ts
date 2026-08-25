import type { AccountDeletionActionPresentation } from "@osfo/api";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Option, Predicate, Schema } from "effect";

import { Db } from "../db";
import { PlanPolicyVersion, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { ActionId } from "../domain/action-execution";
import { retainedCatalog } from "../domain/plan-policy";
import { AccountDeletion } from "../services/account-deletion";
import {
  approvalFor,
  ApprovalPresentation,
  Authorization,
  AuthorizationContext,
  emptyLiveResourceFacts,
} from "../services/authorization";
import { AccountAuthorities } from "./account-authorities";

/** Compose the complete self-service account-deletion workflow behind the HTTP boundary. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const authorities = yield* AccountAuthorities.make;
  const deletion = yield* AccountDeletion.Service;
  const present = Effect.fn("AccountDeletionRequest.present")(
    (input: { readonly authSessionId: string }) =>
      Effect.succeed(accountDeletionPresentation(AuthSessionId.make(input.authSessionId))),
  );
  const request = Effect.fn("AccountDeletionRequest.request")(function* (input: {
    readonly approval: {
      readonly decision: "approved";
      readonly presentation: AccountDeletionPresentation;
    };
    readonly authSessionId: string;
    readonly confirmation: string;
    readonly userId: string;
  }) {
    const userId = UserId.make(input.userId);
    const authSessionId = AuthSessionId.make(input.authSessionId);
    const expectedPresentation = accountDeletionPresentation(authSessionId);
    if (!isExactApproval(input, expectedPresentation)) {
      return yield* unavailable("approvalPresentation");
    }
    const presentation = ApprovalPresentation.make(
      encodeAccountDeletionPresentation(expectedPresentation),
    );
    const operation = {
      actionId: ActionId.make(expectedPresentation.actionId),
      kind: "account.delete",
    } as const;
    const [authority, deletionAccess, subscriptionRows, user, now] = yield* Effect.all([
      authorities.authSessions.inspect(userId, authSessionId),
      authorities.deletionCases.inspect(userId),
      Db.execute("inspectBillingSubscription", () =>
        database
          .select({
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.plan_policy_version,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, userId))
          .limit(1),
      ),
      authorities.userSuspensions.inspect(userId),
      DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    ]);
    const subscription = subscriptionRows[0];
    if (subscription === undefined) return yield* unavailable("authorize");
    const admission = Authorization.make(retainedCatalog).admit(
      AuthorizationContext.make({
        allowance: { _tag: "Unavailable" },
        approval: approvalFor(userId, operation, presentation),
        authority,
        deletionAccess,
        gmailConnection: null,
        integrationConnections: [],
        liveFacts: emptyLiveResourceFacts,
        now,
        originatingAuthority: { _tag: "AuthSession", authSessionId },
        requestVendorUsdMicros: 0n,
        resourceOwnerUserId: userId,
        subscription: {
          plan: subscription.plan,
          planPolicyVersion: PlanPolicyVersion.make(subscription.planPolicyVersion),
        },
        user,
      }),
      operation,
    );
    if (!Predicate.isTagged(admission, "Admitted")) return yield* unavailable("authorize");
    const requested = yield* authorities.deletionCases.requestSelf(
      userId,
      {
        actionId: operation.actionId,
        presentation,
      },
      {
        authSessionId,
        plan: subscription.plan,
        planPolicyVersion: PlanPolicyVersion.make(subscription.planPolicyVersion),
      },
    );
    if (
      Predicate.isTagged(requested, "UserMissing") ||
      Predicate.isTagged(requested, "DeletionAuthorityChanged")
    )
      return yield* unavailable("fence");
    yield* deletion
      .reconcileUser(userId)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Account deletion remains pending").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      );
    return undefined;
  });
  return { present, request };
});

type AccountDeletionPresentation = AccountDeletionActionPresentation;

const accountDeletionActionDefinition = {
  confirmation: "delete-my-account",
  consequence: "Permanently delete this account and all of its data",
  operation: "account.delete",
  title: "Delete account",
} as const;

const ExactAccountDeletionActionPresentation = Schema.Struct({
  actionId: Schema.String,
  confirmation: Schema.Literal(accountDeletionActionDefinition.confirmation),
  consequence: Schema.Literal(accountDeletionActionDefinition.consequence),
  operation: Schema.Literal(accountDeletionActionDefinition.operation),
  title: Schema.Literal(accountDeletionActionDefinition.title),
});

const encodeAccountDeletionPresentation = Schema.encodeSync(
  Schema.fromJsonString(ExactAccountDeletionActionPresentation),
);

export const accountDeletionPresentation = (authSessionId: AuthSessionId) => ({
  actionId: `account-delete:${authSessionId}`,
  ...accountDeletionActionDefinition,
});

export const isExactApproval = (
  received: {
    readonly approval: { readonly presentation: AccountDeletionPresentation };
    readonly confirmation: string;
  },
  expected: AccountDeletionPresentation,
) =>
  received.confirmation === accountDeletionActionDefinition.confirmation &&
  Option.isSome(
    Schema.decodeUnknownOption(ExactAccountDeletionActionPresentation)(
      received.approval.presentation,
    ),
  ) &&
  received.approval.presentation.actionId === expected.actionId;

const unavailable = (operation: string) =>
  new AccountDeletion.AccountDeletionUnavailable({
    cause: operation,
    message: "Account deletion could not be started",
    operation,
  });

export * as AccountDeletionRequest from "./account-deletion-request";

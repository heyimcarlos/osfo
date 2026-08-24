import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Predicate } from "effect";

import { Db } from "../db";
import { PlanPolicyVersion, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { ActionId } from "../domain/action-execution";
import { retainedCatalog } from "../domain/plan-policy";
import { MemoryProvider } from "../services/memory-provider";
import { AccountDeletion } from "../services/account-deletion";
import {
  approvalFor,
  ApprovalPresentation,
  Authorization,
  AuthorizationContext,
  emptyLiveResourceFacts,
} from "../services/authorization";
import { AccountAuthorities } from "./account-authorities";
import { AccountDeletionComposition } from "./account-deletion";

/** Compose the complete self-service account-deletion workflow behind the HTTP boundary. */
export const make = (bindings: AccountDeletionComposition.Bindings) =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    const authorities = yield* AccountAuthorities.make;
    const memoryProvider = yield* MemoryProvider.Service;
    const deletion = AccountDeletionComposition.make(database, bindings);
    const request = Effect.fn("AccountDeletionRequest.request")(function* (input: {
      readonly authSessionId: string;
      readonly confirmation: "delete-my-account";
      readonly userId: string;
    }) {
      const userId = UserId.make(input.userId);
      const authSessionId = AuthSessionId.make(input.authSessionId);
      const operation = {
        actionId: ActionId.make(`account-delete:${authSessionId}`),
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
      const presentation = ApprovalPresentation.make(
        `confirmation:${input.confirmation};consequence:Permanently delete this account and all of its data`,
      );
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
          resourceOwnerUserId: null,
          subscription: {
            plan: subscription.plan,
            planPolicyVersion: PlanPolicyVersion.make(subscription.planPolicyVersion),
          },
          user,
        }),
        operation,
      );
      if (!Predicate.isTagged(admission, "Admitted")) return yield* unavailable("authorize");
      const requested = yield* authorities.deletionCases.requestSelf(userId, {
        actionId: operation.actionId,
        presentation,
      });
      if (Predicate.isTagged(requested, "UserMissing")) return yield* unavailable("fence");
      yield* deletion.reconcileUser(userId).pipe(
        Effect.provideService(MemoryProvider.Service, memoryProvider),
        Effect.catch((cause) =>
          Effect.logWarning("Account deletion remains pending").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      );
      return undefined;
    });
    return { request };
  });

const unavailable = (operation: string) =>
  new AccountDeletion.AccountDeletionUnavailable({
    cause: operation,
    message: "Account deletion could not be started",
    operation,
  });

export * as AccountDeletionRequest from "./account-deletion-request";

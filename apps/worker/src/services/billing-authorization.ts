import { Predicate } from "effect";

import type { Plan, PlanPolicyVersion, UserId } from "../domain";
import { retainedCatalog } from "../domain/plan-policy";
import { make as makeAuthorization } from "./authorization";

/** Authenticated and persisted facts required to authorize one billing operation. */
export interface BillingAuthorizationFacts {
  readonly authSessionExpiresAt: Date;
  readonly authSessionId: string;
  readonly deletionAccess:
    | { readonly _tag: "DeletionAccessAvailable" }
    | { readonly _tag: "DeletionAccessRevoked" };
  readonly plan: Plan;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly user:
    | { readonly _tag: "ActiveUser"; readonly userId: UserId }
    | { readonly _tag: "SuspendedUser"; readonly userId: UserId };
  readonly userId: UserId;
}

/** Billing operations admitted through central Authorization. */
export type BillingOperation = "billing.inspect" | "subscription.manage";

/** Admit one billing operation from current AuthSession and Subscription facts. */
export const admit = (facts: BillingAuthorizationFacts, operation: BillingOperation, now: Date) =>
  Predicate.isTagged(
    makeAuthorization(retainedCatalog).admit(
      {
        allowance: { _tag: "Unavailable" },
        approval: null,
        authority: {
          _tag: "AuthSession",
          authSessionId: facts.authSessionId,
          expiresAt: facts.authSessionExpiresAt,
          userId: facts.userId,
        },
        deletionAccess: facts.deletionAccess,
        gmailConnection: null,
        liveFacts: {
          activeGmSummonsInSession: 0n,
          activeReminders: 0n,
          concurrentWorkflows: 0n,
          retainedFileBytes: 0n,
        },
        now,
        originatingAuthority: {
          _tag: "AuthSession",
          authSessionId: facts.authSessionId,
        },
        requestVendorUsdMicros: 0n,
        resourceOwnerUserId: facts.userId,
        subscription: {
          plan: facts.plan,
          planPolicyVersion: facts.planPolicyVersion,
        },
        user: facts.user,
      },
      { actionId: operation, kind: operation },
    ),
    "Admitted",
  );

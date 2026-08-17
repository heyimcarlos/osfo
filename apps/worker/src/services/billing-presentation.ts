import type { BillingSummary } from "@osfo/api";
import { Effect } from "effect";

import type { Plan, UserId } from "../domain";
import type { BillingPersistenceUnavailable } from "./stripe-billing";

/** Stored billing facts required for safe User presentation. */
export interface StoredBillingSummary {
  readonly checkoutPaymentState: "paymentNeeded" | null;
  readonly currentPeriod: { readonly endsAt: Date; readonly startsAt: Date } | null;
  readonly pendingPlan: Plan | null;
  readonly pendingPlanEffectiveAt: Date | null;
  readonly plan: Plan;
}

/** Narrow persistence port for current billing presentation. */
export interface Persistence {
  readonly inspect: (
    userId: UserId,
  ) => Effect.Effect<StoredBillingSummary, BillingPersistenceUnavailable>;
}

/** Safe current billing presentation. */
export interface Interface {
  readonly inspect: (
    userId: UserId,
  ) => Effect.Effect<BillingSummary, BillingPersistenceUnavailable>;
}

/** Construct the safe billing presentation from stored commercial facts. */
export const make = (persistence: Persistence): Interface => ({
  inspect: (userId) =>
    Effect.map(persistence.inspect(userId), (stored) => ({
      currentPlan: stored.plan,
      paymentState:
        stored.pendingPlan !== null
          ? "changeScheduled"
          : stored.plan === "adventurer"
            ? "paid"
            : (stored.checkoutPaymentState ?? "free"),
      pendingPlan:
        stored.pendingPlan === null || stored.pendingPlanEffectiveAt === null
          ? null
          : { effectiveAt: stored.pendingPlanEffectiveAt, plan: stored.pendingPlan },
      period: stored.currentPeriod,
    })),
});

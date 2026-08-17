import type { BillingSummary } from "@osfo/api";
import { Effect } from "effect";

import type { Plan, UserId } from "../domain";
import { effectivePlanAt } from "./billing-authorization";
import type { BillingPersistenceUnavailable } from "./stripe-billing";

/** Stored billing facts required for safe User presentation. */
export interface StoredBillingSummary {
  readonly checkoutPaymentState: "paymentNeeded" | null;
  readonly currentPeriod: { readonly endsAt: Date; readonly startsAt: Date } | null;
  readonly pendingPlan: Plan | null;
  readonly pendingPlanEffectiveAt: Date | null;
  readonly plan: Plan;
  readonly stripeCurrentPeriodEnd: Date | null;
}

/** Narrow persistence port for current billing presentation. */
export interface Persistence {
  readonly inspect: (
    userId: UserId,
    now: Date,
  ) => Effect.Effect<StoredBillingSummary, BillingPersistenceUnavailable>;
}

/** Safe current billing presentation. */
export interface Interface {
  readonly inspect: (
    userId: UserId,
  ) => Effect.Effect<BillingSummary, BillingPersistenceUnavailable>;
}

/** Construct the safe billing presentation from stored commercial facts. */
export const make = (
  persistence: Persistence,
  environment: { readonly now: Effect.Effect<Date> },
): Interface => ({
  inspect: (userId) =>
    environment.now.pipe(
      Effect.flatMap((now) =>
        persistence.inspect(userId, now).pipe(Effect.map((stored) => ({ now, stored }))),
      ),
      Effect.map(({ now, stored }) => {
        const currentPlan = effectivePlanAt(
          {
            currentPeriodEnd: stored.stripeCurrentPeriodEnd,
            pendingPlan: stored.pendingPlan,
            pendingPlanEffectiveAt: stored.pendingPlanEffectiveAt,
            plan: stored.plan,
          },
          now,
        );
        const pendingPlan =
          stored.pendingPlan === null ||
          stored.pendingPlanEffectiveAt === null ||
          stored.pendingPlanEffectiveAt <= now
            ? null
            : { effectiveAt: stored.pendingPlanEffectiveAt, plan: stored.pendingPlan };
        return {
          currentPlan,
          paymentState:
            pendingPlan !== null
              ? "changeScheduled"
              : currentPlan === "adventurer"
                ? "paid"
                : (stored.checkoutPaymentState ?? "free"),
          pendingPlan,
          period: stored.currentPeriod,
        };
      }),
    ),
});

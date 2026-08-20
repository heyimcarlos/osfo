import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../src/domain";
import { BillingPresentation } from "../src/services/billing-presentation";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/prefer-schema-over-json -- This presentation test uses fixed Date fixtures and inspects its safe JSON rendering. */

describe("Billing presentation", () => {
  it.effect("shows only safe Plan, period, payment, and pending-change language", () =>
    Effect.gen(function* () {
      const service = BillingPresentation.make(
        {
          inspect: () =>
            Effect.succeed({
              checkoutPaymentState: null,
              currentPeriod: {
                endsAt: new Date("2026-09-16T00:00:00.000Z"),
                startsAt: new Date("2026-08-16T00:00:00.000Z"),
              },
              pendingPlan: "free",
              pendingPlanEffectiveAt: new Date("2026-09-16T00:00:00.000Z"),
              plan: "adventurer",
              stripeCurrentPeriodEnd: new Date("2026-09-16T00:00:00.000Z"),
            }),
        },
        { now: Effect.succeed(new Date("2026-08-16T00:00:00.000Z")) },
      );

      const result = yield* service.inspect(UserId.make("user-presentation"));

      expect(result).toEqual({
        currentPlan: "adventurer",
        paymentState: "changeScheduled",
        pendingPlan: {
          effectiveAt: new Date("2026-09-16T00:00:00.000Z"),
          plan: "free",
        },
        period: {
          endsAt: new Date("2026-09-16T00:00:00.000Z"),
          startsAt: new Date("2026-08-16T00:00:00.000Z"),
        },
      });
      expect(JSON.stringify(result)).not.toContain("stripe");
    }),
  );

  it.effect("shows payment attention after a failed Checkout without granting paid access", () =>
    Effect.gen(function* () {
      const service = BillingPresentation.make(
        {
          inspect: () =>
            Effect.succeed({
              checkoutPaymentState: "paymentNeeded",
              currentPeriod: null,
              pendingPlan: null,
              pendingPlanEffectiveAt: null,
              plan: "free",
              stripeCurrentPeriodEnd: null,
            }),
        },
        { now: Effect.succeed(new Date("2026-08-16T00:00:00.000Z")) },
      );

      expect(yield* service.inspect(UserId.make("user-payment-needed"))).toMatchObject({
        currentPlan: "free",
        paymentState: "paymentNeeded",
      });
    }),
  );

  it.effect("shows Free at the exact confirmed paid-period end after a missed webhook", () =>
    Effect.gen(function* () {
      const periodEnd = new Date("2026-09-16T00:00:00.000Z");
      const inspect = () =>
        Effect.succeed({
          checkoutPaymentState: null,
          currentPeriod: null,
          pendingPlan: null,
          pendingPlanEffectiveAt: null,
          plan: "adventurer" as const,
          stripeCurrentPeriodEnd: periodEnd,
        });
      const beforeEnd = BillingPresentation.make(
        { inspect },
        { now: Effect.succeed(new Date("2026-09-15T23:59:59.999Z")) },
      );
      const atEnd = BillingPresentation.make({ inspect }, { now: Effect.succeed(periodEnd) });

      expect((yield* beforeEnd.inspect(UserId.make("user-before-end"))).currentPlan).toBe(
        "adventurer",
      );
      expect(yield* atEnd.inspect(UserId.make("user-at-end"))).toMatchObject({
        currentPlan: "free",
        paymentState: "free",
        pendingPlan: null,
      });
    }),
  );
});

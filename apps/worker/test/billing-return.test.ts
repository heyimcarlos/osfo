import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripeInvoiceId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../src/domain";
import { reconcileBillingReturn } from "../src/services/billing-return";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed provider facts keep this application-boundary test deterministic and Effect schemas use the standard _tag discriminator. */

describe("billing return reconciliation", () => {
  it.effect(
    "reconciles an authenticated and authorized Checkout return from current Stripe state",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
        const userId = UserId.make("user-checkout-return");
        const checkoutId = StripeCheckoutSessionId.make("cs_test_checkoutreturn");
        const subscriptionId = StripeSubscriptionId.make("sub_checkoutreturn");
        const snapshot = {
          cancelAtPeriodEnd: false,
          customerId: StripeCustomerId.make("cus_checkoutreturn"),
          currentPeriodRefunded: false,
          payment: { _tag: "Paid" as const, invoiceId: StripeInvoiceId.make("in_checkoutreturn") },
          period: {
            endsAt: new Date("2026-09-16T00:00:00.000Z"),
            startsAt: new Date("2026-08-16T00:00:00.000Z"),
          },
          priceId: StripePriceId.make("price_adventurer"),
          productId: StripeProductId.make("prod_adventurer"),
          status: "active" as const,
          subscriptionId,
          userId,
        };

        const result = yield* reconcileBillingReturn(
          { reason: "checkoutReturn", userId },
          {
            authorize: record("authorize"),
            fetchSubscription: (requestedId) =>
              record(`fetch-subscription:${requestedId}`).pipe(Effect.as(snapshot)),
            findCheckoutSession: () => record("find-checkout").pipe(Effect.as(checkoutId)),
            findStoredSubscription: () => record("find-subscription").pipe(Effect.as(null)),
            reconcile: (subject, reason, fetch) =>
              Effect.gen(function* () {
                const subjectIdentity =
                  subject._tag === "User" ? subject.userId : subject.subscriptionId;
                yield* record(`reconcile:${subject._tag}:${subjectIdentity}:${reason}`);
                yield* fetch(subject);
                return { _tag: "Activated" as const };
              }),
            retrieveCheckout: (requestedId) =>
              record(`retrieve-checkout:${requestedId}`).pipe(
                Effect.as({ stripeSubscriptionId: subscriptionId }),
              ),
          },
        );

        expect(result).toEqual({ result: "activated" });
        expect(yield* Ref.get(calls)).toEqual([
          "authorize",
          "find-subscription",
          "find-checkout",
          "retrieve-checkout:cs_test_checkoutreturn",
          "reconcile:User:user-checkout-return:checkoutReturn",
          "fetch-subscription:sub_checkoutreturn",
        ]);
      }),
  );
});

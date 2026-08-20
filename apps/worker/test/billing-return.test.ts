import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  BillingCheckoutSessionId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripeInvoiceId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../src/domain";
import { BillingReturnConflict, reconcileBillingReturn } from "../src/services/billing-return";

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
        const billingCheckoutSessionId = BillingCheckoutSessionId.make("checkout-local-return");
        const customerId = StripeCustomerId.make("cus_checkoutreturn");
        const priceId = StripePriceId.make("price_adventurer");
        const productId = StripeProductId.make("prod_adventurer");
        const subscriptionId = StripeSubscriptionId.make("sub_checkoutreturn");
        const snapshot = {
          cancelAtPeriodEnd: false,
          customerId,
          currentPeriodRefunded: false,
          payment: { _tag: "Paid" as const, invoiceId: StripeInvoiceId.make("in_checkoutreturn") },
          period: {
            endsAt: new Date("2026-09-16T00:00:00.000Z"),
            startsAt: new Date("2026-08-16T00:00:00.000Z"),
          },
          priceId,
          productId,
          status: "active" as const,
          subscriptionId,
          userId,
        };

        const result = yield* reconcileBillingReturn(
          { reason: "checkoutReturn", stripeCheckoutSessionId: checkoutId, userId },
          {
            authorize: record("authorize"),
            fetchSubscription: (requestedId) =>
              record(`fetch-subscription:${requestedId}`).pipe(Effect.as(snapshot)),
            findCheckoutSession: (requestedUserId, requestedCheckoutId) =>
              record(`find-checkout:${requestedUserId}:${requestedCheckoutId}`).pipe(
                Effect.as({
                  billingCheckoutSessionId,
                  customerId,
                  priceId,
                  productId,
                  stripeCheckoutSessionId: checkoutId,
                  userId,
                }),
              ),
            findStoredSubscription: () =>
              record("find-subscription").pipe(
                Effect.as(StripeSubscriptionId.make("sub_oldcanceled")),
              ),
            reconcile: (subject, reason, fetch, checkoutEvidence) =>
              Effect.gen(function* () {
                const subjectIdentity =
                  subject._tag === "User" ? subject.userId : subject.subscriptionId;
                yield* record(`reconcile:${subject._tag}:${subjectIdentity}:${reason}`);
                expect(checkoutEvidence).toEqual({
                  _tag: "Completed",
                  locator: {
                    _tag: "LocalAttempt",
                    billingCheckoutSessionId,
                    stripeCheckoutSessionId: checkoutId,
                  },
                  paymentStatus: "unknown",
                });
                yield* fetch(subject);
                return { _tag: "Activated" as const };
              }),
            retrieveCheckout: (requestedId) =>
              record(`retrieve-checkout:${requestedId}`).pipe(
                Effect.as({
                  billingCheckoutSessionId,
                  customerId,
                  priceId,
                  productId,
                  state: "complete" as const,
                  stripeSubscriptionId: subscriptionId,
                  userId,
                }),
              ),
          },
        );

        expect(result).toEqual({ result: "activated" });
        expect(yield* Ref.get(calls)).toEqual([
          "authorize",
          "find-checkout:user-checkout-return:cs_test_checkoutreturn",
          "retrieve-checkout:cs_test_checkoutreturn",
          "reconcile:User:user-checkout-return:checkoutReturn",
          "fetch-subscription:sub_checkoutreturn",
        ]);
      }),
  );

  it.effect("rejects a returned Checkout Session with conflicting ownership", () =>
    Effect.gen(function* () {
      const userId = UserId.make("user-checkout-owner");
      const checkoutId = StripeCheckoutSessionId.make("cs_test_checkoutowner");
      const billingCheckoutSessionId = BillingCheckoutSessionId.make("checkout-local-owner");
      const failure = yield* Effect.flip(
        reconcileBillingReturn(
          { reason: "checkoutReturn", stripeCheckoutSessionId: checkoutId, userId },
          {
            authorize: Effect.void,
            fetchSubscription: () => Effect.die(new Error("must not fetch")),
            findCheckoutSession: () =>
              Effect.succeed({
                billingCheckoutSessionId,
                customerId: StripeCustomerId.make("cus_checkoutowner"),
                priceId: StripePriceId.make("price_adventurer"),
                productId: StripeProductId.make("prod_adventurer"),
                stripeCheckoutSessionId: checkoutId,
                userId,
              }),
            findStoredSubscription: () =>
              Effect.die(new Error("must not prefer stored Subscription")),
            reconcile: () => Effect.die(new Error("must not reconcile a conflict")),
            retrieveCheckout: () =>
              Effect.succeed({
                billingCheckoutSessionId,
                customerId: StripeCustomerId.make("cus_checkoutowner"),
                priceId: StripePriceId.make("price_adventurer"),
                productId: StripeProductId.make("prod_adventurer"),
                state: "complete" as const,
                stripeSubscriptionId: StripeSubscriptionId.make("sub_checkoutowner"),
                userId: UserId.make("user-other"),
              }),
          },
        ),
      );

      expect(failure).toBeInstanceOf(BillingReturnConflict);
    }),
  );

  it.effect("rejects every Checkout attempt, Customer, offer, and terminal-state conflict", () =>
    Effect.gen(function* () {
      const userId = UserId.make("user-checkout-conflicts");
      const checkoutId = StripeCheckoutSessionId.make("cs_test_checkoutconflicts");
      const billingCheckoutSessionId = BillingCheckoutSessionId.make("checkout-local-conflicts");
      const stored = {
        billingCheckoutSessionId,
        customerId: StripeCustomerId.make("cus_checkoutconflicts"),
        priceId: StripePriceId.make("price_adventurer"),
        productId: StripeProductId.make("prod_adventurer"),
        stripeCheckoutSessionId: checkoutId,
        userId,
      };
      const retrieved = {
        billingCheckoutSessionId,
        customerId: stored.customerId,
        priceId: stored.priceId,
        productId: stored.productId,
        state: "complete" as const,
        stripeSubscriptionId: StripeSubscriptionId.make("sub_checkoutconflicts"),
        userId,
      };
      const conflicts = [
        {
          ...retrieved,
          billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-other-attempt"),
        },
        { ...retrieved, customerId: StripeCustomerId.make("cus_other") },
        { ...retrieved, productId: StripeProductId.make("prod_other") },
        { ...retrieved, priceId: StripePriceId.make("price_other") },
        { ...retrieved, state: "open" as const },
        { ...retrieved, stripeSubscriptionId: null },
      ];

      for (const conflict of conflicts) {
        const failure = yield* Effect.flip(
          reconcileBillingReturn(
            { reason: "checkoutReturn", stripeCheckoutSessionId: checkoutId, userId },
            {
              authorize: Effect.void,
              fetchSubscription: () => Effect.die(new Error("must not fetch a conflict")),
              findCheckoutSession: () => Effect.succeed(stored),
              findStoredSubscription: () => Effect.die(new Error("must not use stored fallback")),
              reconcile: () => Effect.die(new Error("must not reconcile a conflict")),
              retrieveCheckout: () => Effect.succeed(conflict),
            },
          ),
        );
        expect(failure).toBeInstanceOf(BillingReturnConflict);
      }
    }),
  );

  it.effect("rejects an absent exact Checkout attempt without stored Subscription fallback", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
      const failure = yield* Effect.flip(
        reconcileBillingReturn(
          {
            reason: "checkoutReturn",
            stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_absentreturn"),
            userId: UserId.make("user-absent-return"),
          },
          {
            authorize: record("authorize"),
            fetchSubscription: () =>
              record("fetch").pipe(Effect.andThen(Effect.die(new Error("unexpected")))),
            findCheckoutSession: () => record("find-exact").pipe(Effect.as(null)),
            findStoredSubscription: () =>
              record("stored-fallback").pipe(Effect.andThen(Effect.die(new Error("unexpected")))),
            reconcile: () =>
              record("reconcile").pipe(Effect.andThen(Effect.die(new Error("unexpected")))),
            retrieveCheckout: () =>
              record("retrieve").pipe(Effect.andThen(Effect.die(new Error("unexpected")))),
          },
        ),
      );

      expect(failure).toBeInstanceOf(BillingReturnConflict);
      expect(yield* Ref.get(calls)).toEqual(["authorize", "find-exact"]);
    }),
  );
});

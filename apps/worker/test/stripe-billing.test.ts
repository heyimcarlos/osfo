import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  BillingCheckoutSessionId,
  BillingCustomerId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripePortalConfigurationId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../src/domain";
import { StripeBilling } from "../src/services/stripe-billing";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date -- These deterministic provider tests assert Effect tags and fixed Date values. */

const userId = UserId.make("user-checkout");
const customerId = BillingCustomerId.make("billing-customer-local");
const checkoutId = BillingCheckoutSessionId.make("billing-checkout-local");
const expiredCheckoutAt = new Date("2026-08-17T12:00:00.000Z");
const portal = {
  configurationId: StripePortalConfigurationId.make("bpc_approved"),
  returnUrl: new URL("https://osfo.test/billing/return?source=portal"),
};
const makeStripeBilling = (
  options: Omit<StripeBilling.MakeOptions, "now" | "waitForCheckoutClaim">,
) =>
  StripeBilling.make({
    ...options,
    now: Effect.succeed(new Date("2026-08-16T12:00:00.000Z")),
    waitForCheckoutClaim: Effect.yieldNow,
  });

describe("StripeBilling", () => {
  it.effect("opens Customer Portal with the approved configuration and return URL", () =>
    Effect.gen(function* () {
      const portalInputs: Array<{
        readonly configurationId: string;
        readonly customerId: StripeCustomerId;
        readonly returnUrl: URL;
      }> = [];
      const service = makeStripeBilling({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          releaseCheckoutClaim: () => Effect.void,
          inspectCheckoutEligibility: () => Effect.die(new Error("unused")),
          prepareCheckout: () => Effect.die(new Error("unused")),
          prepareCustomer: () =>
            Effect.succeed({
              billingCustomerId: customerId,
              stripeCustomerId: StripeCustomerId.make("cus_portal"),
            }),
          storeCheckout: () => Effect.void,
          storeCustomer: () => Effect.void,
          storeRetrievedCheckout: () => Effect.void,
        },
        portal,
        stripe: {
          createCheckout: () => Effect.die(new Error("unused")),
          createCustomer: () => Effect.die(new Error("unused")),
          createPortal: (input) => {
            portalInputs.push(input);
            return Effect.succeed(new URL("https://billing.stripe.test/session"));
          },
          retrieveCheckout: () => Effect.die(new Error("unused")),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const result = yield* service.openPortal(userId);

      expect(result.href).toBe("https://billing.stripe.test/session");
      expect(portalInputs).toEqual([
        {
          configurationId: "bpc_approved",
          customerId: "cus_portal",
          returnUrl: new URL("https://osfo.test/billing/return?source=portal"),
        },
      ]);
    }),
  );

  it.effect("retries Customer and Checkout creation with stable local idempotency keys", () =>
    Effect.gen(function* () {
      const customerKeys: Array<string> = [];
      const checkoutKeys: Array<string> = [];
      let customerStripeId: StripeCustomerId | null = null;
      let checkoutStripeId: StripeCheckoutSessionId | null = null;
      let checkoutState: StripeBilling.CheckoutState = "creating";
      let checkoutCalls = 0;
      const service = makeStripeBilling({
        ids: {
          checkout: Effect.succeed(checkoutId),
          customer: Effect.succeed(customerId),
        },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          releaseCheckoutClaim: () => Effect.void,
          inspectCheckoutEligibility: () => Effect.succeed({ _tag: "Eligible" }),
          prepareCheckout: () =>
            Effect.succeed({
              billingCheckoutSessionId: checkoutId,
              claim: "Acquired",
              state: checkoutState,
              stripeCheckoutSessionId: checkoutStripeId,
            }),
          prepareCustomer: () =>
            Effect.succeed({ billingCustomerId: customerId, stripeCustomerId: customerStripeId }),
          storeCheckout: (_localId, session) => {
            checkoutStripeId = session.stripeCheckoutSessionId;
            checkoutState = "open";
            return Effect.void;
          },
          storeRetrievedCheckout: () => Effect.void,
          storeCustomer: (_localId, stripeId) => {
            customerStripeId = stripeId;
            return Effect.void;
          },
        },
        portal,
        stripe: {
          createCheckout: (input) => {
            checkoutKeys.push(input.idempotencyKey);
            checkoutCalls += 1;
            return checkoutCalls === 1
              ? Effect.fail(
                  new StripeBilling.StripeRequestFailed({
                    kind: "transient",
                    message: "Stripe Checkout response was unavailable",
                    operation: "createCheckout",
                  }),
                )
              : Effect.succeed({
                  expiresAt: new Date("2026-08-17T12:00:00.000Z"),
                  stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_checkout"),
                  url: new URL("https://checkout.stripe.test/session"),
                });
          },
          createCustomer: (input) => {
            customerKeys.push(input.idempotencyKey);
            return Effect.succeed(StripeCustomerId.make("cus_checkout"));
          },
          createPortal: () => Effect.die(new Error("unused")),
          retrieveCheckout: () => Effect.die(new Error("unused")),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const first = yield* service.startCheckout(userId).pipe(Effect.exit);
      const second = yield* service.startCheckout(userId);

      expect(first._tag).toBe("Failure");
      expect(second.url.href).toBe("https://checkout.stripe.test/session");
      expect(customerKeys).toEqual([customerId]);
      expect(checkoutKeys).toEqual([checkoutId, checkoutId]);
    }),
  );

  it.effect("reuses a valid open Stripe Checkout Session for the same attempt", () =>
    Effect.gen(function* () {
      let creates = 0;
      const service = makeStripeBilling({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          releaseCheckoutClaim: () => Effect.void,
          inspectCheckoutEligibility: () => Effect.succeed({ _tag: "Eligible" }),
          prepareCheckout: () =>
            Effect.succeed({
              billingCheckoutSessionId: checkoutId,
              claim: "Acquired",
              state: "open",
              stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_open"),
            }),
          prepareCustomer: () =>
            Effect.succeed({
              billingCustomerId: customerId,
              stripeCustomerId: StripeCustomerId.make("cus_checkout"),
            }),
          storeCheckout: () => Effect.void,
          storeRetrievedCheckout: () => Effect.void,
          storeCustomer: () => Effect.void,
        },
        portal,
        stripe: {
          createCheckout: () => {
            creates += 1;
            return Effect.die(new Error("must not create"));
          },
          createCustomer: () => Effect.die(new Error("must not create")),
          createPortal: () => Effect.die(new Error("unused")),
          retrieveCheckout: () =>
            Effect.succeed({
              expiresAt: new Date("2026-08-17T12:00:00.000Z"),
              state: "open",
              stripeSubscriptionId: null,
              url: new URL("https://checkout.stripe.test/existing"),
            }),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const result = yield* service.startCheckout(userId);

      expect(result.url.href).toBe("https://checkout.stripe.test/existing");
      expect(creates).toBe(0);
    }),
  );

  it.effect("expires a stale Checkout attempt before it creates a distinct attempt", () =>
    Effect.gen(function* () {
      const oldCheckoutId = BillingCheckoutSessionId.make("billing-checkout-old");
      const newCheckoutId = BillingCheckoutSessionId.make("billing-checkout-new");
      const generatedIds = [
        BillingCheckoutSessionId.make("billing-checkout-unused"),
        newCheckoutId,
      ];
      let state: StripeBilling.CheckoutState = "open";
      let prepared = 0;
      const storedTerminalStates: Array<{
        readonly expiresAt: Date;
        readonly state: "complete" | "expired";
        readonly stripeSubscriptionId: StripeSubscriptionId | null;
      }> = [];
      const createdKeys: Array<BillingCheckoutSessionId> = [];
      const service = makeStripeBilling({
        ids: {
          checkout: Effect.sync(() => generatedIds[prepared] ?? newCheckoutId),
          customer: Effect.succeed(customerId),
        },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          releaseCheckoutClaim: () => Effect.void,
          inspectCheckoutEligibility: () => Effect.succeed({ _tag: "Eligible" }),
          prepareCheckout: (input) => {
            prepared += 1;
            return Effect.succeed(
              state === "open"
                ? {
                    billingCheckoutSessionId: oldCheckoutId,
                    claim: "Acquired" as const,
                    state,
                    stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_expired"),
                  }
                : {
                    billingCheckoutSessionId: input.billingCheckoutSessionId,
                    claim: "Acquired" as const,
                    state: "creating" as const,
                    stripeCheckoutSessionId: null,
                  },
            );
          },
          prepareCustomer: () =>
            Effect.succeed({
              billingCustomerId: customerId,
              stripeCustomerId: StripeCustomerId.make("cus_checkout"),
            }),
          storeCheckout: () => Effect.void,
          storeCustomer: () => Effect.void,
          storeRetrievedCheckout: (_id, session) => {
            storedTerminalStates.push(session);
            state = session.state;
            return Effect.void;
          },
        },
        portal,
        stripe: {
          createCheckout: (input) => {
            createdKeys.push(input.idempotencyKey);
            return Effect.succeed({
              expiresAt: new Date("2026-08-18T12:00:00.000Z"),
              stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_new"),
              url: new URL("https://checkout.stripe.test/new"),
            });
          },
          createCustomer: () => Effect.die(new Error("must not create")),
          createPortal: () => Effect.die(new Error("unused")),
          retrieveCheckout: () =>
            Effect.succeed({
              expiresAt: new Date("2026-08-17T12:00:00.000Z"),
              state: "expired",
              stripeSubscriptionId: null,
              url: null,
            }),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const result = yield* service.startCheckout(userId);

      expect(result.billingCheckoutSessionId).toBe(newCheckoutId);
      expect(createdKeys).toEqual([newCheckoutId]);
      expect(storedTerminalStates).toEqual([
        {
          expiresAt: expiredCheckoutAt,
          state: "expired",
          stripeSubscriptionId: null,
        },
      ]);
    }),
  );

  it.effect("records a complete Checkout attempt and does not recreate it", () =>
    Effect.gen(function* () {
      let creates = 0;
      const subscriptionId = StripeSubscriptionId.make("sub_checkout");
      const storedTerminalStates: Array<{
        readonly expiresAt: Date;
        readonly state: "complete" | "expired";
        readonly stripeSubscriptionId: StripeSubscriptionId | null;
      }> = [];
      const service = makeStripeBilling({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          releaseCheckoutClaim: () => Effect.void,
          inspectCheckoutEligibility: () => Effect.succeed({ _tag: "Eligible" }),
          prepareCheckout: () =>
            Effect.succeed({
              billingCheckoutSessionId: checkoutId,
              claim: "Acquired",
              state: "open",
              stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_complete"),
            }),
          prepareCustomer: () =>
            Effect.succeed({
              billingCustomerId: customerId,
              stripeCustomerId: StripeCustomerId.make("cus_checkout"),
            }),
          storeCheckout: () => Effect.void,
          storeCustomer: () => Effect.void,
          storeRetrievedCheckout: (_id, session) => {
            storedTerminalStates.push(session);
            return Effect.void;
          },
        },
        portal,
        stripe: {
          createCheckout: () => {
            creates += 1;
            return Effect.die(new Error("must not create"));
          },
          createCustomer: () => Effect.die(new Error("must not create")),
          createPortal: () => Effect.die(new Error("unused")),
          retrieveCheckout: () =>
            Effect.succeed({
              expiresAt: new Date("2026-08-17T12:00:00.000Z"),
              state: "complete",
              stripeSubscriptionId: subscriptionId,
              url: null,
            }),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const failure = yield* service.startCheckout(userId).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "StripeRequestFailed", kind: "permanent" });
      expect(creates).toBe(0);
      expect(storedTerminalStates).toEqual([
        {
          expiresAt: expiredCheckoutAt,
          state: "complete",
          stripeSubscriptionId: subscriptionId,
        },
      ]);
    }),
  );
});

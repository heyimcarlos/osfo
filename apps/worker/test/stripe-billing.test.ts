import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { billingCustomers, billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
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
import { makeStripePersistence } from "../src/db/billing/stripe-persistence";
import * as StripeBilling from "../src/services/stripe-billing";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date -- These deterministic provider tests assert Effect tags and fixed Date values. */

const userId = UserId.make("user-checkout");
const customerId = BillingCustomerId.make("billing-customer-local");
const checkoutId = BillingCheckoutSessionId.make("billing-checkout-local");
const expiredCheckoutAt = new Date("2026-08-17T12:00:00.000Z");
const portal = {
  configurationId: StripePortalConfigurationId.make("bpc_approved"),
  returnUrl: new URL("https://osfo.test/billing/return?source=portal"),
};

describe("StripeBilling", () => {
  it.effect("opens Customer Portal with the approved configuration and return URL", () =>
    Effect.gen(function* () {
      const portalInputs: Array<{
        readonly configurationId: string;
        readonly customerId: StripeCustomerId;
        readonly returnUrl: URL;
      }> = [];
      const service = StripeBilling.make({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          inspectCheckoutEligibility: () => Effect.die("unused"),
          prepareCheckout: () => Effect.die("unused"),
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
          createCheckout: () => Effect.die("unused"),
          createCustomer: () => Effect.die("unused"),
          createPortal: (input) => {
            portalInputs.push(input);
            return Effect.succeed(new URL("https://billing.stripe.test/session"));
          },
          retrieveCheckout: () => Effect.die("unused"),
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
      const service = StripeBilling.make({
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
          inspectCheckoutEligibility: () =>
            Effect.succeed({ hasRecoverableStripeSubscription: false, plan: "free" }),
          prepareCheckout: () =>
            Effect.succeed({
              billingCheckoutSessionId: checkoutId,
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
          createPortal: () => Effect.die("unused"),
          retrieveCheckout: () => Effect.die("unused"),
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
      const service = StripeBilling.make({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          inspectCheckoutEligibility: () =>
            Effect.succeed({ hasRecoverableStripeSubscription: false, plan: "free" }),
          prepareCheckout: () =>
            Effect.succeed({
              billingCheckoutSessionId: checkoutId,
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
            return Effect.die("must not create");
          },
          createCustomer: () => Effect.die("must not create"),
          createPortal: () => Effect.die("unused"),
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
      const service = StripeBilling.make({
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
          inspectCheckoutEligibility: () =>
            Effect.succeed({ hasRecoverableStripeSubscription: false, plan: "free" }),
          prepareCheckout: (input) => {
            prepared += 1;
            return Effect.succeed(
              state === "open"
                ? {
                    billingCheckoutSessionId: oldCheckoutId,
                    state,
                    stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_expired"),
                  }
                : {
                    billingCheckoutSessionId: input.billingCheckoutSessionId,
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
          createCustomer: () => Effect.die("must not create"),
          createPortal: () => Effect.die("unused"),
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
      const service = StripeBilling.make({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.void,
          inspectCheckoutEligibility: () =>
            Effect.succeed({ hasRecoverableStripeSubscription: false, plan: "free" }),
          prepareCheckout: () =>
            Effect.succeed({
              billingCheckoutSessionId: checkoutId,
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
            return Effect.die("must not create");
          },
          createCustomer: () => Effect.die("must not create"),
          createPortal: () => Effect.die("unused"),
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

  it.effect("rejects paid and Stripe-linked Users before it requests Stripe", () =>
    Effect.gen(function* () {
      const facts = [
        { hasRecoverableStripeSubscription: false, plan: "adventurer" as const },
        { hasRecoverableStripeSubscription: true, plan: "free" as const },
      ];
      let customerRequests = 0;
      let checkoutRequests = 0;

      for (const eligibility of facts) {
        const service = StripeBilling.make({
          ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
          offers: {
            adventurer: {
              priceId: StripePriceId.make("price_adventurer"),
              productId: StripeProductId.make("prod_adventurer"),
            },
          },
          persistence: {
            failCheckout: () => Effect.die("must not prepare Checkout"),
            inspectCheckoutEligibility: () => Effect.succeed(eligibility),
            prepareCheckout: () => Effect.die("must not prepare Checkout"),
            prepareCustomer: () => Effect.die("must not prepare Customer"),
            storeCheckout: () => Effect.die("must not store Checkout"),
            storeCustomer: () => Effect.die("must not store Customer"),
            storeRetrievedCheckout: () => Effect.die("must not store Checkout"),
          },
          portal,
          stripe: {
            createCheckout: () => {
              checkoutRequests += 1;
              return Effect.die("must not create Checkout");
            },
            createCustomer: () => {
              customerRequests += 1;
              return Effect.die("must not create Customer");
            },
            createPortal: () => Effect.die("unused"),
            retrieveCheckout: () => Effect.die("unused"),
          },
          urls: {
            cancel: new URL("https://osfo.test/billing"),
            success: new URL("https://osfo.test/billing/return?source=checkout"),
          },
        });

        const failure = yield* service.startCheckout(userId).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "CheckoutIneligible" });
      }

      expect(customerRequests).toBe(0);
      expect(checkoutRequests).toBe(0);
    }),
  );

  it.effect("does not request Checkout when locked billing facts become ineligible", () =>
    Effect.gen(function* () {
      let checkoutRequests = 0;
      const service = StripeBilling.make({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.die("unused"),
          inspectCheckoutEligibility: () =>
            Effect.succeed({ hasRecoverableStripeSubscription: false, plan: "free" }),
          prepareCheckout: () =>
            Effect.fail(new StripeBilling.CheckoutIneligible({ reason: "activePlan" })),
          prepareCustomer: () =>
            Effect.succeed({
              billingCustomerId: customerId,
              stripeCustomerId: StripeCustomerId.make("cus_race"),
            }),
          storeCheckout: () => Effect.die("unused"),
          storeCustomer: () => Effect.die("unused"),
          storeRetrievedCheckout: () => Effect.die("unused"),
        },
        portal,
        stripe: {
          createCheckout: () => {
            checkoutRequests += 1;
            return Effect.die("must not create Checkout");
          },
          createCustomer: () => Effect.die("must reuse Customer"),
          createPortal: () => Effect.die("unused"),
          retrieveCheckout: () => Effect.die("unused"),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const failure = yield* service.startCheckout(userId).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CheckoutIneligible", reason: "activePlan" });
      expect(checkoutRequests).toBe(0);
    }),
  );

  it.effect("allows canceled Users and reuses one attempt for sequential same-offer starts", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "checkout-concurrency@example.test",
              id: userId,
              name: "Checkout Concurrency",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCustomers).values({
              billingCustomerId: customerId,
              stripeCustomerId: "cus_concurrent",
              userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billingSubscriptionId: "billing-subscription-concurrent",
              billingCustomerId: customerId,
              plan: "free",
              planPolicyVersion: "launch-v1",
              stripePriceId: "price_previous",
              stripeProductId: "prod_previous",
              stripeStatus: "canceled",
              stripeSubscriptionId: "sub_previous",
              userId,
            }),
          );

          const candidateIds = [
            BillingCheckoutSessionId.make("billing-checkout-concurrent-a"),
            BillingCheckoutSessionId.make("billing-checkout-concurrent-b"),
          ] as const;
          let generated = 0;
          const providerKeys: Array<BillingCheckoutSessionId> = [];
          const service = StripeBilling.make({
            ids: {
              checkout: Effect.sync(() => candidateIds[generated++] ?? candidateIds[0]),
              customer: Effect.succeed(customerId),
            },
            offers: {
              adventurer: {
                priceId: StripePriceId.make("price_adventurer"),
                productId: StripeProductId.make("prod_adventurer"),
              },
            },
            persistence: makeStripePersistence(fixture.database),
            portal,
            stripe: {
              createCheckout: (input) => {
                providerKeys.push(input.idempotencyKey);
                return Effect.succeed({
                  expiresAt: expiredCheckoutAt,
                  stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_concurrent"),
                  url: new URL(`https://checkout.stripe.test/${input.idempotencyKey}`),
                });
              },
              createCustomer: () => Effect.die("must reuse Customer"),
              createPortal: () => Effect.die("unused"),
              retrieveCheckout: (stripeCheckoutSessionId) =>
                Effect.succeed({
                  expiresAt: expiredCheckoutAt,
                  state: "open",
                  stripeSubscriptionId: null,
                  url: new URL(`https://checkout.stripe.test/${stripeCheckoutSessionId}`),
                }),
            },
            urls: {
              cancel: new URL("https://osfo.test/billing"),
              success: new URL("https://osfo.test/billing/return?source=checkout"),
            },
          });

          const starts = [
            yield* service.startCheckout(userId),
            yield* service.startCheckout(userId),
          ];

          expect(new Set(starts.map((start) => start.billingCheckoutSessionId)).size).toBe(1);
          expect(providerKeys).toHaveLength(1);
        }),
      closeTestDatabase,
    ),
  );
});

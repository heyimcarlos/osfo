import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { billingCustomers, billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Deferred, Effect } from "effect";

import {
  BillingCheckoutSessionId,
  BillingCustomerId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripePortalConfigurationId,
  StripeProductId,
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
const makeStripeBilling = (
  options: Omit<StripeBilling.MakeOptions, "now" | "waitForCheckoutClaim">,
) =>
  StripeBilling.make({
    ...options,
    now: Effect.succeed(new Date("2026-08-16T12:00:00.000Z")),
    waitForCheckoutClaim: Effect.yieldNow,
  });

describe("StripeBilling eligibility and claims", () => {
  it("allows terminal Stripe subscriptions to start a replacement Checkout", () => {
    for (const stripeStatus of ["canceled", "incomplete_expired"] as const) {
      expect(
        StripeBilling.checkoutEligibility({
          plan: "free",
          stripeStatus,
          stripeSubscriptionId: "sub_terminal",
        }),
      ).toEqual({ _tag: "Eligible" });
    }
  });

  it.effect("rejects paid and nonterminal Stripe-linked Users before it requests Stripe", () =>
    Effect.gen(function* () {
      expect(
        StripeBilling.checkoutEligibility({
          plan: "free",
          stripeStatus: "past_due",
          stripeSubscriptionId: "sub_recoverable",
        }),
      ).toEqual({ _tag: "Ineligible", reason: "existingStripeSubscription" });
      const facts = [
        { _tag: "Ineligible" as const, reason: "activePlan" as const },
        { _tag: "Ineligible" as const, reason: "existingStripeSubscription" as const },
      ];
      let customerRequests = 0;
      let checkoutRequests = 0;

      for (const eligibility of facts) {
        const service = makeStripeBilling({
          ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
          offers: {
            adventurer: {
              priceId: StripePriceId.make("price_adventurer"),
              productId: StripeProductId.make("prod_adventurer"),
            },
          },
          persistence: {
            failCheckout: () => Effect.die("must not prepare Checkout"),
            releaseCheckoutClaim: () => Effect.die("must not release Checkout"),
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
      const service = makeStripeBilling({
        ids: { checkout: Effect.succeed(checkoutId), customer: Effect.succeed(customerId) },
        offers: {
          adventurer: {
            priceId: StripePriceId.make("price_adventurer"),
            productId: StripeProductId.make("prod_adventurer"),
          },
        },
        persistence: {
          failCheckout: () => Effect.die("unused"),
          releaseCheckoutClaim: () => Effect.die("unused"),
          inspectCheckoutEligibility: () => Effect.succeed({ _tag: "Eligible" }),
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

  it.effect("reuses one attempt for sequential eligible same-offer starts", () =>
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
              userId,
            }),
          );

          const candidateIds = [
            BillingCheckoutSessionId.make("billing-checkout-concurrent-a"),
            BillingCheckoutSessionId.make("billing-checkout-concurrent-b"),
          ] as const;
          let generated = 0;
          const providerKeys: Array<BillingCheckoutSessionId> = [];
          const service = makeStripeBilling({
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

  it.effect("allows one provider Checkout call for concurrent starts", () =>
    Effect.gen(function* () {
      let providerCalls = 0;
      let prepares = 0;
      let storedStripeCheckoutSessionId: StripeCheckoutSessionId | null = null;
      const releaseProvider = yield* Deferred.make<void>();
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
            Effect.gen(function* () {
              prepares += 1;
              if (storedStripeCheckoutSessionId !== null) {
                return {
                  billingCheckoutSessionId: checkoutId,
                  claim: "Acquired" as const,
                  state: "open" as const,
                  stripeCheckoutSessionId: storedStripeCheckoutSessionId,
                };
              }
              if (prepares === 2) {
                yield* Deferred.succeed(releaseProvider, undefined);
                return {
                  billingCheckoutSessionId: checkoutId,
                  claim: "Pending" as const,
                  state: "creating" as const,
                  stripeCheckoutSessionId: null,
                };
              }
              return {
                billingCheckoutSessionId: checkoutId,
                claim: "Acquired" as const,
                state: "creating" as const,
                stripeCheckoutSessionId: null,
              };
            }),
          prepareCustomer: () =>
            Effect.succeed({
              billingCustomerId: customerId,
              stripeCustomerId: StripeCustomerId.make("cus_concurrent"),
            }),
          storeCheckout: (_id, session) => {
            storedStripeCheckoutSessionId = session.stripeCheckoutSessionId;
            return Effect.void;
          },
          storeCustomer: () => Effect.void,
          storeRetrievedCheckout: () => Effect.void,
        },
        portal,
        stripe: {
          createCheckout: () => {
            providerCalls += 1;
            return Deferred.await(releaseProvider).pipe(
              Effect.as({
                expiresAt: expiredCheckoutAt,
                stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_onecall"),
                url: new URL("https://checkout.stripe.test/one-call"),
              }),
            );
          },
          createCustomer: () => Effect.die("must reuse Customer"),
          createPortal: () => Effect.die("unused"),
          retrieveCheckout: () =>
            Effect.succeed({
              expiresAt: expiredCheckoutAt,
              state: "open",
              stripeSubscriptionId: null,
              url: new URL("https://checkout.stripe.test/one-call"),
            }),
        },
        urls: {
          cancel: new URL("https://osfo.test/billing"),
          success: new URL("https://osfo.test/billing/return?source=checkout"),
        },
      });

      const starts = yield* Effect.all(
        [service.startCheckout(userId), service.startCheckout(userId)],
        { concurrency: "unbounded" },
      );

      expect(providerCalls).toBe(1);
      expect(new Set(starts.map((start) => start.billingCheckoutSessionId)).size).toBe(1);
    }),
  );
});

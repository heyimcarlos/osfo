import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
} from "@osfo/db/schema/billing";
import { Deferred, Effect, Fiber } from "effect";

import { makeStripePersistence } from "../src/db/billing/stripe-persistence";
import {
  BillingCheckoutSessionId,
  BillingCustomerId,
  StripeCheckoutSessionId,
  StripePriceId,
  StripePortalConfigurationId,
  StripeProductId,
  UserId,
} from "../src/domain";
import { StripeBilling } from "../src/services/stripe-billing";
import { RealPostgresTestUnavailable, withRealPostgresFixture } from "./real-postgres-fixture";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Native PostgreSQL lease fixtures use fixed database timestamps. */

describe("StripeBilling with real PostgreSQL", () => {
  it.effect(
    "claims one concurrent provider call, releases the transaction, and recovers a stale lease",
    () =>
      withRealPostgresFixture(({ client, database }) =>
        Effect.gen(function* () {
          const concurrentUserId = UserId.make("user-checkout-native-concurrent");
          const staleUserId = UserId.make("user-checkout-native-stale");
          yield* Effect.tryPromise({
            // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this native PostgreSQL seed boundary.
            try: async () => {
              await database.insert(users).values([
                {
                  email: "checkout-native-concurrent@example.test",
                  id: concurrentUserId,
                  name: "Native Concurrent Checkout",
                },
                {
                  email: "checkout-native-stale@example.test",
                  id: staleUserId,
                  name: "Native Stale Checkout",
                },
              ]);
              await database.insert(billingCustomers).values([
                {
                  billing_customer_id: "customer-native-concurrent",
                  stripe_customer_id: "cus_nativeconcurrent",
                  user_id: concurrentUserId,
                },
                {
                  billing_customer_id: "customer-native-stale",
                  stripe_customer_id: "cus_nativestale",
                  user_id: staleUserId,
                },
              ]);
              await database.insert(billingSubscriptions).values([
                {
                  billing_customer_id: "customer-native-concurrent",
                  billing_subscription_id: "subscription-native-concurrent",
                  plan: "free",
                  plan_policy_version: "launch-v1",
                  user_id: concurrentUserId,
                },
                {
                  billing_customer_id: "customer-native-stale",
                  billing_subscription_id: "subscription-native-stale",
                  plan: "free",
                  plan_policy_version: "launch-v1",
                  user_id: staleUserId,
                },
              ]);
              await database.insert(billingCheckoutSessions).values({
                billing_checkout_session_id: "checkout-native-stale",
                billing_customer_id: "customer-native-stale",
                state: "creating",
                stripe_price_id: "price_adventurer",
                stripe_product_id: "prod_adventurer",
                target_plan: "adventurer",
                updated_at: new Date("2026-08-16T00:00:00.000Z"),
                user_id: staleUserId,
              });
            },
            catch: () =>
              new RealPostgresTestUnavailable({
                message: "Could not seed native Checkout concurrency facts",
              }),
          });

          const providerEntered = yield* Deferred.make<void>();
          const releaseProvider = yield* Deferred.make<void>();
          let providerCalls = 0;
          let providerObservedReleasedTransaction = false;
          let generated = 0;
          const candidateIds = [
            BillingCheckoutSessionId.make("checkout-native-concurrent-a"),
            BillingCheckoutSessionId.make("checkout-native-concurrent-b"),
            BillingCheckoutSessionId.make("checkout-native-concurrent-c"),
          ] as const;
          const service = StripeBilling.make({
            ids: {
              checkout: Effect.sync(() => candidateIds[generated++] ?? candidateIds[2]),
              customer: Effect.succeed(BillingCustomerId.make("unused-native-customer")),
            },
            now: Effect.succeed(new Date("2026-08-16T12:00:00.000Z")),
            offers: {
              adventurer: {
                priceId: StripePriceId.make("price_adventurer"),
                productId: StripeProductId.make("prod_adventurer"),
              },
            },
            persistence: makeStripePersistence(database),
            portal: {
              configurationId: StripePortalConfigurationId.make("bpc_native"),
              returnUrl: new URL("https://osfo.test/billing/return?source=portal"),
            },
            stripe: {
              createCheckout: (input) =>
                Effect.gen(function* () {
                  providerCalls += 1;
                  yield* Effect.tryPromise({
                    // oxlint-disable-next-line effecttsgo/async-function -- This probe must use another native PostgreSQL transaction.
                    try: async () => {
                      await client.begin((transaction) =>
                        transaction.unsafe(
                          "SELECT user_id FROM billing_subscriptions WHERE user_id = $1 FOR UPDATE NOWAIT",
                          [input.metadata.userId],
                        ),
                      );
                      providerObservedReleasedTransaction = true;
                    },
                    catch: () =>
                      new StripeBilling.StripeRequestFailed({
                        kind: "permanent",
                        message: "Provider call observed a held Checkout database transaction",
                        operation: "createCheckout",
                      }),
                  });
                  if (input.metadata.userId === concurrentUserId) {
                    yield* Deferred.succeed(providerEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }
                  return {
                    expiresAt: new Date("2026-08-17T12:00:00.000Z"),
                    stripeCheckoutSessionId: StripeCheckoutSessionId.make(
                      input.metadata.userId === concurrentUserId
                        ? "cs_test_nativeconcurrent"
                        : "cs_test_nativestale",
                    ),
                    url: new URL(`https://checkout.stripe.test/${input.idempotencyKey}`),
                  };
                }),
              createCustomer: () => Effect.die(new Error("must reuse native Customer")),
              createPortal: () => Effect.die(new Error("unused")),
              retrieveCheckout: (stripeCheckoutSessionId) =>
                Effect.succeed({
                  expiresAt: new Date("2026-08-17T12:00:00.000Z"),
                  state: "open",
                  stripeSubscriptionId: null,
                  url: new URL(`https://checkout.stripe.test/${stripeCheckoutSessionId}`),
                }),
            },
            urls: {
              cancel: new URL("https://osfo.test/billing"),
              success: new URL("https://osfo.test/billing/return?source=checkout"),
            },
            waitForCheckoutClaim: Effect.yieldNow,
          });

          const first = yield* Effect.forkChild(service.startCheckout(concurrentUserId));
          yield* Deferred.await(providerEntered);
          const second = yield* Effect.forkChild(service.startCheckout(concurrentUserId));
          yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
            discard: true,
          });
          yield* Deferred.succeed(releaseProvider, undefined);
          const concurrent = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
            concurrency: "unbounded",
          });

          expect(providerCalls).toBe(1);
          expect(providerObservedReleasedTransaction).toBe(true);
          expect(new Set(concurrent.map((start) => start.billingCheckoutSessionId)).size).toBe(1);

          const recovered = yield* service.startCheckout(staleUserId);
          expect(providerCalls).toBe(2);
          expect(recovered.billingCheckoutSessionId).toBe("checkout-native-stale");
        }),
      ),
  );
});

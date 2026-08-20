import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { billingCheckoutSessions, billingCustomers } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { checkoutEvidenceMatches } from "../src/db/billing/apply-checkout-evidence";
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
import { StripeSubscriptionSnapshot } from "../src/services/billing-subscriptions";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed provider evidence keeps identity-boundary tests deterministic. */

describe("Checkout evidence ownership", () => {
  it.effect(
    "accepts crash recovery only for the exact local User, Customer, Product, and Price",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const userId = UserId.make("user-checkout-evidence");
            yield* Effect.promise(() =>
              fixture.database.insert(users).values({
                email: "checkout-evidence@example.test",
                id: userId,
                name: "Checkout Evidence User",
              }),
            );
            yield* Effect.promise(() =>
              fixture.database.insert(billingCustomers).values({
                billing_customer_id: "customer-checkout-evidence",
                stripe_customer_id: "cus_checkoutevidence",
                user_id: userId,
              }),
            );
            yield* Effect.promise(() =>
              fixture.database.insert(billingCheckoutSessions).values({
                billing_checkout_session_id: "attempt-checkout-evidence",
                billing_customer_id: "customer-checkout-evidence",
                state: "creating",
                stripe_price_id: "price_adventurer",
                stripe_product_id: "prod_adventurer",
                target_plan: "adventurer",
                user_id: userId,
              }),
            );
            const evidence = {
              _tag: "Completed" as const,
              locator: {
                _tag: "LocalAttempt" as const,
                billingCheckoutSessionId: BillingCheckoutSessionId.make(
                  "attempt-checkout-evidence",
                ),
                stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_checkoutevidence"),
              },
              paymentStatus: "unknown" as const,
            };
            const snapshot = StripeSubscriptionSnapshot.make({
              cancelAtPeriodEnd: false,
              customerId: StripeCustomerId.make("cus_checkoutevidence"),
              currentPeriodRefunded: false,
              payment: {
                _tag: "Paid",
                invoiceId: StripeInvoiceId.make("in_checkoutevidence"),
              },
              period: {
                endsAt: new Date("2026-09-16T00:00:00.000Z"),
                startsAt: new Date("2026-08-16T00:00:00.000Z"),
              },
              priceId: StripePriceId.make("price_adventurer"),
              productId: StripeProductId.make("prod_adventurer"),
              status: "active",
              subscriptionId: StripeSubscriptionId.make("sub_checkoutevidence"),
              userId,
            });

            expect(
              yield* Effect.promise(() =>
                checkoutEvidenceMatches(fixture.database, evidence, snapshot),
              ),
            ).toBe(true);
            expect(
              yield* Effect.promise(() =>
                checkoutEvidenceMatches(
                  fixture.database,
                  {
                    ...evidence,
                    locator: {
                      ...evidence.locator,
                      billingCheckoutSessionId: BillingCheckoutSessionId.make(
                        "attempt-checkout-missing",
                      ),
                    },
                  },
                  snapshot,
                ),
              ),
            ).toBe(false);
            for (const conflictingSnapshot of [
              { ...snapshot, userId: UserId.make("user-cross-owner") },
              { ...snapshot, customerId: StripeCustomerId.make("cus_other") },
              { ...snapshot, productId: StripeProductId.make("prod_other") },
              { ...snapshot, priceId: StripePriceId.make("price_other") },
            ]) {
              expect(
                yield* Effect.promise(() =>
                  checkoutEvidenceMatches(fixture.database, evidence, conflictingSnapshot),
                ),
              ).toBe(false);
            }
            yield* Effect.promise(() =>
              fixture.database
                .update(billingCheckoutSessions)
                .set({ state: "open" })
                .where(
                  eq(
                    billingCheckoutSessions.billing_checkout_session_id,
                    evidence.locator.billingCheckoutSessionId,
                  ),
                ),
            );
            expect(
              yield* Effect.promise(() =>
                checkoutEvidenceMatches(fixture.database, evidence, snapshot),
              ),
            ).toBe(false);
            expect(
              yield* Effect.promise(() =>
                checkoutEvidenceMatches(
                  fixture.database,
                  {
                    ...evidence,
                    locator: {
                      _tag: "StripeSession",
                      stripeCheckoutSessionId: StripeCheckoutSessionId.make(
                        "cs_test_checkoutevidence",
                      ),
                    },
                  },
                  snapshot,
                ),
              ),
            ).toBe(false);
          }),
        closeTestDatabase,
      ),
  );
});

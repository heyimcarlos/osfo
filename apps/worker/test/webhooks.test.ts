import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { billingCheckoutSessions, billingCustomers } from "@osfo/db/schema/billing";
import { webhookEvents } from "@osfo/db/schema/webhooks";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import * as Webhooks from "../src/db/webhooks";
import { BillingCheckoutSessionId, StripeCheckoutSessionId } from "../src/domain";

describe("Webhook persistence", () => {
  it.effect("returns a typed persistence failure for a missing replay event", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const webhooks = Webhooks.make({
            database: fixture.database,
            webhookEventId: Effect.succeed("webhook-local-unused"),
          });

          const failure = yield* Effect.flip(webhooks.replay("webhook-missing"));

          expect(failure.operation).toBe("replay");
        }),
      closeTestDatabase,
    ),
  );

  it.effect("deduplicates Stripe redelivery and preserves attempt history through replay", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const webhooks = Webhooks.make({
            database: fixture.database,
            webhookEventId: Effect.succeed("webhook-local-1"),
          });
          const event = {
            billingCheckoutSessionId: null,
            externalEventId: "evt_redelivery",
            externalObjectId: "sub_redelivery",
            type: "customer.subscription.updated",
          };

          const first = yield* webhooks.receive(event);
          const redelivery = yield* webhooks.receive(event);
          yield* webhooks.fail("webhook-local-1", "invalid_price_allowlist", null);
          const replayed = yield* webhooks.replay("webhook-local-1");
          yield* webhooks.markProcessed("webhook-local-1", null);
          const processedDuplicate = yield* webhooks.receive(event);
          const processedReplay = yield* webhooks.replay("webhook-local-1");
          const [stored] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(webhookEvents)
              .where(eq(webhookEvents.webhookEventId, "webhook-local-1")),
          );

          expect(first).toEqual({ _tag: "Pending", attempt: 1, webhookEventId: "webhook-local-1" });
          expect(redelivery).toEqual({
            _tag: "Pending",
            attempt: 2,
            webhookEventId: "webhook-local-1",
          });
          expect(replayed).toEqual({
            _tag: "Pending",
            attempt: 3,
            event: { provider: "stripe", ...event },
            webhookEventId: "webhook-local-1",
          });
          expect(processedDuplicate).toEqual({ _tag: "ProcessedDuplicate" });
          expect(processedReplay).toEqual({ _tag: "ProcessedDuplicate" });
          expect(stored).toMatchObject({
            attempts: 3,
            errorCode: null,
            provider: "stripe",
            status: "processed",
          });
          expect(stored?.processedAt).toBeInstanceOf(Date);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("records Checkout terminal evidence before a verified no-op is processed", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "checkout-webhook@example.test",
              id: "user-checkout-webhook",
              name: "Checkout Webhook",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCustomers).values({
              billingCustomerId: "customer-checkout-webhook",
              userId: "user-checkout-webhook",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCheckoutSessions).values({
              billingCheckoutSessionId: "checkout-local-webhook",
              billingCustomerId: "customer-checkout-webhook",
              state: "creating",
              stripePriceId: "price_adventurer",
              stripeProductId: "prod_adventurer",
              targetPlan: "adventurer",
              userId: "user-checkout-webhook",
            }),
          );
          const webhooks = Webhooks.make({
            database: fixture.database,
            webhookEventId: Effect.succeed("webhook-checkout-failed"),
          });
          const receipt = yield* webhooks.receive({
            billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-local-webhook"),
            externalEventId: "evt_checkout_failed",
            externalObjectId: "cs_test_failedwebhook",
            type: "checkout.session.async_payment_failed",
          });
          yield* webhooks.markProcessed("webhook-checkout-failed", {
            _tag: "PaymentFailed",
            locator: {
              _tag: "LocalAttempt",
              billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-local-webhook"),
              stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_failedwebhook"),
            },
          });
          const [checkout] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingCheckoutSessions)
              .where(
                eq(billingCheckoutSessions.billingCheckoutSessionId, "checkout-local-webhook"),
              ),
          );

          expect(receipt).toEqual({
            _tag: "Pending",
            attempt: 1,
            webhookEventId: "webhook-checkout-failed",
          });
          expect(checkout).toMatchObject({
            state: "failed",
            stripeCheckoutSessionId: "cs_test_failedwebhook",
            stripePaymentStatus: "unpaid",
          });
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rejects conflicting local and Stripe Checkout identities", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "checkout-mismatch@example.test",
              id: "user-checkout-mismatch",
              name: "Checkout Mismatch",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCustomers).values({
              billingCustomerId: "customer-checkout-mismatch",
              userId: "user-checkout-mismatch",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCheckoutSessions).values({
              billingCheckoutSessionId: "checkout-local-mismatch",
              billingCustomerId: "customer-checkout-mismatch",
              state: "open",
              stripeCheckoutSessionId: "cs_test_original",
              stripePriceId: "price_adventurer",
              stripeProductId: "prod_adventurer",
              targetPlan: "adventurer",
              userId: "user-checkout-mismatch",
            }),
          );
          const webhooks = Webhooks.make({
            database: fixture.database,
            webhookEventId: Effect.succeed("webhook-checkout-mismatch"),
          });
          yield* webhooks.receive({
            billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-local-mismatch"),
            externalEventId: "evt_checkout_mismatch",
            externalObjectId: "cs_test_conflict",
            type: "checkout.session.completed",
          });

          const failure = yield* webhooks
            .markProcessed("webhook-checkout-mismatch", {
              _tag: "Completed",
              locator: {
                _tag: "LocalAttempt",
                billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-local-mismatch"),
                stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_conflict"),
              },
              paymentStatus: "unknown",
            })
            .pipe(Effect.flip);
          const [checkout] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingCheckoutSessions)
              .where(
                eq(billingCheckoutSessions.billingCheckoutSessionId, "checkout-local-mismatch"),
              ),
          );

          expect(failure).toMatchObject({
            _tag: "PermanentStripeWebhookFailure",
            errorCode: "checkout_identity_mismatch",
          });
          expect(checkout).toMatchObject({
            state: "open",
            stripeCheckoutSessionId: "cs_test_original",
          });
        }),
      closeTestDatabase,
    ),
  );
});

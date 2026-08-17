import { describe, expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
} from "@osfo/db/schema/billing";
import { webhookEvents } from "@osfo/db/schema/webhooks";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  AllowancePeriodId,
  BillingCheckoutSessionId,
  StripeCheckoutSessionId,
  StripeInvoiceId,
  StripeCustomerId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../src/domain";
import * as BillingSubscriptions from "../src/services/billing-subscriptions";
import * as Billing from "../src/db/billing";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date, effecttsgo/global-date-in-effect -- These database tests use fixed Date fixtures at the Drizzle boundary and inspect Effect tags. */

const userId = UserId.make("user-billing");
const periodStart = new Date("2026-08-16T12:00:00.000Z");
const periodEnd = new Date("2026-09-16T12:00:00.000Z");

const paidSnapshot = BillingSubscriptions.StripeSubscriptionSnapshot.make({
  cancelAtPeriodEnd: false,
  customerId: StripeCustomerId.make("cus_billing"),
  currentPeriodRefunded: false,
  payment: {
    _tag: "Paid",
    invoiceId: StripeInvoiceId.make("in_billing"),
  },
  period: { endsAt: periodEnd, startsAt: periodStart },
  priceId: StripePriceId.make("price_adventurer"),
  productId: StripeProductId.make("prod_adventurer"),
  status: "active",
  subscriptionId: StripeSubscriptionId.make("sub_billing"),
  userId,
});

const confirmedAt = new Date("2026-08-16T12:30:00.000Z");

const makeService = (persistence: BillingSubscriptions.Persistence) => {
  let identity = 0;
  return BillingSubscriptions.make(persistence, {
    allowancePeriodId: Effect.sync(() =>
      AllowancePeriodId.make(`allowance-period-generated-${identity++}`),
    ),
    now: Effect.succeed(confirmedAt),
  });
};

const applyCurrent = (
  service: BillingSubscriptions.Interface,
  source: BillingSubscriptions.StripeSnapshotSource,
  snapshot: BillingSubscriptions.StripeSubscriptionSnapshot,
) =>
  service
    .loadRevision(snapshot.userId)
    .pipe(
      Effect.flatMap((revision) => service.applyStripeSnapshot(source, revision, snapshot, null)),
    );

describe("BillingSubscriptions projection failures", () => {
  it.effect("activates Adventurer only from complete paid Stripe facts", () =>
    Effect.gen(function* () {
      const applied: Array<BillingSubscriptions.ApplyStripeSnapshotInput> = [];
      const service = makeService({
        load: () => Effect.succeed({ updatedAt: new Date("2026-08-16T11:00:00.000Z") }),
        apply: (input) => {
          applied.push(input);
          return Effect.succeed({ _tag: "Activated" as const });
        },
      });

      const result = yield* applyCurrent(
        service,
        { _tag: "Reconciliation", reason: "checkoutReturn" },
        paidSnapshot,
      );

      expect(result).toEqual({ _tag: "Activated" });
      expect(applied).toEqual([
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-generated-0"),
          checkoutEvidence: null,
          confirmedAt,
          expectedUpdatedAt: new Date("2026-08-16T11:00:00.000Z"),
          freePeriodEndsAt: new Date("2026-09-15T12:30:00.000Z"),
          snapshot: paidSnapshot,
          source: { _tag: "Reconciliation", reason: "checkoutReturn" },
        },
      ]);
    }),
  );

  it.effect("rolls back webhook status and billing writes when projection persistence fails", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const rollbackUserId = UserId.make("user-billing-rollback");
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "billing-rollback@example.test",
              id: rollbackUserId,
              name: "Billing Rollback User",
              updatedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCustomers).values({
              billingCustomerId: "billing-customer-rollback",
              stripeCustomerId: "cus_rollback",
              userId: rollbackUserId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billingCustomerId: "billing-customer-rollback",
              billingSubscriptionId: "billing-subscription-rollback",
              plan: "free",
              planPolicyVersion: "launch-v1",
              userId: rollbackUserId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCheckoutSessions).values({
              billingCheckoutSessionId: "checkout-rollback",
              billingCustomerId: "billing-customer-rollback",
              state: "creating",
              stripePriceId: "price_adventurer",
              stripeProductId: "prod_adventurer",
              targetPlan: "adventurer",
              userId: rollbackUserId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(allowancePeriods).values({
              allowancePeriodId: "allowance-period-collision",
              billingSubscriptionId: "billing-subscription-rollback",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              endsAt: new Date("2026-08-31T00:00:00.000Z"),
              plan: "free",
              planPolicyVersion: "launch-v1",
              startsAt: new Date("2026-08-01T00:00:00.000Z"),
              userId: rollbackUserId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(webhookEvents).values({
              externalEventId: "evt_rollback",
              externalObjectId: "cs_test_rollback",
              eventType: "checkout.session.completed",
              provider: "stripe",
              status: "pending",
              webhookEventId: "webhook-rollback",
            }),
          );
          const billing = Billing.make(fixture.database);
          const service = BillingSubscriptions.make(billing, {
            allowancePeriodId: Effect.succeed(AllowancePeriodId.make("allowance-period-collision")),
            now: Effect.succeed(confirmedAt),
          });
          const snapshot = BillingSubscriptions.StripeSubscriptionSnapshot.make({
            ...paidSnapshot,
            customerId: StripeCustomerId.make("cus_rollback"),
            subscriptionId: StripeSubscriptionId.make("sub_rollback"),
            userId: rollbackUserId,
          });
          const revision = yield* service.loadRevision(rollbackUserId);
          const exit = yield* service
            .applyStripeSnapshot(
              { _tag: "Webhook", webhookEventId: "webhook-rollback" },
              revision,
              snapshot,
              {
                _tag: "Completed",
                locator: {
                  _tag: "LocalAttempt",
                  billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-rollback"),
                  stripeCheckoutSessionId: StripeCheckoutSessionId.make("cs_test_rollback"),
                },
                paymentStatus: "unknown",
              },
            )
            .pipe(Effect.exit);
          const [storedSubscription] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingSubscriptions)
              .where(eq(billingSubscriptions.userId, rollbackUserId)),
          );
          const [storedWebhook] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(webhookEvents)
              .where(eq(webhookEvents.webhookEventId, "webhook-rollback")),
          );
          const storedPeriods = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(allowancePeriods)
              .where(eq(allowancePeriods.userId, rollbackUserId)),
          );
          const [storedCheckout] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingCheckoutSessions)
              .where(eq(billingCheckoutSessions.billingCheckoutSessionId, "checkout-rollback")),
          );

          expect(exit._tag).toBe("Failure");
          expect(storedSubscription?.plan).toBe("free");
          expect(storedWebhook).toMatchObject({ processedAt: null, status: "pending" });
          expect(storedCheckout).toMatchObject({
            state: "creating",
            stripeCheckoutSessionId: null,
            stripePaymentStatus: null,
          });
          expect(storedPeriods).toHaveLength(1);
          expect(storedPeriods[0]?.endsAt).toEqual(new Date("2026-08-31T00:00:00.000Z"));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("keeps every non-active or unpaid Stripe state on Free", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const cases = [
            { payment: { _tag: "Unknown" as const }, status: "active" as const },
            { payment: { _tag: "NotPaid" as const }, status: "trialing" as const },
            { payment: { _tag: "NotPaid" as const }, status: "incomplete" as const },
            { payment: { _tag: "NotPaid" as const }, status: "incomplete_expired" as const },
            { payment: { _tag: "NotPaid" as const }, status: "past_due" as const },
            { payment: { _tag: "NotPaid" as const }, status: "unpaid" as const },
            { payment: { _tag: "NotPaid" as const }, status: "paused" as const },
            { payment: { _tag: "NotPaid" as const }, status: "canceled" as const },
          ];
          const billing = Billing.make(fixture.database);
          const service = makeService(billing);

          const results = yield* Effect.forEach(cases, (testCase, index) =>
            Effect.gen(function* () {
              const caseUserId = UserId.make(`user-fail-closed-${index}`);
              const subscriptionId = `billing-subscription-fail-closed-${index}`;
              yield* Effect.promise(() =>
                fixture.database.insert(users).values({
                  email: `fail-closed-${index}@example.test`,
                  id: caseUserId,
                  name: "Fail Closed User",
                  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
                }),
              );
              yield* Effect.promise(() =>
                fixture.database.insert(billingCustomers).values({
                  billingCustomerId: `billing-customer-fail-closed-${index}`,
                  stripeCustomerId: `cus_failclosed${index}`,
                  userId: caseUserId,
                }),
              );
              yield* Effect.promise(() =>
                fixture.database.insert(billingSubscriptions).values({
                  billingSubscriptionId: subscriptionId,
                  billingCustomerId: `billing-customer-fail-closed-${index}`,
                  createdAt: new Date("2026-08-01T00:00:00.000Z"),
                  plan: "free",
                  planPolicyVersion: "launch-v1",
                  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
                  userId: caseUserId,
                }),
              );
              yield* Effect.promise(() =>
                fixture.database.insert(allowancePeriods).values({
                  allowancePeriodId: `allowance-period-fail-closed-${index}`,
                  billingSubscriptionId: subscriptionId,
                  createdAt: new Date("2026-08-01T00:00:00.000Z"),
                  endsAt: new Date("2030-09-01T00:00:00.000Z"),
                  plan: "free",
                  planPolicyVersion: "launch-v1",
                  startsAt: new Date("2026-08-01T00:00:00.000Z"),
                  userId: caseUserId,
                }),
              );
              return yield* applyCurrent(
                service,
                { _tag: "Reconciliation", reason: "internal" },
                BillingSubscriptions.StripeSubscriptionSnapshot.make({
                  ...paidSnapshot,
                  customerId: StripeCustomerId.make(`cus_failclosed${index}`),
                  payment: testCase.payment,
                  status: testCase.status,
                  subscriptionId: StripeSubscriptionId.make(`sub_failclosed${index}`),
                  userId: caseUserId,
                }),
              );
            }),
          );
          const stored = yield* Effect.promise(() =>
            fixture.database.select().from(billingSubscriptions),
          );

          expect(results).toEqual(cases.map(() => ({ _tag: "Unchanged" })));
          expect(stored.every((subscription) => subscription.plan === "free")).toBe(true);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("fails closed when active Stripe state has no paid invoice", () =>
    Effect.gen(function* () {
      const service = makeService({
        load: () => Effect.succeed({ updatedAt: new Date("2026-08-16T11:00:00.000Z") }),
        apply: () => Effect.succeed({ _tag: "Unchanged" as const }),
      });
      const snapshot = BillingSubscriptions.StripeSubscriptionSnapshot.make({
        ...paidSnapshot,
        payment: { _tag: "Unknown" },
      });

      const result = yield* applyCurrent(
        service,
        { _tag: "Reconciliation", reason: "portalReturn" },
        snapshot,
      );

      expect(result).toEqual({ _tag: "Unchanged" });
    }),
  );

  it.effect("refetches current Stripe state after an optimistic update loses", () =>
    Effect.gen(function* () {
      let loads = 0;
      let fetches = 0;
      let applies = 0;
      const order: Array<string> = [];
      const service = makeService({
        load: () => {
          loads += 1;
          order.push("load");
          return Effect.succeed({
            updatedAt: new Date(`2026-08-16T11:00:0${loads}.000Z`),
          });
        },
        apply: () => {
          applies += 1;
          order.push("apply");
          return Effect.succeed(
            applies === 1 ? ({ _tag: "StaleSnapshot" } as const) : ({ _tag: "Activated" } as const),
          );
        },
      });

      const result = yield* service.reconcile({ _tag: "User", userId }, "internal", () => {
        fetches += 1;
        order.push("fetch");
        return Effect.succeed(paidSnapshot);
      });

      expect(result).toEqual({ _tag: "Activated" });
      expect({ applies, fetches, loads }).toEqual({ applies: 2, fetches: 2, loads: 2 });
      expect(order).toEqual(["load", "fetch", "apply", "load", "fetch", "apply"]);
    }),
  );
});

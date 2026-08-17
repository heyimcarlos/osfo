import { describe, expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingCustomers, billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  AllowancePeriodId,
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

const makeService = (
  persistence: BillingSubscriptions.Persistence,
  now: Effect.Effect<Date> = Effect.succeed(confirmedAt),
) => {
  let identity = 0;
  return BillingSubscriptions.make(persistence, {
    allowancePeriodId: Effect.sync(() =>
      AllowancePeriodId.make(`allowance-period-generated-${identity++}`),
    ),
    now,
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

describe("BillingSubscriptions", () => {
  it("selects exact allowance commands outside the PostgreSQL adapter", () => {
    const activePeriodId = AllowancePeriodId.make("allowance-period-active-policy");
    const decision = BillingSubscriptions.decideStripeTransition(
      {
        plan: "adventurer",
        stripeCurrentPeriodEnd: periodEnd,
        stripeLatestInvoiceId: StripeInvoiceId.make("in_billing"),
      },
      {
        allowancePeriodId: activePeriodId,
        endsAt: periodEnd,
        startsAt: periodStart,
      },
      BillingSubscriptions.StripeSubscriptionSnapshot.make({
        ...paidSnapshot,
        currentPeriodRefunded: true,
        payment: { _tag: "NotPaid" },
      }),
      confirmedAt,
      new Date("2026-09-15T12:30:00.000Z"),
    );

    expect(decision).toMatchObject({
      _tag: "EndAccess",
      allowance: {
        create: { plan: "free", startsAt: confirmedAt },
        deleteFutureAdventurerAtOrAfter: confirmedAt,
        shortenActivePeriod: { allowancePeriodId: activePeriodId, endsAt: confirmedAt },
      },
      result: { _tag: "AccessEnded" },
    });
  });

  it("does not grant paid access before Stripe's confirmed period starts", () => {
    const decision = BillingSubscriptions.decideStripeTransition(
      {
        plan: "free",
        stripeCurrentPeriodEnd: null,
        stripeLatestInvoiceId: null,
      },
      null,
      BillingSubscriptions.StripeSubscriptionSnapshot.make({
        ...paidSnapshot,
        period: {
          endsAt: periodEnd,
          startsAt: new Date("2026-08-16T13:00:00.000Z"),
        },
      }),
      confirmedAt,
      new Date("2026-09-15T12:30:00.000Z"),
    );

    expect(decision).toMatchObject({
      _tag: "Observe",
      result: { _tag: "Unchanged" },
    });
  });

  it.effect("writes contiguous upgrade, renewal, cancellation, recovery, and refund periods", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "billing@example.test",
              id: userId,
              name: "Billing User",
              updatedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCustomers).values({
              billingCustomerId: "billing-customer-1",
              stripeCustomerId: "cus_billing",
              userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billingSubscriptionId: "billing-subscription-1",
              billingCustomerId: "billing-customer-1",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              plan: "free",
              planPolicyVersion: "launch-v1",
              stripePriceId: "price_previous",
              stripeProductId: "prod_previous",
              stripeStatus: "canceled",
              stripeSubscriptionId: "sub_previous",
              updatedAt: new Date("2026-08-01T00:00:00.000Z"),
              userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(allowancePeriods).values({
              allowancePeriodId: "allowance-period-free",
              billingSubscriptionId: "billing-subscription-1",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              endsAt: new Date("2026-08-31T00:00:00.000Z"),
              plan: "free",
              planPolicyVersion: "launch-v1",
              startsAt: new Date("2026-08-01T00:00:00.000Z"),
              userId,
            }),
          );
          const billing = Billing.make(fixture.database);
          let currentTime = confirmedAt;
          const service = makeService(
            billing,
            Effect.sync(() => currentTime),
          );

          const result = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "checkoutReturn" },
            paidSnapshot,
          );
          const [subscription] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingSubscriptions)
              .where(eq(billingSubscriptions.userId, userId)),
          );
          const periods = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(allowancePeriods)
              .where(eq(allowancePeriods.userId, userId))
              .orderBy(asc(allowancePeriods.startsAt)),
          );

          expect(result).toEqual({ _tag: "Activated" });
          expect(subscription).toMatchObject({
            plan: "adventurer",
            stripeLatestInvoiceId: "in_billing",
            stripePriceId: "price_adventurer",
            stripeProductId: "prod_adventurer",
            stripeStatus: "active",
            stripeSubscriptionId: "sub_billing",
          });
          expect(periods).toHaveLength(2);
          expect(periods[0]?.endsAt.getTime()).toBe(periods[1]?.startsAt.getTime());
          expect(periods[1]).toMatchObject({
            endsAt: periodEnd,
            plan: "adventurer",
            stripeInvoiceId: "in_billing",
          });

          const renewalEnd = new Date("2026-10-16T12:00:00.000Z");
          currentTime = periodEnd;
          const renewal = BillingSubscriptions.StripeSubscriptionSnapshot.make({
            ...paidSnapshot,
            payment: {
              _tag: "Paid",
              invoiceId: StripeInvoiceId.make("in_renewal"),
            },
            period: { endsAt: renewalEnd, startsAt: periodEnd },
          });
          const renewalResult = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "internal" },
            renewal,
          );
          const renewedPeriods = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(allowancePeriods)
              .where(eq(allowancePeriods.userId, userId))
              .orderBy(asc(allowancePeriods.startsAt)),
          );

          expect(renewalResult).toEqual({ _tag: "Activated" });
          expect(renewedPeriods).toHaveLength(3);
          expect(renewedPeriods[1]?.endsAt.getTime()).toBe(renewedPeriods[2]?.startsAt.getTime());
          expect(renewedPeriods[2]).toMatchObject({
            endsAt: renewalEnd,
            plan: "adventurer",
            stripeInvoiceId: "in_renewal",
          });

          const scheduledResult = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "portalReturn" },
            BillingSubscriptions.StripeSubscriptionSnapshot.make({
              ...renewal,
              cancelAtPeriodEnd: true,
            }),
          );
          const paymentFailureResult = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "internal" },
            BillingSubscriptions.StripeSubscriptionSnapshot.make({
              ...renewal,
              payment: { _tag: "NotPaid" },
              period: {
                endsAt: new Date("2026-11-16T12:00:00.000Z"),
                startsAt: renewalEnd,
              },
            }),
          );
          const [failedRenewal] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingSubscriptions)
              .where(eq(billingSubscriptions.userId, userId)),
          );
          const immediateCancellationResult = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "internal" },
            BillingSubscriptions.StripeSubscriptionSnapshot.make({
              ...renewal,
              payment: { _tag: "NotPaid" },
              status: "canceled",
            }),
          );
          const recovery = BillingSubscriptions.StripeSubscriptionSnapshot.make({
            ...renewal,
            payment: {
              _tag: "Paid",
              invoiceId: StripeInvoiceId.make("in_recovery"),
            },
            period: { endsAt: renewalEnd, startsAt: new Date("2026-08-01T00:00:00.000Z") },
          });
          const recoveryResult = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "internal" },
            recovery,
          );

          expect(scheduledResult).toEqual({ _tag: "DowngradeScheduled" });
          expect(paymentFailureResult).toEqual({ _tag: "DowngradeScheduled" });
          expect(failedRenewal?.pendingPlanEffectiveAt).toEqual(renewalEnd);
          expect(failedRenewal?.stripeCurrentPeriodEnd).toEqual(renewalEnd);
          expect(immediateCancellationResult).toEqual({ _tag: "AccessEnded" });
          expect(recoveryResult).toEqual({ _tag: "Activated" });

          const refundResult = yield* applyCurrent(
            service,
            { _tag: "Reconciliation", reason: "internal" },
            BillingSubscriptions.StripeSubscriptionSnapshot.make({
              ...recovery,
              currentPeriodRefunded: true,
              payment: { _tag: "NotPaid" },
            }),
          );
          const [refundedSubscription] = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(billingSubscriptions)
              .where(eq(billingSubscriptions.userId, userId)),
          );
          const refundedPeriods = yield* Effect.promise(() =>
            fixture.database
              .select()
              .from(allowancePeriods)
              .where(eq(allowancePeriods.userId, userId))
              .orderBy(asc(allowancePeriods.startsAt)),
          );

          expect(refundResult).toEqual({ _tag: "AccessEnded" });
          expect(refundedSubscription?.plan).toBe("free");
          expect(refundedPeriods.at(-1)?.plan).toBe("free");
          expect(
            refundedPeriods.slice(1).every((period, index) => {
              const previous = refundedPeriods[index];
              return (
                previous !== undefined && previous.endsAt.getTime() <= period.startsAt.getTime()
              );
            }),
          ).toBe(true);

          const revision = yield* service.loadRevision(userId);
          const mismatched = yield* service
            .applyStripeSnapshot(
              { _tag: "Reconciliation", reason: "internal" },
              revision,
              BillingSubscriptions.StripeSubscriptionSnapshot.make({
                ...paidSnapshot,
                customerId: StripeCustomerId.make("cus_another"),
              }),
              null,
            )
            .pipe(Effect.flip);
          expect(mismatched).toMatchObject({ _tag: "InvalidStripeSnapshot" });
        }),
      closeTestDatabase,
    ),
  );
});

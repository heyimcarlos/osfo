import { describe, expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingCustomers, billingSubscriptions } from "@osfo/db/schema/billing";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { inspectAndRepairBillingAuthorization } from "../src/db/billing/stripe-inspect";
import * as BillingAuthorizationComposition from "../src/composition/billing-authorization";
import { AllowancePeriodId, Plan, PlanPolicyVersion, UserId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import { admit } from "../src/services/billing-authorization";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed Date fixtures keep Authorization boundary and persisted-fact tests deterministic. */

const now = new Date("2026-08-16T12:00:00.000Z");

const facts = {
  authSessionExpiresAt: new Date("2026-08-16T13:00:00.000Z"),
  authSessionId: AuthSessionId.make("session-001"),
  plan: Plan.make("free"),
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  deletionAccess: { _tag: "DeletionAccessAvailable" as const },
  user: { _tag: "ActiveUser" as const, userId: UserId.make("user-001") },
  userId: UserId.make("user-001"),
};

describe("billing Authorization", () => {
  it("admits inspection and subscription management through the retained policy", () => {
    expect(admit(facts, "billing.inspect", now)).toBe(true);
    expect(admit(facts, "subscription.manage", now)).toBe(true);
  });

  it("fails closed when the AuthSession is expired", () => {
    expect(
      admit(
        { ...facts, authSessionExpiresAt: new Date("2026-08-16T11:59:59.999Z") },
        "subscription.manage",
        now,
      ),
    ).toBe(false);
  });

  it("fails closed when the persisted policy is not retained", () => {
    expect(
      admit(
        { ...facts, planPolicyVersion: PlanPolicyVersion.make("retired-policy") },
        "billing.inspect",
        now,
      ),
    ).toBe(false);
  });

  it("fails closed for a persisted suspended User or revoked deletion access", () => {
    expect(
      admit(
        { ...facts, user: { _tag: "SuspendedUser", userId: facts.userId } },
        "billing.inspect",
        now,
      ),
    ).toBe(false);
    expect(
      admit(
        { ...facts, deletionAccess: { _tag: "DeletionAccessRevoked" } },
        "subscription.manage",
        now,
      ),
    ).toBe(false);
  });

  it.effect("reads suspension and deletion access from their live authority owners", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const userId = UserId.make("user-live-billing-authority");
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "live-billing-authority@example.test",
              id: userId,
              name: "Live Billing Authority",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billingSubscriptionId: "subscription-live-billing-authority",
              plan: "free",
              planPolicyVersion: "launch-v1",
              userId,
            }),
          );
          const authorize = yield* BillingAuthorizationComposition.make(fixture.database, {
            allowancePeriodId: Effect.succeed(
              AllowancePeriodId.make("allowance-live-billing-authority"),
            ),
            now: Effect.succeed(now),
          });
          const currentUser = {
            authSessionExpiresAt: new Date("2026-08-16T13:00:00.000Z"),
            authSessionId: "session-live-billing-authority",
            userId,
          };

          expect(yield* authorize(currentUser, "billing.inspect")).toBe(true);
          yield* Effect.promise(() =>
            fixture.database.insert(userSuspensionEvents).values({
              action: "suspended",
              adminActorId: "admin-billing-authority",
              eventId: "suspension-live-billing-authority",
              occurredAt: new Date("2026-08-16T11:00:00.000Z"),
              reason: "safety review",
              userId,
            }),
          );
          expect(yield* authorize(currentUser, "billing.inspect")).toBe(false);
          yield* Effect.promise(() =>
            fixture.database.insert(userSuspensionEvents).values({
              action: "restored",
              adminActorId: "admin-billing-authority",
              eventId: "restoration-live-billing-authority",
              occurredAt: new Date("2026-08-16T11:30:00.000Z"),
              reason: "review complete",
              userId,
            }),
          );
          expect(yield* authorize(currentUser, "billing.inspect")).toBe(true);
          yield* Effect.promise(() =>
            fixture.database.insert(deletionCases).values({
              deletionCaseId: "deletion-live-billing-authority",
              reason: "user request",
              requestedByAdminId: "admin-billing-authority",
              userId,
            }),
          );
          expect(yield* authorize(currentUser, "billing.inspect")).toBe(false);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("fails closed at the confirmed paid-period boundary and repairs one Free period", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const userId = UserId.make("user-expired-paid-period");
          const periodEnd = new Date("2026-08-16T12:00:00.000Z");
          const freePeriodEnd = new Date("2026-09-15T12:00:00.000Z");
          const repair = {
            allowancePeriodId: AllowancePeriodId.make("allowance-expired-paid-period-free"),
            freePeriodEnd,
          };
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              email: "expired-paid-period@example.test",
              id: userId,
              name: "Expired Paid Period User",
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingCustomers).values({
              billingCustomerId: "customer-expired-paid-period",
              stripeCustomerId: "cus_expired_paid_period",
              userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billingCustomerId: "customer-expired-paid-period",
              billingSubscriptionId: "subscription-expired-paid-period",
              plan: "adventurer",
              planPolicyVersion: "launch-v1",
              stripeCurrentPeriodEnd: periodEnd,
              stripeCurrentPeriodStart: new Date("2026-07-16T12:00:00.000Z"),
              stripeLatestInvoiceId: "in_expired_paid_period",
              stripePriceId: "price_adventurer",
              stripeProductId: "prod_adventurer",
              stripeStatus: "active",
              stripeSubscriptionId: "sub_expired_paid_period",
              userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(allowancePeriods).values({
              allowancePeriodId: "allowance-expired-paid-period-adventurer",
              billingSubscriptionId: "subscription-expired-paid-period",
              endsAt: periodEnd,
              plan: "adventurer",
              planPolicyVersion: "launch-v1",
              startsAt: new Date("2026-07-16T12:00:00.000Z"),
              stripeInvoiceId: "in_expired_paid_period",
              userId,
            }),
          );

          const beforeEnd = yield* inspectAndRepairBillingAuthorization(
            fixture.database,
            userId,
            new Date("2026-08-16T11:59:59.999Z"),
            repair,
          );
          expect(beforeEnd.plan).toBe("adventurer");

          const atEnd = yield* inspectAndRepairBillingAuthorization(
            fixture.database,
            userId,
            periodEnd,
            repair,
          );
          expect(atEnd.plan).toBe("free");
          const [repaired] = yield* Effect.promise(() =>
            fixture.database
              .select({
                pendingPlan: billingSubscriptions.pendingPlan,
                plan: billingSubscriptions.plan,
              })
              .from(billingSubscriptions)
              .where(eq(billingSubscriptions.userId, userId)),
          );
          expect(repaired).toEqual({ pendingPlan: null, plan: "free" });
          const periods = yield* Effect.promise(() =>
            fixture.database
              .select({
                endsAt: allowancePeriods.endsAt,
                plan: allowancePeriods.plan,
                startsAt: allowancePeriods.startsAt,
              })
              .from(allowancePeriods)
              .where(eq(allowancePeriods.userId, userId)),
          );
          expect(periods).toContainEqual({
            endsAt: freePeriodEnd,
            plan: "free",
            startsAt: periodEnd,
          });
        }),
      closeTestDatabase,
    ),
  );
});

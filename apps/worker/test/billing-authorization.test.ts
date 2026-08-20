import { describe, expect, it } from "@effect/vitest";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingCustomers, billingSubscriptions } from "@osfo/db/schema/billing";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { inspectAndRepairBillingAuthorization } from "../src/db/billing/stripe-inspect";
import { BillingAuthorization } from "../src/composition/billing-authorization";
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
            fixture.database.insert(sessions).values({
              expiresAt: new Date("2026-08-16T13:00:00.000Z"),
              id: "session-live-billing-authority",
              token: "token-live-billing-authority",
              updatedAt: new Date("2026-08-16T11:00:00.000Z"),
              userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billing_subscription_id: "subscription-live-billing-authority",
              plan: "free",
              plan_policy_version: "launch-v1",
              user_id: userId,
            }),
          );
          const authorize = yield* BillingAuthorization.make(fixture.database, {
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
              admin_actor_id: "admin-billing-authority",
              event_id: "suspension-live-billing-authority",
              occurred_at: new Date("2026-08-16T11:00:00.000Z"),
              reason: "safety review",
              user_id: userId,
            }),
          );
          expect(yield* authorize(currentUser, "billing.inspect")).toBe(false);
          yield* Effect.promise(() =>
            fixture.database.insert(userSuspensionEvents).values({
              action: "restored",
              admin_actor_id: "admin-billing-authority",
              event_id: "restoration-live-billing-authority",
              occurred_at: new Date("2026-08-16T11:30:00.000Z"),
              reason: "review complete",
              user_id: userId,
            }),
          );
          expect(yield* authorize(currentUser, "billing.inspect")).toBe(true);
          yield* Effect.promise(() =>
            fixture.database.insert(deletionCases).values({
              deletion_case_id: "deletion-live-billing-authority",
              reason: "user request",
              requested_by_admin_id: "admin-billing-authority",
              user_id: userId,
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
              billing_customer_id: "customer-expired-paid-period",
              stripe_customer_id: "cus_expired_paid_period",
              user_id: userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billing_customer_id: "customer-expired-paid-period",
              billing_subscription_id: "subscription-expired-paid-period",
              plan: "adventurer",
              plan_policy_version: "launch-v1",
              stripe_current_period_end: periodEnd,
              stripe_current_period_start: new Date("2026-07-16T12:00:00.000Z"),
              stripe_latest_invoice_id: "in_expired_paid_period",
              stripe_price_id: "price_adventurer",
              stripe_product_id: "prod_adventurer",
              stripe_status: "active",
              stripe_subscription_id: "sub_expired_paid_period",
              user_id: userId,
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(allowancePeriods).values({
              allowance_period_id: "allowance-expired-paid-period-adventurer",
              billing_subscription_id: "subscription-expired-paid-period",
              ends_at: periodEnd,
              plan: "adventurer",
              plan_policy_version: "launch-v1",
              starts_at: new Date("2026-07-16T12:00:00.000Z"),
              stripe_invoice_id: "in_expired_paid_period",
              user_id: userId,
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
                pendingPlan: billingSubscriptions.pending_plan,
                plan: billingSubscriptions.plan,
              })
              .from(billingSubscriptions)
              .where(eq(billingSubscriptions.user_id, userId)),
          );
          expect(repaired).toEqual({ pendingPlan: null, plan: "free" });
          const periods = yield* Effect.promise(() =>
            fixture.database
              .select({
                endsAt: allowancePeriods.ends_at,
                plan: allowancePeriods.plan,
                startsAt: allowancePeriods.starts_at,
              })
              .from(allowancePeriods)
              .where(eq(allowancePeriods.user_id, userId)),
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

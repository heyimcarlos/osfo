import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { inspectBillingAuthorization } from "../src/db/billing/stripe-inspect";
import { Plan, PlanPolicyVersion, UserId } from "../src/domain";
import { admit } from "../src/services/billing-authorization";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed Date fixtures keep Authorization boundary and persisted-fact tests deterministic. */

const now = new Date("2026-08-16T12:00:00.000Z");

const facts = {
  authSessionExpiresAt: new Date("2026-08-16T13:00:00.000Z"),
  authSessionId: "session-001",
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

  it.effect("loads current User safety facts with the Subscription policy", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              deletionAccessRevokedAt: new Date("2026-08-16T10:00:00.000Z"),
              email: "billing-authorization@example.test",
              id: facts.userId,
              name: "Billing Authorization User",
              suspendedAt: new Date("2026-08-16T09:00:00.000Z"),
            }),
          );
          yield* Effect.promise(() =>
            fixture.database.insert(billingSubscriptions).values({
              billingSubscriptionId: "billing-authorization-subscription",
              plan: "free",
              planPolicyVersion: "launch-v1",
              userId: facts.userId,
            }),
          );

          const stored = yield* inspectBillingAuthorization(fixture.database, facts.userId);

          expect(stored).toEqual({
            deletionAccess: { _tag: "DeletionAccessRevoked" },
            plan: facts.plan,
            planPolicyVersion: facts.planPolicyVersion,
            user: { _tag: "SuspendedUser", userId: facts.userId },
          });

          yield* Effect.promise(() =>
            fixture.database
              .update(users)
              .set({ deletionAccessRevokedAt: null, suspendedAt: null })
              .where(eq(users.id, facts.userId)),
          );
          const restored = yield* inspectBillingAuthorization(fixture.database, facts.userId);
          expect(restored).toEqual({
            deletionAccess: { _tag: "DeletionAccessAvailable" },
            plan: facts.plan,
            planPolicyVersion: facts.planPolicyVersion,
            user: { _tag: "ActiveUser", userId: facts.userId },
          });
        }),
      closeTestDatabase,
    ),
  );
});

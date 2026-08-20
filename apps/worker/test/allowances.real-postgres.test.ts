import { describe, expect, it } from "@effect/vitest";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { DateTime, Effect, Schema } from "effect";

import { BillingDb } from "../src/db/billing";
import { AllowancePeriodId, BillingSubscriptionId, UserId } from "../src/domain";
import { retainedCatalog } from "../src/domain/plan-policy";
import { Allowances } from "../src/services/allowances";
import { Authorization, AuthorizationContext } from "../src/services/authorization";
import { RealPostgresTestUnavailable, withRealPostgresFixture } from "./real-postgres-fixture";

describe("Allowances with real PostgreSQL", () => {
  it.effect("bounds concurrent soft-cap overshoot and retains every completed usage fact", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const now = date("2026-08-16T00:00:00.000Z");
        const startsAt = date("2026-08-01T00:00:00.000Z");
        const endsAt = date("2026-09-01T00:00:00.000Z");
        const userId = UserId.make("user-real-concurrency");
        const billingSubscriptionId = BillingSubscriptionId.make(
          "billing-subscription-real-concurrency",
        );
        const allowancePeriodId = AllowancePeriodId.make("allowance-period-real-concurrency");
        yield* Effect.tryPromise({
          // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise seed boundary.
          try: async () => {
            await database.insert(users).values({
              email: "real-concurrency@example.test",
              id: userId,
              name: "Real Concurrency",
            });
            await database.insert(billingSubscriptions).values({
              billing_subscription_id: billingSubscriptionId,
              created_at: startsAt,
              plan: "free",
              plan_policy_version: "launch-v1",
              updated_at: startsAt,
              user_id: userId,
            });
            await database.insert(allowancePeriods).values({
              allowance_period_id: allowancePeriodId,
              billing_subscription_id: billingSubscriptionId,
              created_at: startsAt,
              ends_at: endsAt,
              plan: "free",
              plan_policy_version: "launch-v1",
              starts_at: startsAt,
              user_id: userId,
            });
          },
          catch: () =>
            new RealPostgresTestUnavailable({
              message: "Could not seed the real PostgreSQL concurrency test",
            }),
        });
        const billing = BillingDb.make(database);
        const allowances = Allowances.make({
          billing,
          catalog: retainedCatalog,
          now: Effect.succeed(now),
        });
        const authorization = Authorization.make(retainedCatalog);
        yield* allowances.record(
          allowancePeriodId,
          { sourceId: "accepted-batch", sourceType: "acceptanceReceipt" },
          [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 29n }],
        );
        const before = yield* billing.admit(userId, now);
        const context = authorizationContext(before, now);
        const operation = { actionId: "accept-concurrently", kind: "conversation.accept" };

        expect(authorization.admit(context, operation)).toMatchObject({ _tag: "Admitted" });
        expect(authorization.admit(context, operation)).toMatchObject({ _tag: "Admitted" });
        const completed = yield* Effect.all(
          [
            allowances.record(
              allowancePeriodId,
              { sourceId: "acceptance-30", sourceType: "acceptanceReceipt" },
              [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
            ),
            allowances.record(
              allowancePeriodId,
              { sourceId: "acceptance-31", sourceType: "acceptanceReceipt" },
              [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
            ),
          ],
          { concurrency: "unbounded" },
        );
        const after = yield* billing.admit(userId, now);
        const rows = yield* Effect.tryPromise({
          try: () => database.select().from(allowanceUsage),
          catch: () =>
            new RealPostgresTestUnavailable({
              message: "Could not inspect completed real PostgreSQL usage facts",
            }),
        });

        expect(completed).toEqual([{ _tag: "Recorded" }, { _tag: "Recorded" }]);
        expect(rows).toHaveLength(3);
        expect(after.usage).toContainEqual({ allowanceKind: "acceptedMessages", quantity: 31n });
        expect(authorization.admit(authorizationContext(after, now), operation)).toMatchObject({
          _tag: "Denied",
          reason: "allowanceExhausted",
        });
      }),
    ),
  );
});

const authorizationContext = (
  admission: Effect.Success<ReturnType<BillingDb.Interface["admit"]>>,
  now: Date,
) =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: admission.allowancePeriodId,
      endsAt: admission.endsAt,
      plan: admission.plan,
      planPolicyVersion: admission.planPolicyVersion,
      startsAt: admission.startsAt,
      usage: admission.usage,
    },
    approval: null,
    authority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-real-postgres",
      expiresAt: date("2026-08-20T00:00:00.000Z"),
      userId: admission.userId,
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-real-postgres",
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: admission.userId,
    subscription: {
      plan: admission.plan,
      planPolicyVersion: admission.planPolicyVersion,
    },
    user: { _tag: "ActiveUser", userId: admission.userId },
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

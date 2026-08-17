import { describe, expect, it } from "@effect/vitest";
import type { Database } from "@osfo/db";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Cause, Data, DateTime, Effect, Exit, Schema } from "effect";

import * as Billing from "../src/db/billing";
import { AllowancePeriodId, BillingSubscriptionId, UserId } from "../src/domain";
import { retainedCatalog } from "../src/domain/plan-policy";
import * as Allowances from "../src/services/allowances";
import { AuthorizationContext, make as makeAuthorization } from "../src/services/authorization";

describe("Allowances", () => {
  it.effect("records first trusted use and exposes only visible Plan allowance facts", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const seeded = yield* seedPeriod(fixture.database, "first-record", "adventurer");
          const allowances = Allowances.make({
            billing: Billing.make(fixture.database),
            catalog: retainedCatalog,
            now: Effect.succeed(seeded.now),
          });

          const result = yield* allowances.record(
            seeded.allowancePeriodId,
            { sourceId: "gmail-search-001", sourceType: "gmailSearch" },
            [{ allowanceKind: "gmailSearches", basis: "observed", quantity: 4n }],
          );
          const inspection = yield* allowances.inspect(seeded.userId);

          expect(result).toEqual({ _tag: "Recorded" });
          expect(inspection).toMatchObject({
            allowancePeriodId: seeded.allowancePeriodId,
            plan: "adventurer",
            resetsAt: seeded.endsAt,
          });
          expect(inspection.usage.find((usage) => usage.allowanceKind === "gmailSearches")).toEqual(
            {
              allowanceKind: "gmailSearches",
              limit: 50n,
              recorded: 4n,
              remaining: 46n,
            },
          );
          expect(inspection.usage.some((usage) => usage.allowanceKind === "vendorUsdMicros")).toBe(
            false,
          );
        }),
      closeTestDatabase,
    ),
  );

  it.effect("returns ExistingUsage for the same fact and UsageConflict for changed facts", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const seeded = yield* seedPeriod(fixture.database, "idempotency", "free");
          const allowances = Allowances.make({
            billing: Billing.make(fixture.database),
            catalog: retainedCatalog,
            now: Effect.succeed(seeded.now),
          });
          const source = { sourceId: "acceptance-001", sourceType: "acceptanceReceipt" };
          const item = {
            allowanceKind: "acceptedMessages" as const,
            basis: "known_at_start" as const,
            quantity: 1n,
          };

          const first = yield* allowances.record(seeded.allowancePeriodId, source, [item]);
          const repeated = yield* allowances.record(seeded.allowancePeriodId, source, [item]);
          const conflict = yield* allowances
            .record(seeded.allowancePeriodId, source, [{ ...item, quantity: 2n }])
            .pipe(Effect.flip);

          expect(first).toEqual({ _tag: "Recorded" });
          expect(repeated).toEqual({ _tag: "ExistingUsage" });
          expect(conflict).toMatchObject({
            _tag: "UsageConflict",
            allowanceKind: "acceptedMessages",
            allowancePeriodId: seeded.allowancePeriodId,
          });
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rolls back a mixed batch when one existing fact conflicts", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const seeded = yield* seedPeriod(fixture.database, "mixed-conflict", "free");
          const allowances = Allowances.make({
            billing: Billing.make(fixture.database),
            catalog: retainedCatalog,
            now: Effect.succeed(seeded.now),
          });
          const source = { sourceId: "mixed-source", sourceType: "modelCallAttempt" };
          yield* allowances.record(seeded.allowancePeriodId, source, [
            { allowanceKind: "acceptedMessages", basis: "observed", quantity: 1n },
          ]);

          const conflict = yield* allowances
            .record(seeded.allowancePeriodId, source, [
              { allowanceKind: "acceptedMessages", basis: "observed", quantity: 2n },
              { allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 10n },
            ])
            .pipe(Effect.flip);
          const stored = yield* Effect.promise(() =>
            fixture.database.select().from(allowanceUsage),
          );

          expect(conflict).toMatchObject({
            _tag: "UsageConflict",
            allowanceKind: "acceptedMessages",
          });
          expect(stored).toHaveLength(1);
          expect(stored[0]?.allowanceKind).toBe("acceptedMessages");
        }),
      closeTestDatabase,
    ),
  );

  it.effect("records bounded overshoot as truth and denies later ordinary work", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const seeded = yield* seedPeriod(fixture.database, "soft-cap", "free");
          const billing = Billing.make(fixture.database);
          const allowances = Allowances.make({
            billing,
            catalog: retainedCatalog,
            now: Effect.succeed(seeded.now),
          });
          const authorization = makeAuthorization(retainedCatalog);
          yield* allowances.record(
            seeded.allowancePeriodId,
            { sourceId: "accepted-batch", sourceType: "acceptanceReceipt" },
            [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 29n }],
          );
          const before = yield* billing.admit(seeded.userId, seeded.now);
          const operation = { actionId: "accept-next", kind: "conversation.accept" };
          const firstAdmission = authorization.admit(authorizationContext(before), operation);
          const concurrentAdmission = authorization.admit(authorizationContext(before), operation);

          yield* allowances.record(
            seeded.allowancePeriodId,
            { sourceId: "acceptance-30", sourceType: "acceptanceReceipt" },
            [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
          );
          yield* allowances.record(
            seeded.allowancePeriodId,
            { sourceId: "acceptance-31", sourceType: "acceptanceReceipt" },
            [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
          );
          const after = yield* billing.admit(seeded.userId, seeded.now);
          const later = authorization.admit(authorizationContext(after), operation);

          expect(firstAdmission).toMatchObject({
            _tag: "Admitted",
            allowancePeriod: {
              _tag: "Metered",
              allowancePeriodId: seeded.allowancePeriodId,
            },
          });
          expect(concurrentAdmission).toMatchObject({ _tag: "Admitted" });
          expect(after.usage).toContainEqual({ allowanceKind: "acceptedMessages", quantity: 31n });
          expect(later).toMatchObject({ _tag: "Denied", reason: "allowanceExhausted" });
        }),
      closeTestDatabase,
    ),
  );

  it.effect(
    "records observed and conservative cost but records nothing for proven no-use evidence",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const seeded = yield* seedPeriod(fixture.database, "evidence-basis", "free");
            const billing = Billing.make(fixture.database);
            const allowances = Allowances.make({
              billing,
              catalog: retainedCatalog,
              now: Effect.succeed(seeded.now),
            });

            const observed = yield* allowances.record(
              seeded.allowancePeriodId,
              { sourceId: "model-call-001", sourceType: "modelCallAttempt" },
              [{ allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 12_000n }],
            );
            const conservative = yield* allowances.record(
              seeded.allowancePeriodId,
              { sourceId: "model-call-002", sourceType: "modelCallAttempt" },
              [{ allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 30_000n }],
            );
            const noUse = yield* allowances.record(
              seeded.allowancePeriodId,
              { sourceId: "model-call-no-use", sourceType: "modelCallAttempt" },
              [],
            );
            const admission = yield* billing.admit(seeded.userId, seeded.now);

            expect(observed).toEqual({ _tag: "Recorded" });
            expect(conservative).toEqual({ _tag: "Recorded" });
            expect(noUse).toEqual({ _tag: "ExistingUsage" });
            expect(admission.usage).toContainEqual({
              allowanceKind: "vendorUsdMicros",
              quantity: 42_000n,
            });
          }),
        closeTestDatabase,
      ),
  );

  it.effect("attributes late consumption to the original admitted period", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const seeded = yield* seedPeriod(fixture.database, "original-period", "free");
          const laterPeriodId = AllowancePeriodId.make("allowance-period-later");
          yield* Effect.promise(() =>
            fixture.database.insert(allowancePeriods).values({
              allowancePeriodId: laterPeriodId,
              billingSubscriptionId: seeded.billingSubscriptionId,
              createdAt: seeded.endsAt,
              endsAt: date("2026-10-01T00:00:00.000Z"),
              plan: "free",
              planPolicyVersion: "launch-v1",
              startsAt: seeded.endsAt,
              userId: seeded.userId,
            }),
          );
          const billing = Billing.make(fixture.database);
          const recorder = Allowances.make({
            billing,
            catalog: retainedCatalog,
            now: Effect.succeed(date("2026-09-05T00:00:00.000Z")),
          });
          yield* recorder.record(
            seeded.allowancePeriodId,
            { sourceId: "late-provider-evidence", sourceType: "modelCallAttempt" },
            [{ allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 5_000n }],
          );
          const original = yield* billing.admit(seeded.userId, seeded.now);
          const later = yield* billing.admit(seeded.userId, date("2026-09-05T00:00:00.000Z"));

          expect(original.allowancePeriodId).toBe(seeded.allowancePeriodId);
          expect(original.usage).toContainEqual({
            allowanceKind: "vendorUsdMicros",
            quantity: 5_000n,
          });
          expect(later).toMatchObject({ allowancePeriodId: laterPeriodId, usage: [] });
        }),
      closeTestDatabase,
    ),
  );

  it.effect("returns BillingTransactionRetryExhausted after bounded serialization retries", () =>
    Effect.gen(function* () {
      const attempts = { count: 0 };
      const failingDatabase = {
        // oxlint-disable-next-line effecttsgo/async-function -- boundary: this fake reproduces a rejecting Postgres.js transaction Promise.
        transaction: async () => {
          attempts.count += 1;
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Postgres.js reports serialization failures by rejecting its transaction Promise.
          throw new SerializationFailure();
        },
      } satisfies Billing.BillingDatabase;
      const billing = Billing.make(failingDatabase);

      const result = yield* billing
        .recordUsage(
          AllowancePeriodId.make("allowance-period-retry"),
          { sourceId: "retry-source", sourceType: "acceptanceReceipt" },
          [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.findError(result.cause)).toMatchObject({
          _tag: "Success",
          success: {
            _tag: "BillingTransactionRetryExhausted",
            attempts: 3,
            operation: "recordUsage",
          },
        });
      }
      expect(attempts.count).toBe(3);
    }),
  );
});

type SeedPlan = "adventurer" | "free";

const seedPeriod = (database: Database, suffix: string, plan: SeedPlan) =>
  Effect.gen(function* () {
    const now = date("2026-08-16T00:00:00.000Z");
    const startsAt = date("2026-08-01T00:00:00.000Z");
    const endsAt = date("2026-09-01T00:00:00.000Z");
    const userId = UserId.make(`user-${suffix}`);
    const billingSubscriptionId = BillingSubscriptionId.make(`billing-subscription-${suffix}`);
    const allowancePeriodId = AllowancePeriodId.make(`allowance-period-${suffix}`);
    yield* Effect.promise(() =>
      database.insert(users).values({
        email: `${suffix}@example.test`,
        id: userId,
        name: `User ${suffix}`,
      }),
    );
    const subscriptionValues = {
      billingSubscriptionId,
      createdAt: startsAt,
      plan,
      planPolicyVersion: "launch-v1",
      updatedAt: startsAt,
      userId,
    };
    const paidSubscriptionValues = {
      ...subscriptionValues,
      stripeCurrentPeriodEnd: endsAt,
      stripeCurrentPeriodStart: startsAt,
      stripeLatestInvoiceId: "in_allowance",
      stripePriceId: "price_adventurer",
      stripeProductId: "prod_adventurer",
      stripeStatus: "active",
      stripeSubscriptionId: "sub_allowance",
    };
    yield* Effect.promise(() =>
      database
        .insert(billingSubscriptions)
        .values(plan === "adventurer" ? paidSubscriptionValues : subscriptionValues),
    );
    const periodValues = {
      allowancePeriodId,
      billingSubscriptionId,
      createdAt: startsAt,
      endsAt,
      plan,
      planPolicyVersion: "launch-v1",
      startsAt,
      userId,
    };
    yield* Effect.promise(() =>
      database
        .insert(allowancePeriods)
        .values(
          plan === "adventurer"
            ? { ...periodValues, stripeInvoiceId: "in_allowance" }
            : periodValues,
        ),
    );

    return { allowancePeriodId, billingSubscriptionId, endsAt, now, userId };
  });

const authorizationContext = (admission: Effect.Success<ReturnType<Billing.Interface["admit"]>>) =>
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
      authSessionId: "auth-session-allowance-test",
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
    now: date("2026-08-16T00:00:00.000Z"),
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-allowance-test",
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

class SerializationFailure extends Data.TaggedError("SerializationFailure") {
  readonly code = "40001";
}

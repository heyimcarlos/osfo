import { env } from "cloudflare:workers";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "../../src/db";
import { BillingDb } from "../../src/db/billing";
import {
  CapabilityCatalogVersion,
  AllowancePeriodId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  UserId,
} from "../../src/domain";
import type { UsageEvent } from "../../src/domain/usage-event";
import { spawnApp } from "../support/spawn-app";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, effecttsgo/global-date, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle -- This PostgreSQL contract owns its Promise transaction helper, concrete database Layer, fixed evidence times, and tagged outcomes. */

it.effect("records final Usage Events idempotently without charging failed or cancelled work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const userId = yield* registerUser(app, "+15550002520", "Usage Events");
      const database = yield* Db.database;
      const period = yield* activateSharedUsage(database, userId, "free");
      const billing = BillingDb.make(database);
      const completed = usageEvent(period.allowancePeriodId, "event-1", "root-1", 700n, {
        references: [
          { kind: "gatewayLog", reference: "gateway-log-1" },
          { kind: "companyCost", reference: "company-cost-1" },
        ],
      });

      const first = yield* billing.recordUsageEvent(completed);
      expect(first).toMatchObject({
        outcome: { _tag: "Recorded" },
        recordedPlanUsageMicros: 700n,
      });
      const retry = yield* billing.recordUsageEvent(completed);
      expect(retry).toMatchObject({
        outcome: { _tag: "ExistingUsage" },
        recordedPlanUsageMicros: 700n,
      });

      const conflict = yield* billing
        .recordUsageEvent(usageEvent(period.allowancePeriodId, "event-1", "root-1", 701n))
        .pipe(Effect.flip);
      expect(conflict._tag).toBe("UsageEventConflict");

      const partial = usageEvent(period.allowancePeriodId, "event-2", "root-1", 300n, {
        outcome: "UsefulPartial",
      });
      expect(yield* billing.recordUsageEvent(partial)).toMatchObject({
        recordedPlanUsageMicros: 1_000n,
      });
      const failed = unchargedEvent(period.allowancePeriodId, "event-3", "root-1", "Failed");
      const cancelled = unchargedEvent(period.allowancePeriodId, "event-4", "root-1", "Cancelled");
      expect(yield* billing.recordUsageEvent(failed)).toMatchObject({
        recordedPlanUsageMicros: 1_000n,
      });
      expect(yield* billing.recordUsageEvent(cancelled)).toMatchObject({
        recordedPlanUsageMicros: 1_000n,
      });
      expect(yield* billing.recordUsageEvent(failed)).toMatchObject({
        outcome: { _tag: "ExistingUsage" },
      });

      const admission = yield* billing.admit(userId, new Date(period.startsAt.getTime() + 1_000));
      expect(admission.usage).toContainEqual({
        allowanceKind: "planUsageMicros",
        quantity: 1_000n,
      });
    }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
  ),
);

it.effect("admits three concurrent Adventurer operations and retains every completed event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const userId = yield* registerUser(app, "+15550002521", "Usage Concurrency");
      const database = yield* Db.database;
      const period = yield* activateSharedUsage(database, userId, "adventurer");
      const billing = BillingDb.make(database);
      const initial = usageEvent(
        period.allowancePeriodId,
        "initial-event",
        "initial-root",
        5_999_999n,
      );
      yield* billing.recordUsageEvent(initial);

      const admissions = yield* Effect.all(
        [1, 2, 3].map(() => billing.admit(userId, new Date(period.startsAt.getTime() + 1_000))),
        { concurrency: "unbounded" },
      );
      expect(admissions).toHaveLength(3);
      for (const admission of admissions) {
        expect(admission.usage).toContainEqual({
          allowanceKind: "planUsageMicros",
          quantity: 5_999_999n,
        });
      }

      const concurrentlyAdmitted = [1, 2, 3].map((index) =>
        usageEvent(
          period.allowancePeriodId,
          `concurrent-event-${index}`,
          `concurrent-root-${index}`,
          100_000n,
        ),
      );
      const recorded = yield* Effect.all(concurrentlyAdmitted.map(billing.recordUsageEvent), {
        concurrency: "unbounded",
      });
      expect(
        new Set(recorded.map(({ recordedPlanUsageMicros }) => recordedPlanUsageMicros)),
      ).toEqual(new Set([6_099_999n, 6_199_999n, 6_299_999n]));

      const retained = yield* Effect.forEach(concurrentlyAdmitted, billing.recordUsageEvent, {
        concurrency: 3,
      });
      expect(retained).toEqual(
        concurrentlyAdmitted.map(() => ({
          outcome: { _tag: "ExistingUsage" },
          recordedPlanUsageMicros: 6_299_999n,
        })),
      );
    }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
  ),
);

const registerUser = (
  app: Awaited<ReturnType<typeof spawnApp>>,
  phoneNumber: string,
  preferredName: string,
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => app.auth.sendPhoneOtp(phoneNumber));
    yield* Effect.promise(() => app.auth.verifyPhoneOtp(phoneNumber, "424242"));
    const completed = yield* Effect.promise(() =>
      app.registration.complete({ helpAreas: [], locale: "en", preferredName }),
    );
    if (completed.body === undefined) {
      return yield* Effect.die(new Error("Registration did not return an identity"));
    }
    return UserId.make(completed.body.userId);
  });

const activateSharedUsage = (database: Db.Database, userId: UserId, plan: "free" | "adventurer") =>
  Effect.promise(async () => {
    const adventurerEvidence =
      plan === "adventurer"
        ? {
            stripe_current_period_end: new Date("2026-09-24T00:00:00.000Z"),
            stripe_current_period_start: new Date("2026-08-24T00:00:00.000Z"),
            stripe_latest_invoice_id: "in_plan_usage_test",
            stripe_price_id: "price_adventurer",
            stripe_product_id: "prod_adventurer",
            stripe_status: "active",
            stripe_subscription_id: `sub_plan_usage:${userId}`,
          }
        : {};
    await database
      .update(billingSubscriptions)
      .set({ ...adventurerEvidence, plan, plan_policy_version: "shared-usage-v1" })
      .where(eq(billingSubscriptions.user_id, userId));
    const [period] = await database
      .update(allowancePeriods)
      .set({ plan, plan_policy_version: "shared-usage-v1" })
      .where(eq(allowancePeriods.user_id, userId))
      .returning({
        allowancePeriodId: allowancePeriods.allowance_period_id,
        startsAt: allowancePeriods.starts_at,
      });
    if (period === undefined) throw new Error("Registration did not create a Usage period");
    return {
      allowancePeriodId: AllowancePeriodId.make(period.allowancePeriodId),
      startsAt: period.startsAt,
    };
  });

const usageEvent = (
  allowancePeriodId: UsageEvent["allowancePeriodId"],
  sourceId: string,
  rootOperationId: string,
  chargeMicros: bigint,
  options: {
    readonly outcome?: "Completed" | "UsefulPartial";
    readonly references?: UsageEvent["evidenceReferences"];
  } = {},
): UsageEvent => ({
  allowancePeriodId,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  evidenceReferences: options.references ?? [],
  manifestVersion: null,
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("managed-routing-v1"),
  occurredAt: new Date("2026-08-24T00:00:00.000Z"),
  outcome: {
    _tag: options.outcome ?? "Completed",
    charge: {
      components: [
        {
          activity: "automations",
          ratedCostUsdMicros: chargeMicros,
          resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
        },
      ],
      planUsageMicros: chargeMicros,
      ratedCostUsdMicros: chargeMicros,
      usagePolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
    },
  },
  rootOperationId,
  source: { sourceId, sourceType: "testOperation" },
  usagePolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
});

const unchargedEvent = (
  allowancePeriodId: UsageEvent["allowancePeriodId"],
  sourceId: string,
  rootOperationId: string,
  outcome: "Cancelled" | "Failed",
): UsageEvent => ({
  allowancePeriodId,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  evidenceReferences: [{ kind: "companyCost", reference: `company-cost:${sourceId}` }],
  manifestVersion: null,
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("managed-routing-v1"),
  occurredAt: new Date("2026-08-24T00:00:00.000Z"),
  outcome: { _tag: outcome },
  rootOperationId,
  source: { sourceId, sourceType: "testOperation" },
  usagePolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
});

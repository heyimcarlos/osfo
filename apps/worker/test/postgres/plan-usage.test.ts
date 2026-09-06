import { env } from "cloudflare:workers";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { expect, it } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import { Effect, Result } from "effect";

import { Db } from "../../src/db";
import { BillingDb } from "../../src/db/billing";
import {
  CapabilityCatalogVersion,
  AllowancePeriodId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  UserId,
  ThinkRequestId,
} from "../../src/domain";
import { UsageEvent } from "../../src/domain/usage-event";
import { settleConversationUsage } from "../../src/agents/osfo/conversation-usage";
import { CommittedTurnTerminal } from "../../src/agents/osfo/committed-turn-terminal";
import { managedConversationModelPrice, rate } from "../../src/domain/usage";
import { retainedCatalog } from "../../src/domain/plan-policy";
import { managedSearchPrice } from "../../src/domain/web-search-price";
import { spawnApp } from "../support/spawn-app";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, effecttsgo/global-date, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle -- This PostgreSQL contract owns its Promise transaction helper, concrete database Layer, fixed evidence times, and tagged outcomes. */

it.effect(
  "replays one completed conversation charge into its original period after a lost ledger acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const userId = yield* registerUser(app, "+15550002524", "Conversation Settlement");
        const database = yield* Db.database;
        const period = yield* activateSharedUsage(database, userId, "free");
        const billing = BillingDb.make(database);
        const rating = rate(
          [
            {
              activity: "conversationsAndMemory",
              cachedInputTokens: 100n,
              inputTokens: 1000n,
              outputTokens: 100n,
              price: managedConversationModelPrice,
            },
          ],
          [
            {
              activity: "webAndResearch",
              ratedCostUsdMicros: 13_562n,
              resourcePriceVersion: ResourcePriceVersion.make(
                managedSearchPrice.resourcePriceVersion,
              ),
            },
          ],
          retainedCatalog,
          PlanPolicyVersion.make("shared-usage-v1"),
        );
        if (Result.isFailure(rating))
          return yield* Effect.die(new Error("Recognized conversation evidence must rate"));
        const event = UsageEvent.make({
          ...usageEvent(
            period.allowancePeriodId,
            "conversation-submission",
            "conversation-submission",
            rating.success.planUsageMicros,
          ),
          outcome: { _tag: "Completed", charge: rating.success },
          source: { sourceId: "conversation-submission", sourceType: "conversation" },
        });
        let terminal = CommittedTurnTerminal.make({
          requestId: ThinkRequestId.make("conversation-request"),
          status: "completed",
          usageOccurredAt: event.occurredAt.toISOString(),
        });
        let dispatches = 0;
        const port = {
          read: Effect.sync(() => terminal),
          prepare: () => Effect.succeed(event),
          retain: (next: CommittedTurnTerminal) =>
            Effect.sync(() => {
              terminal = next;
            }),
          dispatch: (retained: UsageEvent) =>
            billing.recordUsageEvent(retained).pipe(
              Effect.flatMap(() => {
                dispatches++;
                return dispatches === 1 ? Effect.fail("lost acknowledgement") : Effect.void;
              }),
            ),
        };
        yield* settleConversationUsage(port).pipe(Effect.flip);
        const nextStartsAt = yield* Effect.promise(async () => {
          const [original] = await database
            .select()
            .from(allowancePeriods)
            .where(eq(allowancePeriods.allowance_period_id, period.allowancePeriodId));
          if (original === undefined) throw new Error("Original period is missing");
          await database.insert(allowancePeriods).values({
            ...original,
            allowance_period_id: "conversation-next-period",
            starts_at: original.ends_at,
            ends_at: new Date(original.ends_at.getTime() + 30 * 24 * 60 * 60 * 1000),
          });
          return original.ends_at;
        });
        const next = yield* billing.admit(userId, new Date(nextStartsAt.getTime() + 1_000));
        expect(next.allowancePeriodId).not.toBe(period.allowancePeriodId);
        yield* settleConversationUsage({
          ...port,
          prepare: () => Effect.die(new Error("Original frozen event must replay after rollover")),
        });
        yield* settleConversationUsage(port);
        const rows = yield* Effect.promise(() =>
          database
            .select({
              period: allowanceUsage.allowance_period_id,
              quantity: allowanceUsage.quantity,
            })
            .from(allowanceUsage)
            .where(
              and(
                eq(allowanceUsage.source_type, "conversation"),
                eq(allowanceUsage.source_id, "conversation-submission"),
              ),
            ),
        );
        expect(rows).toEqual([
          { period: period.allowancePeriodId, quantity: rating.success.planUsageMicros },
        ]);
        expect(dispatches).toBe(2);
        return undefined;
      }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
    ),
);

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

      const invalidCharge = UsageEvent.make(
        {
          ...usageEvent(period.allowancePeriodId, "invalid-event", "invalid-root", 700n),
          outcome: {
            _tag: "Completed",
            charge: {
              components: [
                {
                  activity: "automations",
                  ratedCostUsdMicros: 699n,
                  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
                },
              ],
              planUsageMicros: 700n,
              ratedCostUsdMicros: 700n,
              usagePolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
            },
          },
        },
        { disableChecks: true },
      );
      const invalidResult = yield* billing.recordUsageEvent(invalidCharge).pipe(Effect.flip);
      expect(invalidResult._tag).toBe("UsageEventInvalid");

      const admission = yield* billing.admit(userId, new Date(period.startsAt.getTime() + 1_000));
      expect(admission.usage).toContainEqual({
        allowanceKind: "planUsageMicros",
        quantity: 1_000n,
      });
    }).pipe(Effect.provide(Db.layer({ db: env.DB }))),
  ),
);

it.effect("refuses allowance usage when durable evidence names another User's period", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const evidenceUserId = yield* registerUser(app, "+15550002522", "Evidence Owner");
      const periodUserId = yield* registerUser(app, "+15550002523", "Period Owner");
      const database = yield* Db.database;
      const period = yield* activateSharedUsage(database, periodUserId, "free");
      const billing = BillingDb.make(database);

      const failure = yield* billing
        .recordUsageForUser(
          evidenceUserId,
          period.allowancePeriodId,
          { sourceId: "artifact:foreign-period", sourceType: "artifactProviderOperation" },
          [{ allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 50_000n }],
        )
        .pipe(Effect.flip);
      expect(failure._tag).toBe("AllowancePeriodNotFound");

      const rows = yield* Effect.promise(() =>
        database
          .select({ sourceId: allowanceUsage.source_id })
          .from(allowanceUsage)
          .where(
            and(
              eq(allowanceUsage.source_type, "artifactProviderOperation"),
              eq(allowanceUsage.source_id, "artifact:foreign-period"),
            ),
          ),
      );
      expect(rows).toEqual([]);
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
    const identity = yield* Effect.promise(() =>
      app.auth.mintVerifiedUser({
        phoneNumber,
        profile: { helpAreas: [], locale: "en", preferredName },
      }),
    );
    return UserId.make(identity.userId);
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

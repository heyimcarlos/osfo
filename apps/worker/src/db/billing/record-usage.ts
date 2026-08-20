import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect, Predicate, Schema } from "effect";

import { type AllowancePeriodId, Plan, PlanPolicyVersion, UserId } from "../../domain";
import {
  type AllowanceItem,
  AllowanceKind,
  type AllowanceSource,
  AllowancePeriodNotFound,
  ConsumptionBasis,
  ExistingUsage,
  Recorded,
  UsageConflict,
} from "../../domain/allowance";
import type { BillingDatabase } from "./database";
import type { BillingTransactionRetryExhausted } from "./errors";
import { DatabaseUnavailable } from "./errors";
import { runBillingTransaction } from "./transaction";

const StoredUsage = Schema.Struct({
  allowanceKind: AllowanceKind,
  basis: ConsumptionBasis,
  quantity: Schema.BigInt,
});

const RecordedPeriod = Schema.Struct({
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  userId: UserId,
});

const AggregateUsage = Schema.Struct({
  allowanceKind: AllowanceKind,
  quantity: Schema.BigInt,
});

/** Internal persisted facts returned to the Allowances application service. */
export const RecordUsageResult = Schema.Struct({
  outcome: Schema.Union([ExistingUsage, Recorded]),
  period: Schema.NullOr(RecordedPeriod),
  usage: Schema.Array(AggregateUsage),
});

/** Internal persisted facts returned to the Allowances application service. */
export type RecordUsageResult = typeof RecordUsageResult.Type;

/** Expected failures from one record-usage transaction. */
export type RecordUsageError =
  | AllowancePeriodNotFound
  | BillingTransactionRetryExhausted
  | DatabaseUnavailable
  | UsageConflict;

/** Record normalized consumption in one atomic PostgreSQL retry boundary. */
export const recordUsage = (
  database: BillingDatabase,
  allowancePeriodId: AllowancePeriodId,
  source: AllowanceSource,
  items: ReadonlyArray<AllowanceItem>,
) => {
  if (items.length === 0) {
    return Effect.succeed({ outcome: ExistingUsage.make({}), period: null, usage: [] });
  }
  const uniqueItems = [...new Map(items.map((item) => [item.allowanceKind, item])).values()];
  const duplicateConflict = items.find((item) => {
    const canonical = uniqueItems.find(
      (candidate) => candidate.allowanceKind === item.allowanceKind,
    );
    return canonical?.quantity !== item.quantity || canonical.basis !== item.basis;
  });
  if (duplicateConflict !== undefined) {
    return Effect.fail(
      new UsageConflict({
        allowanceKind: duplicateConflict.allowanceKind,
        allowancePeriodId,
        message: "The allowance idempotency key was supplied with changed facts",
        sourceId: source.sourceId,
        sourceType: source.sourceType,
      }),
    );
  }

  return Effect.gen(function* () {
    const result = yield* runBillingTransaction("recordUsage", () =>
      // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
      database.transaction(async (transaction) => {
        const [period] = await transaction
          .select({
            plan: allowancePeriods.plan,
            planPolicyVersion: allowancePeriods.plan_policy_version,
            userId: allowancePeriods.user_id,
          })
          .from(allowancePeriods)
          .where(eq(allowancePeriods.allowance_period_id, allowancePeriodId))
          .for("update")
          .limit(1);
        if (period === undefined) return { _tag: "PeriodNotFound" } as const;

        const kinds = uniqueItems.map((item) => item.allowanceKind);
        const existing = await transaction
          .select({
            allowanceKind: allowanceUsage.allowance_kind,
            basis: allowanceUsage.basis,
            quantity: allowanceUsage.quantity,
          })
          .from(allowanceUsage)
          .where(
            and(
              eq(allowanceUsage.allowance_period_id, allowancePeriodId),
              eq(allowanceUsage.source_type, source.sourceType),
              eq(allowanceUsage.source_id, source.sourceId),
              inArray(allowanceUsage.allowance_kind, kinds),
            ),
          );
        const existingByKind = new Map(existing.map((row) => [row.allowanceKind, row]));
        const conflict = uniqueItems.find((item) => {
          const stored = existingByKind.get(item.allowanceKind);
          return (
            stored !== undefined &&
            (stored.quantity !== item.quantity || stored.basis !== item.basis)
          );
        });
        if (conflict !== undefined) {
          return { _tag: "Conflict" as const, allowanceKind: conflict.allowanceKind };
        }
        const missing = uniqueItems.filter((item) => !existingByKind.has(item.allowanceKind));
        const inserted =
          missing.length === 0
            ? []
            : await transaction
                .insert(allowanceUsage)
                .values(
                  missing.map((item) => ({
                    allowance_kind: item.allowanceKind,
                    allowance_period_id: allowancePeriodId,
                    basis: item.basis,
                    quantity: item.quantity,
                    source_id: source.sourceId,
                    source_type: source.sourceType,
                    user_id: UserId.make(period.userId),
                  })),
                )
                .onConflictDoNothing()
                .returning({ allowanceKind: allowanceUsage.allowance_kind });
        const stored = await transaction
          .select({
            allowanceKind: allowanceUsage.allowance_kind,
            basis: allowanceUsage.basis,
            quantity: allowanceUsage.quantity,
          })
          .from(allowanceUsage)
          .where(
            and(
              eq(allowanceUsage.allowance_period_id, allowancePeriodId),
              eq(allowanceUsage.source_type, source.sourceType),
              eq(allowanceUsage.source_id, source.sourceId),
              inArray(allowanceUsage.allowance_kind, kinds),
            ),
          );
        const aggregate = await transaction
          .select({
            allowanceKind: allowanceUsage.allowance_kind,
            quantity: sql<bigint>`sum(${allowanceUsage.quantity})`.mapWith(allowanceUsage.quantity),
          })
          .from(allowanceUsage)
          .where(
            and(
              eq(allowanceUsage.allowance_period_id, allowancePeriodId),
              inArray(allowanceUsage.allowance_kind, kinds),
            ),
          )
          .groupBy(allowanceUsage.allowance_kind);
        return { _tag: "Stored" as const, aggregate, inserted, period, stored };
      }),
    );
    if (Predicate.isTagged(result, "PeriodNotFound")) {
      return yield* new AllowancePeriodNotFound({
        lookup: { _tag: "AllowancePeriod", allowancePeriodId },
        message: "The admitted allowance period does not exist",
      });
    }
    if (Predicate.isTagged(result, "Conflict")) {
      return yield* new UsageConflict({
        allowanceKind: result.allowanceKind,
        allowancePeriodId,
        message: "The allowance idempotency key was retried with changed facts",
        sourceId: source.sourceId,
        sourceType: source.sourceType,
      });
    }
    const stored = yield* Schema.decodeUnknownEffect(Schema.Array(StoredUsage))(result.stored).pipe(
      Effect.mapError(
        (cause) =>
          new DatabaseUnavailable({
            cause,
            message: "PostgreSQL returned invalid Allowance Consumption",
            operation: "recordUsage",
          }),
      ),
    );
    yield* Effect.forEach(uniqueItems, (item) =>
      stored.some(
        (record) =>
          record.allowanceKind === item.allowanceKind &&
          record.quantity === item.quantity &&
          record.basis === item.basis,
      )
        ? Effect.void
        : Effect.fail(
            new DatabaseUnavailable({
              cause: stored,
              message: "PostgreSQL did not preserve the recorded allowance facts",
              operation: "recordUsage",
            }),
          ),
    );
    const period = yield* Schema.decodeEffect(RecordedPeriod)(result.period).pipe(
      Effect.mapError(
        (cause) =>
          new DatabaseUnavailable({
            cause,
            message: "PostgreSQL returned an invalid allowance period",
            operation: "recordUsage",
          }),
      ),
    );
    const usage = yield* Schema.decodeUnknownEffect(Schema.Array(AggregateUsage))(
      result.aggregate,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new DatabaseUnavailable({
            cause,
            message: "PostgreSQL returned invalid aggregate allowance use",
            operation: "recordUsage",
          }),
      ),
    );
    return {
      outcome: result.inserted.length === 0 ? ExistingUsage.make({}) : Recorded.make({}),
      period,
      usage,
    };
  });
};

import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { AllowancePeriodId, Plan, PlanPolicyVersion, UserId } from "../../domain";
import { AllowanceKind, AllowancePeriodNotFound } from "../../domain/allowance";
import type { BillingDatabase } from "./database";
import { DatabaseUnavailable } from "./errors";
import { runBillingTransaction } from "./transaction";

/** Current persisted period and aggregate use returned only inside the Worker. */
export const StoredAllowanceInspection = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  endsAt: Schema.Date,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  usage: Schema.Array(Schema.Struct({ allowanceKind: AllowanceKind, quantity: Schema.BigInt })),
  userId: UserId,
});

/** Current persisted period and aggregate use returned only inside the Worker. */
export type StoredAllowanceInspection = typeof StoredAllowanceInspection.Type;

/** Inspect the active common allowance period in one PostgreSQL transaction. */
export const inspect = (database: BillingDatabase, userId: UserId, now: Date) =>
  Effect.gen(function* () {
    const { period: selectedPeriod, usage: aggregatedUsage } = yield* runBillingTransaction(
      "inspectAllowances",
      () =>
        // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
        database.transaction(async (transaction) => {
          const [periodRow] = await transaction
            .select({
              allowancePeriodId: allowancePeriods.allowancePeriodId,
              endsAt: allowancePeriods.endsAt,
              plan: allowancePeriods.plan,
              planPolicyVersion: allowancePeriods.planPolicyVersion,
              userId: allowancePeriods.userId,
            })
            .from(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.userId, userId),
                lte(allowancePeriods.startsAt, now),
                gt(allowancePeriods.endsAt, now),
              ),
            )
            .limit(1);
          if (periodRow === undefined) return { period: null, usage: [] };
          const usageRows = await transaction
            .select({
              allowanceKind: allowanceUsage.allowanceKind,
              quantity: sql<bigint>`sum(${allowanceUsage.quantity})`.mapWith(
                allowanceUsage.quantity,
              ),
            })
            .from(allowanceUsage)
            .where(eq(allowanceUsage.allowancePeriodId, periodRow.allowancePeriodId))
            .groupBy(allowanceUsage.allowanceKind);
          return { period: periodRow, usage: usageRows };
        }),
    );
    if (selectedPeriod === null) {
      return yield* new AllowancePeriodNotFound({
        lookup: { _tag: "ActivePeriodForUser", userId },
        message: "No active allowance period exists for the User",
      });
    }
    return yield* Schema.decodeUnknownEffect(StoredAllowanceInspection)({
      ...selectedPeriod,
      usage: aggregatedUsage,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DatabaseUnavailable({
            cause,
            message: "PostgreSQL returned invalid Usage Allowance facts",
            operation: "inspectAllowances",
          }),
      ),
    );
  });

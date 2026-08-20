import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { AllowancePeriodId, Plan, PlanPolicyVersion, UserId } from "../../domain";
import { AllowanceKind, AllowancePeriodNotFound } from "../../domain/allowance";
import type { BillingDatabase } from "./database";
import { DatabaseUnavailable } from "./errors";
import { runBillingTransaction } from "./transaction";

/** Current recorded use supplied to Authorization admission. */
export const StoredAllowanceAdmission = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  endsAt: Schema.Date,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  startsAt: Schema.Date,
  usage: Schema.Array(Schema.Struct({ allowanceKind: AllowanceKind, quantity: Schema.BigInt })),
  userId: UserId,
});

/** Current recorded use supplied to Authorization admission. */
export type StoredAllowanceAdmission = typeof StoredAllowanceAdmission.Type;

/** Read the active period and every recorded kind in one admission transaction. */
export const admit = (database: BillingDatabase, userId: UserId, now: Date) =>
  Effect.gen(function* () {
    const { period: selectedPeriod, usage: aggregatedUsage } = yield* runBillingTransaction(
      "admitAllowance",
      () =>
        // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
        database.transaction(async (transaction) => {
          const [periodRow] = await transaction
            .select({
              allowancePeriodId: allowancePeriods.allowance_period_id,
              endsAt: allowancePeriods.ends_at,
              plan: allowancePeriods.plan,
              planPolicyVersion: allowancePeriods.plan_policy_version,
              startsAt: allowancePeriods.starts_at,
              userId: allowancePeriods.user_id,
            })
            .from(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.user_id, userId),
                lte(allowancePeriods.starts_at, now),
                gt(allowancePeriods.ends_at, now),
              ),
            )
            .limit(1);
          if (periodRow === undefined) return { period: null, usage: [] };
          const usageRows = await transaction
            .select({
              allowanceKind: allowanceUsage.allowance_kind,
              quantity: sql<bigint>`sum(${allowanceUsage.quantity})`.mapWith(
                allowanceUsage.quantity,
              ),
            })
            .from(allowanceUsage)
            .where(eq(allowanceUsage.allowance_period_id, periodRow.allowancePeriodId))
            .groupBy(allowanceUsage.allowance_kind);
          return { period: periodRow, usage: usageRows };
        }),
    );
    if (selectedPeriod === null) {
      return yield* new AllowancePeriodNotFound({
        lookup: { _tag: "ActivePeriodForUser", userId },
        message: "No active allowance period exists for the User",
      });
    }
    return yield* Schema.decodeUnknownEffect(StoredAllowanceAdmission)({
      ...selectedPeriod,
      usage: aggregatedUsage,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DatabaseUnavailable({
            cause,
            message: "PostgreSQL returned invalid allowance admission facts",
            operation: "admitAllowance",
          }),
      ),
    );
  });

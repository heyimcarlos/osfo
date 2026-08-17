import type { Effect } from "effect";

import type { AllowancePeriodId, UserId } from "../../domain";
import type { AllowanceItem, AllowanceSource } from "../../domain/allowance";
import { admit } from "./admit";
import type { BillingDatabase } from "./database";
import { inspect } from "./inspect";
import { recordUsage, type RecordUsageError, type RecordUsageResult } from "./record-usage";

export * from "./errors";
export type { BillingDatabase } from "./database";

/** Small public PostgreSQL interface for allowance transactions. */
export interface Interface {
  readonly admit: (userId: UserId, now: Date) => ReturnType<typeof admit>;
  readonly inspect: (userId: UserId, now: Date) => ReturnType<typeof inspect>;
  readonly recordUsage: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<RecordUsageResult, RecordUsageError>;
}

/** Construct the PostgreSQL billing transaction interface. */
export const make = (database: BillingDatabase): Interface => ({
  admit: (userId, now) => admit(database, userId, now),
  inspect: (userId, now) => inspect(database, userId, now),
  recordUsage: (allowancePeriodId, source, items) =>
    recordUsage(database, allowancePeriodId, source, items),
});

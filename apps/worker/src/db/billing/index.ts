import type { Effect } from "effect";

import type { AllowancePeriodId, UserId } from "../../domain";
import type { AllowanceItem, AllowanceSource } from "../../domain/allowance";
import { admit } from "./admit";
import { applyStripeSnapshot } from "./apply-stripe-snapshot";
import type { BillingDatabase } from "./database";
import { inspect } from "./inspect";
import { loadSubscription } from "./load-subscription";
import { recordUsage, type RecordUsageError, type RecordUsageResult } from "./record-usage";
import {
  recordUsageEvent,
  type RecordUsageEventError,
  type RecordUsageEventResult,
} from "./record-usage-event";
import type { UsageEvent } from "../../domain/usage-event";

export * from "./errors";
export type { BillingDatabase } from "./database";

/** Small public PostgreSQL interface for allowance transactions. */
export interface Interface {
  readonly apply: ReturnType<typeof makeApply>;
  readonly admit: (userId: UserId, now: Date) => ReturnType<typeof admit>;
  readonly inspect: (userId: UserId, now: Date) => ReturnType<typeof inspect>;
  readonly recordUsage: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<RecordUsageResult, RecordUsageError>;
  readonly recordUsageEvent: (
    event: UsageEvent,
  ) => Effect.Effect<RecordUsageEventResult, RecordUsageEventError>;
  readonly load: (userId: UserId) => ReturnType<typeof loadSubscription>;
}

const makeApply =
  (database: BillingDatabase) => (input: Parameters<typeof applyStripeSnapshot>[1]) =>
    applyStripeSnapshot(database, input);

/** Construct the PostgreSQL billing transaction interface. */
export const make = (database: BillingDatabase): Interface => ({
  apply: makeApply(database),
  admit: (userId, now) => admit(database, userId, now),
  inspect: (userId, now) => inspect(database, userId, now),
  load: (userId) => loadSubscription(database, userId),
  recordUsage: (allowancePeriodId, source, items) =>
    recordUsage(database, allowancePeriodId, source, items),
  recordUsageEvent: (event) => recordUsageEvent(database, event),
});

export * as BillingDb from "./index";

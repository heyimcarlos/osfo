import { Schema } from "effect";

import { AllowancePeriodId, Plan, UserId } from "../domain";

/** Evolving persisted metrics interpreted by their pinned legacy or shared Usage policy. */
export const AllowanceKind = Schema.Literals([
  "acceptedMessages",
  "supermemoryIngestionTokens",
  "supermemoryRetrievals",
  "fileUploads",
  "generatedDocuments",
  "researchReports",
  "gmailSearches",
  "gmailMessagesExamined",
  "gmailSends",
  "reminderDeliveries",
  "workflowStarts",
  "gmSummons",
  "vendorUsdMicros",
  "planUsageMicros",
]);

/** Evolving persisted metrics interpreted by their pinned legacy or shared Usage policy. */
export type AllowanceKind = typeof AllowanceKind.Type;

/** Trusted evidence basis for one normalized consumption quantity. */
export const ConsumptionBasis = Schema.Literals(["known_at_start", "observed", "conservative"]);

/** Trusted evidence basis for one normalized consumption quantity. */
export type ConsumptionBasis = typeof ConsumptionBasis.Type;

/** Non-negative aggregate use for one allowance kind. */
export const RecordedAllowanceUse = Schema.Struct({
  allowanceKind: AllowanceKind,
  quantity: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
});

/** Non-negative aggregate use for one allowance kind. */
export type RecordedAllowanceUse = typeof RecordedAllowanceUse.Type;

/** One positive, schema-checked allowance quantity supplied by a feature. */
export const AllowanceItem = Schema.Struct({
  allowanceKind: AllowanceKind,
  basis: ConsumptionBasis,
  quantity: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
});

/** One positive, schema-checked allowance quantity supplied by a feature. */
export type AllowanceItem = typeof AllowanceItem.Type;

/** Existing product or effect identity used to make consumption idempotent. */
export const AllowanceSource = Schema.Struct({
  sourceId: Schema.String.check(Schema.isMinLength(1)),
  sourceType: Schema.String.check(Schema.isMinLength(1)),
});

/** Existing product or effect identity used to make consumption idempotent. */
export type AllowanceSource = typeof AllowanceSource.Type;

/** Expected conflict when an idempotency key is retried with changed facts. */
export class UsageConflict extends Schema.TaggedError<UsageConflict>()("UsageConflict", {
  allowanceKind: AllowanceKind,
  allowancePeriodId: AllowancePeriodId,
  message: Schema.String,
  sourceId: Schema.String,
  sourceType: Schema.String,
}) {}

/** Expected failure when the original admitted allowance period does not exist. */
export class AllowancePeriodNotFound extends Schema.TaggedError<AllowancePeriodNotFound>()(
  "AllowancePeriodNotFound",
  {
    lookup: Schema.Union([
      Schema.TaggedStruct("AllowancePeriod", { allowancePeriodId: AllowancePeriodId }),
      Schema.TaggedStruct("ActivePeriodForUser", { userId: UserId }),
    ]),
    message: Schema.String,
  },
) {}

/** Successful first insertion of at least one Allowance Consumption fact. */
export const Recorded = Schema.TaggedStruct("Recorded", {});

/** Successful first insertion of at least one Allowance Consumption fact. */
export type Recorded = typeof Recorded.Type;

/** Successful idempotent retry that found the same trusted use. */
export const ExistingUsage = Schema.TaggedStruct("ExistingUsage", {});

/** Successful idempotent retry that found the same trusted use. */
export type ExistingUsage = typeof ExistingUsage.Type;

/** Visible aggregate for one period allowance kind. */
export const VisibleAllowanceUse = Schema.Struct({
  allowanceKind: AllowanceKind,
  limit: Schema.BigInt,
  recorded: Schema.BigInt,
  remaining: Schema.BigInt,
});

/** Visible aggregate for one period allowance kind. */
export type VisibleAllowanceUse = typeof VisibleAllowanceUse.Type;

/** Retained launch-v1 inspection with hidden vendor cost removed. */
export const LegacyAllowanceInspection = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  plan: Plan,
  resetsAt: Schema.Date,
  usage: Schema.Array(VisibleAllowanceUse),
  userId: UserId,
});

/** Retained launch-v1 inspection with hidden vendor cost removed. */
export type LegacyAllowanceInspection = typeof LegacyAllowanceInspection.Type;

/** Safe one-pool User presentation for a shared Plan Usage period. */
export const PlanUsageInspection = Schema.TaggedStruct("PlanUsage", {
  allowancePeriodId: AllowancePeriodId,
  plan: Plan,
  remainingLabel: Schema.String,
  remainingPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.Date,
  userId: UserId,
  warning: Schema.NullOr(Schema.Literals(["twentyPercent", "exhausted"])),
});

/** Safe one-pool User presentation for a shared Plan Usage period. */
export type PlanUsageInspection = typeof PlanUsageInspection.Type;

/** Canonical percentage presentation for one shared Plan Usage pool. */
export const presentPlanUsage = (recorded: bigint, included: bigint) => {
  const remaining = recorded >= included ? 0n : included - recorded;
  const remainingPercent = Number((remaining * 100n) / included);
  return {
    remainingLabel:
      remaining === 0n ? "0%" : remainingPercent === 0 ? "<1%" : `${remainingPercent}%`,
    remainingPercent,
    warning: remaining === 0n ? "exhausted" : remainingPercent <= 20 ? "twentyPercent" : null,
  } as const;
};

/** Version-specific User inspection that preserves retained launch behavior. */
export const AllowanceInspection = Schema.Union([LegacyAllowanceInspection, PlanUsageInspection]);

/** Version-specific User inspection that preserves retained launch behavior. */
export type AllowanceInspection = typeof AllowanceInspection.Type;

/** PostgreSQL allowance transaction operations that can fail without driver details. */
export const BillingDatabaseOperation = Schema.Literals([
  "admitAllowance",
  "inspectAllowances",
  "recordUsage",
  "recordUsageEvent",
  "loadBillingSubscription",
  "applyStripeSnapshot",
]);

/** PostgreSQL allowance transaction operations that can fail without driver details. */
export type BillingDatabaseOperation = typeof BillingDatabaseOperation.Type;

/** Safe typed failure for an unavailable PostgreSQL allowance transaction. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "DatabaseUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: BillingDatabaseOperation,
  },
) {}

/** Expected failure after every safe PostgreSQL transaction retry is exhausted. */
export class BillingTransactionRetryExhausted extends Schema.TaggedError<BillingTransactionRetryExhausted>()(
  "BillingTransactionRetryExhausted",
  {
    attempts: Schema.Int,
    cause: Schema.Defect(),
    message: Schema.String,
    operation: BillingDatabaseOperation,
  },
) {}

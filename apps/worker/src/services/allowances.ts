import { Effect } from "effect";

import type { AllowancePeriodId, Plan, PlanPolicyVersion, UserId } from "../domain";
import type {
  AllowanceInspection,
  AllowanceItem,
  AllowancePeriodNotFound,
  AllowanceSource,
  BillingTransactionRetryExhausted,
  DatabaseUnavailable,
  ExistingUsage,
  Recorded,
  RecordedAllowanceUse,
  UsageConflict,
} from "../domain/allowance";
import type { PlanPolicyCatalog, PlanPolicyNotFound } from "../domain/plan-policy";
import { policyFor, policyForVersion } from "../domain/plan-policy";

const visibleAllowanceKinds = [
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
] as const;

/** Concrete dependencies for the Allowances application service. */
export interface MakeOptions {
  readonly billing: Persistence;
  readonly catalog: PlanPolicyCatalog;
  readonly now: Effect.Effect<Date>;
}

/** Narrow persistence port required by the Allowances application service. */
export interface Persistence {
  readonly inspect: (
    userId: UserId,
    now: Date,
  ) => Effect.Effect<
    {
      readonly allowancePeriodId: AllowancePeriodId;
      readonly endsAt: Date;
      readonly plan: Plan;
      readonly planPolicyVersion: PlanPolicyVersion;
      readonly usage: ReadonlyArray<RecordedAllowanceUse>;
      readonly userId: UserId;
    },
    AllowancePeriodNotFound | BillingTransactionRetryExhausted | DatabaseUnavailable
  >;
  readonly recordUsage: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<
    {
      readonly outcome: ExistingUsage | Recorded;
      readonly period: {
        readonly plan: Plan;
        readonly planPolicyVersion: PlanPolicyVersion;
        readonly userId: UserId;
      } | null;
      readonly usage: ReadonlyArray<RecordedAllowanceUse>;
    },
    AllowancePeriodNotFound | BillingTransactionRetryExhausted | DatabaseUnavailable | UsageConflict
  >;
}

/** Allowance Consumption and user-visible inspection operations. */
export interface Interface {
  readonly inspect: (
    userId: UserId,
  ) => Effect.Effect<
    AllowanceInspection,
    | AllowancePeriodNotFound
    | BillingTransactionRetryExhausted
    | DatabaseUnavailable
    | PlanPolicyNotFound
  >;
  readonly record: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<
    ExistingUsage | Recorded,
    | AllowancePeriodNotFound
    | BillingTransactionRetryExhausted
    | DatabaseUnavailable
    | PlanPolicyNotFound
    | UsageConflict
  >;
}

/** Construct Allowances from its narrow PostgreSQL transaction port. */
export const make = (options: MakeOptions): Interface => ({
  inspect: (userId) =>
    Effect.gen(function* () {
      const now = yield* options.now;
      const stored = yield* options.billing.inspect(userId, now);
      const policy = yield* policyForVersion(options.catalog, stored.planPolicyVersion);
      const rules = policyFor(policy, stored.plan);
      return {
        allowancePeriodId: stored.allowancePeriodId,
        plan: stored.plan,
        resetsAt: stored.endsAt,
        usage: visibleAllowanceKinds.map((allowanceKind) => {
          const recorded =
            stored.usage.find((candidate) => candidate.allowanceKind === allowanceKind)?.quantity ??
            0n;
          const limit = rules.allowanceLimits[allowanceKind];
          return {
            allowanceKind,
            limit,
            recorded,
            remaining: recorded >= limit ? 0n : limit - recorded,
          };
        }),
        userId: stored.userId,
      } satisfies AllowanceInspection;
    }),
  record: (allowancePeriodId, source, items) =>
    Effect.gen(function* () {
      const recorded = yield* options.billing.recordUsage(allowancePeriodId, source, items);
      if (recorded.period !== null) {
        const policy = yield* policyForVersion(options.catalog, recorded.period.planPolicyVersion);
        const limits = policyFor(policy, recorded.period.plan).allowanceLimits;
        yield* Effect.forEach(
          recorded.usage,
          (usage) =>
            usage.quantity > limits[usage.allowanceKind]
              ? Effect.logWarning("Allowance Consumption exceeded its soft cap").pipe(
                  Effect.annotateLogs({
                    allowanceKind: usage.allowanceKind,
                    allowancePeriodId,
                    limit: String(limits[usage.allowanceKind]),
                    recorded: String(usage.quantity),
                    userId: recorded.period?.userId,
                  }),
                )
              : Effect.void,
          { discard: true },
        );
      }
      return recorded.outcome;
    }),
});

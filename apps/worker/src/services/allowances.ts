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
import { presentPlanUsage } from "../domain/allowance";
import type {
  PlanPolicyCatalog,
  PlanPolicyNotFound,
  SharedUsagePlanRules,
} from "../domain/plan-policy";
import { isLaunchPolicy, policyFor, policyForVersion } from "../domain/plan-policy";

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

interface InspectionFacts {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly endsAt: Date;
  readonly plan: Plan;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly usage: ReadonlyArray<RecordedAllowanceUse>;
  readonly userId: UserId;
}

/** Narrow persistence port required by the Allowances application service. */
export interface Persistence {
  readonly inspect: (
    userId: UserId,
    now: Date,
  ) => Effect.Effect<
    InspectionFacts,
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
  readonly recordUsageForUser: (
    userId: UserId,
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => ReturnType<Persistence["recordUsage"]>;
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
  readonly recordForUser: (
    userId: UserId,
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => ReturnType<Interface["record"]>;
}

/** Construct Allowances from its narrow PostgreSQL transaction port. */
export const make = (options: MakeOptions): Interface => ({
  inspect: (userId) =>
    Effect.gen(function* () {
      const now = yield* options.now;
      const stored = yield* options.billing.inspect(userId, now);
      const policy = yield* policyForVersion(options.catalog, stored.planPolicyVersion);
      if (!isLaunchPolicy(policy)) {
        return planUsageInspection(stored, policyFor(policy, stored.plan));
      }
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
    recordAllowanceUse(options, allowancePeriodId, source, items),
  recordForUser: (userId, allowancePeriodId, source, items) =>
    recordAllowanceUse(options, allowancePeriodId, source, items, userId),
});

const recordAllowanceUse = Effect.fn("Allowances.recordAllowanceUse")(function* (
  options: MakeOptions,
  allowancePeriodId: AllowancePeriodId,
  source: AllowanceSource,
  items: ReadonlyArray<AllowanceItem>,
  expectedUserId?: UserId,
) {
  const recorded = yield* expectedUserId === undefined
    ? options.billing.recordUsage(allowancePeriodId, source, items)
    : options.billing.recordUsageForUser(expectedUserId, allowancePeriodId, source, items);
  if (recorded.period !== null) {
    const policy = yield* policyForVersion(options.catalog, recorded.period.planPolicyVersion);
    if (isLaunchPolicy(policy)) {
      const limits = policyFor(policy, recorded.period.plan).allowanceLimits;
      yield* Effect.forEach(
        recorded.usage,
        (usage) => {
          if (usage.allowanceKind === "planUsageMicros") return Effect.void;
          return usage.quantity > limits[usage.allowanceKind]
            ? logSoftCap(
                allowancePeriodId,
                usage.allowanceKind,
                limits[usage.allowanceKind],
                usage.quantity,
                recorded.period?.userId,
              )
            : Effect.void;
        },
        { discard: true },
      );
    } else {
      const limit = policyFor(policy, recorded.period.plan).includedPlanUsageMicros;
      const usage = recorded.usage.find(
        (candidate) => candidate.allowanceKind === "planUsageMicros",
      );
      if (usage !== undefined && usage.quantity > limit) {
        yield* logSoftCap(
          allowancePeriodId,
          usage.allowanceKind,
          limit,
          usage.quantity,
          recorded.period.userId,
        );
      }
    }
  }
  return recorded.outcome;
});

const planUsageInspection = (
  stored: InspectionFacts,
  rules: SharedUsagePlanRules,
): AllowanceInspection => {
  const recorded =
    stored.usage.find((candidate) => candidate.allowanceKind === "planUsageMicros")?.quantity ?? 0n;
  return {
    _tag: "PlanUsage",
    allowancePeriodId: stored.allowancePeriodId,
    plan: stored.plan,
    ...presentPlanUsage(recorded, rules.includedPlanUsageMicros),
    resetsAt: stored.endsAt,
    userId: stored.userId,
  };
};

const logSoftCap = (
  allowancePeriodId: AllowancePeriodId,
  allowanceKind: AllowanceItem["allowanceKind"],
  limit: bigint,
  recorded: bigint,
  userId: UserId | undefined,
) =>
  Effect.logWarning("Allowance Consumption exceeded its soft cap").pipe(
    Effect.annotateLogs({
      allowanceKind,
      allowancePeriodId,
      limit: String(limit),
      recorded: String(recorded),
      userId,
    }),
  );

export * as Allowances from "./allowances";

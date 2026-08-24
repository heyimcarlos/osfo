import {
  allowancePeriods,
  allowanceUsage,
  usageEventComponents,
  usageEventEvidenceReferences,
  usageEvents,
} from "@osfo/db/schema/allowances";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Predicate, Result, Schema } from "effect";

import { UserId } from "../../domain";
import { AllowancePeriodNotFound, ExistingUsage, Recorded } from "../../domain/allowance";
import {
  parseUsageEvent,
  type UsageEvent,
  UsageEventConflict,
  type UsageEventInvalid,
  type UsageEvidenceReference,
} from "../../domain/usage-event";
import type { RatedComponent } from "../../domain/usage";
import type { BillingDatabase } from "./database";
import type { BillingTransactionRetryExhausted, DatabaseUnavailable } from "./errors";
import { runBillingTransaction } from "./transaction";

/* oxlint-disable eslint/no-underscore-dangle -- Usage Event outcomes use the standard Effect _tag discriminator. */

/** Result of idempotently retaining one final Usage Event. */
export const RecordUsageEventResult = Schema.Struct({
  outcome: Schema.Union([ExistingUsage, Recorded]),
  recordedPlanUsageMicros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
});

/** Result of idempotently retaining one final Usage Event. */
export type RecordUsageEventResult = typeof RecordUsageEventResult.Type;

/** Expected failures from one Usage Event transaction. */
export type RecordUsageEventError =
  | AllowancePeriodNotFound
  | BillingTransactionRetryExhausted
  | DatabaseUnavailable
  | UsageEventConflict
  | UsageEventInvalid;

/** Retain final evidence and shared Plan Usage atomically against the original period. */
export const recordUsageEvent = Effect.fn("Billing.recordUsageEvent")(function* (
  database: BillingDatabase,
  supplied: UsageEvent,
) {
  const parsed = parseUsageEvent(supplied);
  if (Result.isFailure(parsed)) return yield* parsed.failure;
  const event = normalizeEvent(parsed.success);
  const factsJson = encodeFacts(event);
  const charge = chargedOutcome(event.outcome);
  const result = yield* runBillingTransaction("recordUsageEvent", () =>
    // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
    database.transaction(async (transaction) => {
      const [period] = await transaction
        .select({
          planPolicyVersion: allowancePeriods.plan_policy_version,
          userId: allowancePeriods.user_id,
        })
        .from(allowancePeriods)
        .where(eq(allowancePeriods.allowance_period_id, event.allowancePeriodId))
        .for("update")
        .limit(1);
      if (period === undefined) return { _tag: "PeriodNotFound" } as const;
      if (period.planPolicyVersion !== event.usagePolicyVersion) {
        return { _tag: "Conflict" } as const;
      }

      const [existing] = await transaction
        .select({ factsJson: usageEvents.facts_json })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.allowance_period_id, event.allowancePeriodId),
            eq(usageEvents.source_type, event.source.sourceType),
            eq(usageEvents.source_id, event.source.sourceId),
          ),
        )
        .limit(1);
      if (existing !== undefined && existing.factsJson !== factsJson) {
        return { _tag: "Conflict" } as const;
      }

      if (existing === undefined) {
        await transaction.insert(usageEvents).values({
          allowance_period_id: event.allowancePeriodId,
          capability_catalog_version: event.capabilityCatalogVersion,
          facts_json: factsJson,
          manifest_version: event.manifestVersion,
          model_access_policy_version: event.modelAccessPolicyVersion,
          occurred_at: event.occurredAt,
          outcome: outcomeValue(event.outcome),
          plan_usage_micros: charge?.planUsageMicros,
          rated_cost_usd_micros: charge?.ratedCostUsdMicros,
          root_operation_id: event.rootOperationId,
          source_id: event.source.sourceId,
          source_type: event.source.sourceType,
          usage_policy_version: event.usagePolicyVersion,
          user_id: UserId.make(period.userId),
        });
        if (charge !== null) {
          await transaction.insert(usageEventComponents).values(
            charge.components.map((component, componentIndex) => ({
              activity: component.activity,
              allowance_period_id: event.allowancePeriodId,
              component_index: componentIndex,
              component_kind: "evidence" in component ? ("model" as const) : ("non_model" as const),
              evidence_json: componentEvidenceJson(component),
              rated_cost_usd_micros: component.ratedCostUsdMicros,
              resource_price_version: component.resourcePriceVersion,
              source_id: event.source.sourceId,
              source_type: event.source.sourceType,
            })),
          );
          await transaction.insert(allowanceUsage).values({
            allowance_kind: "planUsageMicros",
            allowance_period_id: event.allowancePeriodId,
            basis: "observed",
            quantity: charge.planUsageMicros,
            source_id: event.source.sourceId,
            source_type: event.source.sourceType,
            user_id: UserId.make(period.userId),
          });
        }
        if (event.evidenceReferences.length > 0) {
          await transaction.insert(usageEventEvidenceReferences).values(
            event.evidenceReferences.map((evidence) => ({
              allowance_period_id: event.allowancePeriodId,
              reference: evidence.reference,
              reference_kind: evidence.kind,
              source_id: event.source.sourceId,
              source_type: event.source.sourceType,
            })),
          );
        }
      }

      const [aggregate] = await transaction
        .select({
          quantity: sql<bigint>`coalesce(sum(${allowanceUsage.quantity}), 0)`.mapWith(
            allowanceUsage.quantity,
          ),
        })
        .from(allowanceUsage)
        .where(
          and(
            eq(allowanceUsage.allowance_period_id, event.allowancePeriodId),
            eq(allowanceUsage.allowance_kind, "planUsageMicros"),
          ),
        );
      return {
        _tag: "Stored" as const,
        inserted: existing === undefined,
        recordedPlanUsageMicros: aggregate?.quantity ?? 0n,
      };
    }),
  );

  if (Predicate.isTagged(result, "PeriodNotFound")) {
    return yield* new AllowancePeriodNotFound({
      lookup: { _tag: "AllowancePeriod", allowancePeriodId: event.allowancePeriodId },
      message: "The Usage Event's original period does not exist",
    });
  }
  if (Predicate.isTagged(result, "Conflict")) {
    return yield* new UsageEventConflict({
      allowancePeriodId: event.allowancePeriodId,
      message: "The Usage Event identity was retried with changed facts",
      sourceId: event.source.sourceId,
      sourceType: event.source.sourceType,
    });
  }
  return {
    outcome: result.inserted ? Recorded.make({}) : ExistingUsage.make({}),
    recordedPlanUsageMicros: result.recordedPlanUsageMicros,
  };
});

const chargedOutcome = (outcome: UsageEvent["outcome"]) =>
  outcome._tag === "Completed" || outcome._tag === "UsefulPartial" ? outcome.charge : null;

const outcomeValue = (outcome: UsageEvent["outcome"]) => {
  switch (outcome._tag) {
    case "Completed":
      return "completed" as const;
    case "UsefulPartial":
      return "useful_partial" as const;
    case "Failed":
      return "failed" as const;
    case "Cancelled":
      return "cancelled" as const;
    default:
      return outcome satisfies never;
  }
};

const normalizeEvent = (event: UsageEvent): UsageEvent => ({
  ...event,
  evidenceReferences: event.evidenceReferences.reduce<ReadonlyArray<UsageEvidenceReference>>(
    (sorted, reference) => {
      const index = sorted.findIndex(
        (candidate) => compareEvidenceReference(reference, candidate) < 0,
      );
      return index === -1
        ? sorted.concat(reference)
        : sorted.slice(0, index).concat(reference, sorted.slice(index));
    },
    [],
  ),
});

const compareEvidenceReference = (left: UsageEvidenceReference, right: UsageEvidenceReference) =>
  `${left.kind}\u0000${left.reference}`.localeCompare(`${right.kind}\u0000${right.reference}`);

const encodeFacts = (event: UsageEvent) =>
  JSON.stringify({
    allowancePeriodId: event.allowancePeriodId,
    capabilityCatalogVersion: event.capabilityCatalogVersion,
    evidenceReferences: event.evidenceReferences,
    manifestVersion: event.manifestVersion,
    modelAccessPolicyVersion: event.modelAccessPolicyVersion,
    occurredAt: event.occurredAt.toISOString(),
    outcome: encodeOutcome(event.outcome),
    rootOperationId: event.rootOperationId,
    source: event.source,
    usagePolicyVersion: event.usagePolicyVersion,
  });

const encodeOutcome = (outcome: UsageEvent["outcome"]) =>
  outcome._tag === "Failed" || outcome._tag === "Cancelled"
    ? { _tag: outcome._tag }
    : {
        _tag: outcome._tag,
        charge: {
          components: outcome.charge.components.map(encodeComponent),
          planUsageMicros: String(outcome.charge.planUsageMicros),
          ratedCostUsdMicros: String(outcome.charge.ratedCostUsdMicros),
          usagePolicyVersion: outcome.charge.usagePolicyVersion,
        },
      };

const encodeComponent = (component: RatedComponent) => ({
  activity: component.activity,
  evidence: "evidence" in component ? encodeModelEvidence(component.evidence) : undefined,
  ratedCostUsdMicros: String(component.ratedCostUsdMicros),
  resourcePriceVersion: component.resourcePriceVersion,
});

const encodeModelEvidence = (
  evidence: Extract<RatedComponent, { readonly evidence: object }>["evidence"],
) => ({
  cachedInputTokens: String(evidence.cachedInputTokens),
  inputTokens: String(evidence.inputTokens),
  outputTokens: String(evidence.outputTokens),
  priceEntryId: evidence.priceEntryId,
});

const componentEvidenceJson = (component: RatedComponent) =>
  JSON.stringify("evidence" in component ? encodeModelEvidence(component.evidence) : {});

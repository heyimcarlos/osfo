import { Schema } from "effect";

import type { AllowancePeriodId, ThinkSubmissionId } from "../domain";
import type { AllowanceItem, AllowanceSource } from "./allowance";

/* oxlint-disable eslint/no-underscore-dangle -- Effect tagged unions expose their discriminator as _tag. */

/** Existing Think-owned identity for one provider contact within a Submission step. */
export const ModelCallAttemptId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^model-call-attempt:[^:]+:\d+$/.test(value) ||
      "must identify one Think Submission model step",
  ),
).pipe(Schema.brand("ModelCallAttemptId"));

/** Existing Think-owned identity for one provider contact within a Submission step. */
export type ModelCallAttemptId = typeof ModelCallAttemptId.Type;

/** One positive step number inside a bounded Think Submission. */
export const ModelStepNumber = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ModelStepNumber"),
);

/** One positive step number inside a bounded Think Submission. */
export type ModelStepNumber = typeof ModelStepNumber.Type;

/** Trusted provider evidence available after one model call attempt. */
export const ModelCallEvidence = Schema.Union([
  Schema.TaggedStruct("Observed", {
    supermemoryIngestionTokens: Schema.optional(
      Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    ),
    supermemoryRetrievals: Schema.optional(
      Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    ),
    vendorUsdMicros: Schema.optional(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  }),
  Schema.TaggedStruct("NotContacted", {}),
  Schema.TaggedStruct("Ambiguous", {
    conservativeVendorUsdMicros: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
  }),
]);

/** Trusted provider evidence available after one model call attempt. */
export type ModelCallEvidence = typeof ModelCallEvidence.Type;

/** Idempotent Allowance Consumption facts owned by one ModelCallAttempt identity. */
export interface NormalizedModelCallUsage {
  readonly items: ReadonlyArray<AllowanceItem>;
  readonly source: AllowanceSource;
}

/** Reuse the Think Submission and step as the provider attempt identity. */
export const modelCallAttemptId = (
  submissionId: ThinkSubmissionId,
  stepNumber: ModelStepNumber,
): ModelCallAttemptId =>
  ModelCallAttemptId.make(`model-call-attempt:${submissionId}:${stepNumber}`);

/** Partition one request ceiling across its bounded steps without increasing the total. */
export const conservativeVendorCostForStep = (
  maximumVendorUsdMicros: bigint,
  maximumSteps: number,
  stepNumber: ModelStepNumber,
): bigint => {
  const steps = BigInt(maximumSteps);
  const index = BigInt(stepNumber - 1);
  return maximumVendorUsdMicros / steps + (index < maximumVendorUsdMicros % steps ? 1n : 0n);
};

/** Normalize exact, proven-no-use, or conservative provider evidence for idempotent recording. */
export const normalizeModelCallUsage = (
  attemptId: ModelCallAttemptId,
  evidence: ModelCallEvidence,
): NormalizedModelCallUsage => {
  const source = { sourceId: attemptId, sourceType: "ModelCallAttempt" } as const;
  switch (evidence._tag) {
    case "NotContacted":
      return { items: [], source };
    case "Ambiguous":
      return {
        items: [
          {
            allowanceKind: "vendorUsdMicros",
            basis: "conservative",
            quantity: evidence.conservativeVendorUsdMicros,
          },
        ],
        source,
      };
    case "Observed":
      return {
        items: [
          usageItem("supermemoryIngestionTokens", evidence.supermemoryIngestionTokens),
          usageItem("supermemoryRetrievals", evidence.supermemoryRetrievals),
          usageItem("vendorUsdMicros", evidence.vendorUsdMicros),
        ].filter((item): item is AllowanceItem => item !== null),
        source,
      };
    default:
      return evidence satisfies never;
  }
};

const usageItem = (
  allowanceKind: AllowanceItem["allowanceKind"],
  quantity: bigint | undefined,
): AllowanceItem | null =>
  quantity === undefined || quantity === 0n ? null : { allowanceKind, basis: "observed", quantity };

/** Conflict when one ModelCallAttempt is reused with changed normalized evidence. */
export class ModelCallUsageConflict extends Schema.TaggedError<ModelCallUsageConflict>()(
  "ModelCallUsageConflict",
  {
    attemptId: ModelCallAttemptId,
    message: Schema.String,
  },
) {}

/** Expected Agent SQLite failure at the model-call usage boundary. */
export class ModelCallUsageStoreUnavailable extends Schema.TaggedError<ModelCallUsageStoreUnavailable>()(
  "ModelCallUsageStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

/** Recoverable failure while dispatching durable model evidence to Allowances. */
export class ModelCallUsageDispatchUnavailable extends Schema.TaggedError<ModelCallUsageDispatchUnavailable>()(
  "ModelCallUsageDispatchUnavailable",
  {
    attemptId: ModelCallAttemptId,
    message: Schema.String,
  },
) {}

/** Durable normalized evidence pending PostgreSQL Allowance recording. */
export interface PendingModelCallUsage {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly attemptId: ModelCallAttemptId;
  readonly items: ReadonlyArray<AllowanceItem>;
  readonly qualification?: QualificationModelCallIdentity;
}

/** Server-owned root identity retained with a qualification model-call cost fact. */
export interface QualificationModelCallIdentity {
  readonly costReconciliationId: string;
  readonly executionId: string;
  readonly gatewayRequestId: string | null;
  readonly modelRequestId: string;
  readonly outcomeId: string;
  readonly priceBookId: string;
  readonly rootId: string;
}

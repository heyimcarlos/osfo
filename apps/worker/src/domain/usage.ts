import { Result, Schema } from "effect";

import { managedSearchPrice } from "./web-search-price";

import { PlanPolicyVersion, ResourcePriceVersion } from "../domain";
import {
  isSharedUsagePolicy,
  type PlanPolicyCatalog,
  type SharedUsagePlanPolicy,
} from "./plan-policy";

const nonNegativeQuantity = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n));
const positiveQuantity = Schema.BigInt.check(Schema.isGreaterThanBigInt(0n));
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Broad User-facing projection categories derived from Usage Events. */
export const UsageActivity = Schema.Literals([
  "conversationsAndMemory",
  "webAndResearch",
  "integrations",
  "filesAndArtifacts",
  "imagesAndDiagrams",
  "automations",
]);

/** Broad User-facing projection categories derived from Usage Events. */
export type UsageActivity = typeof UsageActivity.Type;

/** Immutable managed-model token rates selected by the owning model adapter. */
export const ManagedModelPrice = Schema.Struct({
  cachedInputUsdMicrosPerMillionTokens: nonNegativeQuantity,
  inputUsdMicrosPerMillionTokens: nonNegativeQuantity,
  outputUsdMicrosPerMillionTokens: nonNegativeQuantity,
  priceEntryId: nonEmptyString,
  resourcePriceVersion: ResourcePriceVersion,
});

/** Immutable managed-model token rates selected by the owning model adapter. */
export type ManagedModelPrice = typeof ManagedModelPrice.Type;

/** Completed useful managed-model work eligible for Plan Usage. */
export const CompletedModelWork = Schema.Struct({
  activity: UsageActivity,
  cachedInputTokens: nonNegativeQuantity,
  inputTokens: nonNegativeQuantity,
  outputTokens: nonNegativeQuantity,
  price: ManagedModelPrice,
}).check(
  Schema.makeFilter(
    (work) =>
      work.cachedInputTokens <= work.inputTokens || "cachedInputTokens cannot exceed inputTokens",
  ),
);

/** Completed useful managed-model work eligible for Plan Usage. */
export type CompletedModelWork = typeof CompletedModelWork.Type;

/** Generic Rated Cost supplied by an owning non-model adapter after useful completion. */
export const CompletedNonModelCost = Schema.Struct({
  activity: UsageActivity,
  ratedCostUsdMicros: positiveQuantity,
  resourcePriceVersion: ResourcePriceVersion,
});

/** Generic Rated Cost supplied by an owning non-model adapter after useful completion. */
export type CompletedNonModelCost = typeof CompletedNonModelCost.Type;

/** Reproducible model evidence retained beneath one Usage Event. */
export const RatedModelComponent = Schema.Struct({
  activity: UsageActivity,
  evidence: Schema.Struct({
    cachedInputTokens: nonNegativeQuantity,
    inputTokens: nonNegativeQuantity,
    outputTokens: nonNegativeQuantity,
    priceEntryId: nonEmptyString,
  }),
  ratedCostUsdMicros: positiveQuantity,
  resourcePriceVersion: ResourcePriceVersion,
});

/** Reproducible model evidence retained beneath one Usage Event. */
export type RatedModelComponent = typeof RatedModelComponent.Type;

/** Reproducible low-level component retained beneath one Usage Event. */
export const RatedComponent = Schema.Union([RatedModelComponent, CompletedNonModelCost]);

/** Reproducible low-level component retained beneath one Usage Event. */
export type RatedComponent = typeof RatedComponent.Type;

/** Full shared Plan Usage charge for completed useful work. */
export const UsageCharge = Schema.Struct({
  components: Schema.Array(RatedComponent),
  planUsageMicros: positiveQuantity,
  ratedCostUsdMicros: positiveQuantity,
  usagePolicyVersion: PlanPolicyVersion,
}).check(
  Schema.makeFilter(
    (charge) =>
      charge.components.reduce((total, component) => total + component.ratedCostUsdMicros, 0n) ===
        charge.ratedCostUsdMicros || "component Rated Cost must equal the declared Rated Cost",
  ),
  Schema.makeFilter(
    (charge) =>
      charge.usagePolicyVersion !== "shared-usage-v1" ||
      charge.planUsageMicros === charge.ratedCostUsdMicros ||
      "shared-usage-v1 requires one Plan Usage micro per Rated Cost USD micro",
  ),
);

/** Full shared Plan Usage charge for completed useful work. */
export type UsageCharge = typeof UsageCharge.Type;

/** Typed refusal to rate unknown, legacy, invalid, or zero-cost evidence. */
export class UsageRatingFailed extends Schema.TaggedError<UsageRatingFailed>()(
  "UsageRatingFailed",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "invalidCompletedEvidence",
      "noRatedCost",
      "policyUnavailable",
      "unrecognizedPriceEntry",
      "unsupportedPolicy",
    ]),
    usagePolicyVersion: PlanPolicyVersion,
  },
) {}

/** Rate completed low-level resources through one retained shared Usage Policy. */
export const rate = (
  completedModelWork: ReadonlyArray<CompletedModelWork>,
  completedNonModelCost: ReadonlyArray<CompletedNonModelCost>,
  catalog: PlanPolicyCatalog,
  usagePolicyVersion: PlanPolicyVersion,
): Result.Result<UsageCharge, UsageRatingFailed> => {
  const policy = catalog.policies.find((candidate) => candidate.version === usagePolicyVersion);
  if (policy === undefined) {
    return Result.fail(
      ratingFailure(
        usagePolicyVersion,
        "policyUnavailable",
        "The period names no retained Usage Policy",
      ),
    );
  }
  if (!isSharedUsagePolicy(policy)) {
    return Result.fail(
      ratingFailure(
        usagePolicyVersion,
        "unsupportedPolicy",
        "The retained legacy policy does not accept shared Plan Usage charges",
      ),
    );
  }
  const decodedModelWork = Schema.decodeResult(Schema.Array(CompletedModelWork))(
    completedModelWork,
    { onExcessProperty: "error" },
  );
  const decodedNonModelCost = Schema.decodeResult(Schema.Array(CompletedNonModelCost))(
    completedNonModelCost,
    { onExcessProperty: "error" },
  );
  if (Result.isFailure(decodedModelWork) || Result.isFailure(decodedNonModelCost)) {
    return Result.fail(
      ratingFailure(
        usagePolicyVersion,
        "invalidCompletedEvidence",
        "Completed resource evidence is invalid",
      ),
    );
  }
  if (
    decodedModelWork.success.some(({ price }) => !isRecognizedModelPrice(price)) ||
    decodedNonModelCost.success.some(
      ({ resourcePriceVersion }) => !recognizedResourcePriceVersions.has(resourcePriceVersion),
    )
  ) {
    return Result.fail(
      ratingFailure(
        usagePolicyVersion,
        "unrecognizedPriceEntry",
        "Completed work names no recognized immutable Resource Price entry",
      ),
    );
  }

  const modelComponents = decodedModelWork.success.flatMap(rateModelWork);
  const components: ReadonlyArray<RatedComponent> = [
    ...modelComponents,
    ...decodedNonModelCost.success,
  ];
  const ratedCostUsdMicros = components.reduce(
    (total, component) => total + component.ratedCostUsdMicros,
    0n,
  );
  if (ratedCostUsdMicros === 0n) {
    return Result.fail(
      ratingFailure(usagePolicyVersion, "noRatedCost", "Completed work has no positive Rated Cost"),
    );
  }
  return Result.succeed({
    components,
    planUsageMicros: convertRatedCost(policy, ratedCostUsdMicros),
    ratedCostUsdMicros,
    usagePolicyVersion,
  });
};

const activityLabels = {
  automations: "automations",
  conversationsAndMemory: "conversations and memory",
  filesAndArtifacts: "files and artifacts",
  imagesAndDiagrams: "images and diagrams",
  integrations: "integrations",
  webAndResearch: "web and research",
} satisfies Readonly<Record<UsageActivity, string>>;

const activityOrder = [
  "conversationsAndMemory",
  "webAndResearch",
  "integrations",
  "filesAndArtifacts",
  "imagesAndDiagrams",
  "automations",
] as const;

/** Explain a completed period as safe broad shares with no accounting internals. */
export const explainActivityShares = (
  components: ReadonlyArray<Pick<RatedComponent, "activity" | "ratedCostUsdMicros">>,
) => {
  const totals = new Map<UsageActivity, bigint>();
  for (const component of components) {
    totals.set(
      component.activity,
      (totals.get(component.activity) ?? 0n) + component.ratedCostUsdMicros,
    );
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return [];
  const shares = activityOrder
    .filter((activity) => totals.has(activity))
    .map((activity) => ({
      activity,
      label: activityLabels[activity],
      percentage: Number(((totals.get(activity) ?? 0n) * 100n) / total),
      value: totals.get(activity) ?? 0n,
    }));
  const allocated = shares.reduce((sum, share) => sum + share.percentage, 0);
  const largest = shares.reduce(
    (selected, share, index) => (share.value > (shares[selected]?.value ?? 0n) ? index : selected),
    0,
  );
  return shares.map(({ activity, label, percentage }, index) => ({
    activity,
    label,
    percentage: index === largest ? percentage + (100 - allocated) : percentage,
  }));
};

const rateModelWork = (work: CompletedModelWork): ReadonlyArray<RatedModelComponent> => {
  const uncachedInputTokens = work.inputTokens - work.cachedInputTokens;
  const ratedCostUsdMicros =
    rateTokens(uncachedInputTokens, work.price.inputUsdMicrosPerMillionTokens) +
    rateTokens(work.cachedInputTokens, work.price.cachedInputUsdMicrosPerMillionTokens) +
    rateTokens(work.outputTokens, work.price.outputUsdMicrosPerMillionTokens);
  if (ratedCostUsdMicros === 0n) return [];
  return [
    {
      activity: work.activity,
      evidence: {
        cachedInputTokens: work.cachedInputTokens,
        inputTokens: work.inputTokens,
        outputTokens: work.outputTokens,
        priceEntryId: work.price.priceEntryId,
      },
      ratedCostUsdMicros,
      resourcePriceVersion: work.price.resourcePriceVersion,
    },
  ];
};

const recognizedModelPrices = Schema.decodeSync(Schema.Array(ManagedModelPrice))([
  {
    cachedInputUsdMicrosPerMillionTokens: 1_000_000n,
    inputUsdMicrosPerMillionTokens: 2_000_000n,
    outputUsdMicrosPerMillionTokens: 4_000_000n,
    priceEntryId: "managed-model-routine",
    resourcePriceVersion: "resource-prices-2026-08-22",
  },
  {
    cachedInputUsdMicrosPerMillionTokens: 0n,
    inputUsdMicrosPerMillionTokens: 1n,
    outputUsdMicrosPerMillionTokens: 1n,
    priceEntryId: "tiny-model",
    resourcePriceVersion: "resource-prices-2026-08-22",
  },
  {
    cachedInputUsdMicrosPerMillionTokens: 0n,
    inputUsdMicrosPerMillionTokens: 1_000_000n,
    outputUsdMicrosPerMillionTokens: 0n,
    priceEntryId: "old-provider",
    resourcePriceVersion: "prices-v1",
  },
  {
    cachedInputUsdMicrosPerMillionTokens: 0n,
    inputUsdMicrosPerMillionTokens: 2_000_000n,
    outputUsdMicrosPerMillionTokens: 0n,
    priceEntryId: "replacement-provider",
    resourcePriceVersion: "prices-v2",
  },
]);

/** Retained routine managed-model rate used by owned model adapters. */
export const managedModelRoutinePrice = Schema.decodeUnknownSync(ManagedModelPrice)(
  recognizedModelPrices.find(({ priceEntryId }) => priceEntryId === "managed-model-routine"),
);

/** Current retained price authority pinned by newly admitted operations. */
export const currentResourcePriceVersion = ResourcePriceVersion.make("resource-prices-2026-08-22");

const recognizedResourcePriceVersions = new Set([
  ...recognizedModelPrices.map(({ resourcePriceVersion }) => resourcePriceVersion),
  currentResourcePriceVersion,
  ResourcePriceVersion.make(managedSearchPrice.resourcePriceVersion),
]);

const isRecognizedModelPrice = (price: ManagedModelPrice) =>
  recognizedModelPrices.some(
    (entry) =>
      entry.resourcePriceVersion === price.resourcePriceVersion &&
      entry.priceEntryId === price.priceEntryId &&
      entry.inputUsdMicrosPerMillionTokens === price.inputUsdMicrosPerMillionTokens &&
      entry.cachedInputUsdMicrosPerMillionTokens === price.cachedInputUsdMicrosPerMillionTokens &&
      entry.outputUsdMicrosPerMillionTokens === price.outputUsdMicrosPerMillionTokens,
  );

const rateTokens = (tokens: bigint, usdMicrosPerMillionTokens: bigint): bigint => {
  const numerator = tokens * usdMicrosPerMillionTokens;
  return numerator === 0n ? 0n : (numerator + 999_999n) / 1_000_000n;
};

const convertRatedCost = (policy: SharedUsagePlanPolicy, ratedCostUsdMicros: bigint): bigint =>
  ratedCostUsdMicros * policy.ratedCostUsdMicroToPlanUsageMicro;

const ratingFailure = (
  usagePolicyVersion: PlanPolicyVersion,
  reason: UsageRatingFailed["reason"],
  message: string,
) => new UsageRatingFailed({ message, reason, usagePolicyVersion });

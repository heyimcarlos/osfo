import { Schema } from "effect";

const requiredWorkloads = [
  "calendar",
  "drive",
  "ordinarySearch",
  "researchReports",
  "pdf",
  "docx",
  "pptx",
  "images",
  "diagrams",
  "integrations",
  "workflows",
  "skillLearning",
  "exhaustedConversation",
  "connectorFallbackReads",
] as const;

const CostEvidence = Schema.NullOr(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)));
const CountEvidence = Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)));
const evidenceReference = Schema.String.check(Schema.isMinLength(1));

/** Hidden positive all-in Company Cost ceiling expressed in integer USD micros. */
export const CompanyCostBackstopUsdMicros = Schema.BigInt.check(
  Schema.isGreaterThanBigInt(0n),
).pipe(Schema.brand("CompanyCostBackstopUsdMicros"));

/** Source-controlled hidden period backstops. These are never User entitlements. */
export const companyCostBackstops = Schema.decodeSync(
  Schema.Struct({
    adventurer: CompanyCostBackstopUsdMicros,
    free: CompanyCostBackstopUsdMicros,
  }),
)({ adventurer: 12_000_000n, free: 5_000_000n });

/** Complete measured evidence required to activate shared Plan Usage. */
export const EconomicsEvidence = Schema.Struct({
  adventurerIncludedUsageUsdMicros: CostEvidence,
  adventurerConcurrentAdmissions: CountEvidence,
  adventurerMaximumOperationUsdMicros: CostEvidence,
  adventurerNonUsageCostUsdMicros: CostEvidence,
  adventurerRevenueUsdMicrosAtConservativeFx: CostEvidence,
  fixedAndIdleCostUsdMicros: CostEvidence,
  freeIncludedUsageUsdMicros: CostEvidence,
  freeConcurrentAdmissions: CountEvidence,
  freeMaximumOperationUsdMicros: CostEvidence,
  freeOtherCompanyCostUsdMicros: CostEvidence,
  gmSummonExpectedCostUsdMicros: CostEvidence,
  paymentCostUsdMicros: CostEvidence,
  sources: Schema.Array(
    Schema.Struct({
      observedAt: Schema.Date,
      reference: evidenceReference,
      source: Schema.Literals(["bill", "primarySource"]),
    }),
  ),
  supportCostUsdMicros: CostEvidence,
  workloadMeasurements: Schema.Array(
    Schema.Struct({
      evidenceReference,
      measuredCostUsdMicros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
      workload: Schema.Literals(requiredWorkloads),
    }),
  ),
});

export type EconomicsEvidence = typeof EconomicsEvidence.Type;

type PlanGate = {
  readonly allInCostUsdMicros: bigint | null;
  readonly status: "FAIL" | "MISSING" | "PASS";
  readonly stressedVariableCostUsdMicros: bigint | null;
};

export type EconomicsGateResult = {
  readonly adventurer: PlanGate;
  readonly free: PlanGate;
  readonly missing: ReadonlyArray<string>;
  readonly status: "FAIL" | "MISSING" | "PASS";
};

const costFields = [
  "adventurerIncludedUsageUsdMicros",
  "adventurerMaximumOperationUsdMicros",
  "adventurerNonUsageCostUsdMicros",
  "adventurerRevenueUsdMicrosAtConservativeFx",
  "fixedAndIdleCostUsdMicros",
  "freeIncludedUsageUsdMicros",
  "freeMaximumOperationUsdMicros",
  "freeOtherCompanyCostUsdMicros",
  "gmSummonExpectedCostUsdMicros",
  "paymentCostUsdMicros",
  "supportCostUsdMicros",
] as const;

/** Evaluate both Plans with exact integer costs and the immutable 15% provider stress. */
export const evaluateEconomics = (evidence: EconomicsEvidence, now: Date): EconomicsGateResult => {
  const missing: Array<string> = costFields.filter((field) => evidence[field] === null);
  if (evidence.adventurerConcurrentAdmissions === null) {
    missing.push("adventurerConcurrentAdmissions");
  }
  if (evidence.freeConcurrentAdmissions === null) missing.push("freeConcurrentAdmissions");
  const measured = new Set(evidence.workloadMeasurements.map(({ workload }) => workload));
  for (const workload of requiredWorkloads) {
    if (!measured.has(workload)) missing.push(`workload:${workload}`);
  }
  if (evidence.sources.length === 0) missing.push("traceablePriceSources");
  const freshnessBoundary = now.getTime() - 30 * 24 * 60 * 60 * 1_000;
  if (evidence.sources.some(({ observedAt }) => observedAt.getTime() < freshnessBoundary)) {
    missing.push("priceSourceFreshness");
  }
  if (missing.length > 0) {
    const plan = {
      allInCostUsdMicros: null,
      status: "MISSING" as const,
      stressedVariableCostUsdMicros: null,
    };
    return { adventurer: plan, free: plan, missing, status: "MISSING" };
  }

  const values = requireCosts(evidence);
  const freeVariable = stress(
    values.freeIncludedUsageUsdMicros + values.freeMaximumOvershootUsdMicros,
  );
  const freeAllIn =
    freeVariable +
    values.fixedAndIdleCostUsdMicros +
    values.freeOtherCompanyCostUsdMicros +
    values.supportCostUsdMicros;
  const adventurerVariable = stress(
    values.adventurerIncludedUsageUsdMicros + values.adventurerMaximumOvershootUsdMicros,
  );
  const adventurerAllIn =
    adventurerVariable +
    values.adventurerNonUsageCostUsdMicros +
    values.paymentCostUsdMicros +
    values.supportCostUsdMicros +
    values.gmSummonExpectedCostUsdMicros;
  const freeStatus = freeAllIn <= companyCostBackstops.free ? "PASS" : "FAIL";
  const adventurerStatus =
    adventurerAllIn <= companyCostBackstops.adventurer &&
    (values.adventurerRevenueUsdMicrosAtConservativeFx - adventurerAllIn) * 2n >=
      values.adventurerRevenueUsdMicrosAtConservativeFx
      ? "PASS"
      : "FAIL";
  return {
    adventurer: {
      allInCostUsdMicros: adventurerAllIn,
      status: adventurerStatus,
      stressedVariableCostUsdMicros: adventurerVariable,
    },
    free: {
      allInCostUsdMicros: freeAllIn,
      status: freeStatus,
      stressedVariableCostUsdMicros: freeVariable,
    },
    missing: [],
    status: freeStatus === "PASS" && adventurerStatus === "PASS" ? "PASS" : "FAIL",
  };
};

const stress = (costUsdMicros: bigint) => (costUsdMicros * 115n + 99n) / 100n;

const requireCost = (value: bigint | null) => {
  if (value === null) throw new Error("Economics cost evidence was checked before evaluation");
  return value;
};

const requireCosts = (evidence: EconomicsEvidence) => {
  const freeConcurrentAdmissions = requireCount(evidence.freeConcurrentAdmissions);
  const adventurerConcurrentAdmissions = requireCount(evidence.adventurerConcurrentAdmissions);
  return {
    adventurerIncludedUsageUsdMicros: requireCost(evidence.adventurerIncludedUsageUsdMicros),
    adventurerMaximumOvershootUsdMicros:
      requireCost(evidence.adventurerMaximumOperationUsdMicros) *
      BigInt(adventurerConcurrentAdmissions),
    adventurerNonUsageCostUsdMicros: requireCost(evidence.adventurerNonUsageCostUsdMicros),
    adventurerRevenueUsdMicrosAtConservativeFx: requireCost(
      evidence.adventurerRevenueUsdMicrosAtConservativeFx,
    ),
    fixedAndIdleCostUsdMicros: requireCost(evidence.fixedAndIdleCostUsdMicros),
    freeIncludedUsageUsdMicros: requireCost(evidence.freeIncludedUsageUsdMicros),
    freeMaximumOvershootUsdMicros:
      requireCost(evidence.freeMaximumOperationUsdMicros) * BigInt(freeConcurrentAdmissions),
    freeOtherCompanyCostUsdMicros: requireCost(evidence.freeOtherCompanyCostUsdMicros),
    gmSummonExpectedCostUsdMicros: requireCost(evidence.gmSummonExpectedCostUsdMicros),
    paymentCostUsdMicros: requireCost(evidence.paymentCostUsdMicros),
    supportCostUsdMicros: requireCost(evidence.supportCostUsdMicros),
  };
};

const requireCount = (value: number | null) => {
  if (value === null) throw new Error("Economics count evidence was checked before evaluation");
  return value;
};

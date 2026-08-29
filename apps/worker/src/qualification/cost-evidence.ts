import type { ReferenceJourney } from "./qualification-manifest";
import type { SemanticComponent } from "./semantic-evidence";
import { qualificationChecksum } from "./qualification-checksum";
import {
  assessmentFromFindings,
  type QualificationFinding,
  type QualificationVerdict,
} from "./verdict";

/** Every material all-in production cost category required by the specification. */
export const requiredCostCategories = [
  "platform",
  "model",
  "search",
  "supermemory",
  "whatsapp",
  "file",
  "taskCompute",
  "storage",
  "backup",
  "observability",
  "payment",
  "support",
  "expectedGmSummon",
  "idle",
  "failure",
  "retry",
  "recovery",
  "retention",
  "teardown",
] as const;

/** One required category in the all-in production economics gate. */
export type CostCategory = (typeof requiredCostCategories)[number];

/** Product authority that owns the raw quantity for each material cost category. */
export const costCategoryAuthorities = {
  backup: "R2",
  expectedGmSummon: "ModelAccess",
  failure: "Provider",
  file: "R2",
  idle: "AgentActivation",
  model: "ModelAccess",
  observability: "Worker",
  payment: "PostgreSQL",
  platform: "Worker",
  recovery: "AgentActivation",
  retention: "R2",
  retry: "Think",
  search: "ModelAccess",
  storage: "R2",
  supermemory: "Memory",
  support: "PostgreSQL",
  taskCompute: "TaskCompute",
  teardown: "Worker",
  whatsapp: "WhatsApp",
} as const satisfies Readonly<Record<CostCategory, SemanticComponent>>;

/** Frozen price-book unit for one material production cost category. */
export type PriceUnit =
  | "usdMicrosPerByteMonth"
  | "usdMicrosPerEvent"
  | "usdMicrosPerMinute"
  | "usdMicrosPerOperation"
  | "usdMicrosPerPeriod"
  | "usdMicrosPerRequest"
  | "usdMicrosPerToken";

/** One observed price-book entry with an explicit comparable unit. */
export interface PriceBookEntry {
  readonly category: CostCategory;
  readonly priceUsdMicros: bigint;
  readonly unit: PriceUnit;
}

/** Required comparable price unit for every material category. */
export const requiredPriceUnits = {
  backup: "usdMicrosPerByteMonth",
  expectedGmSummon: "usdMicrosPerEvent",
  failure: "usdMicrosPerOperation",
  file: "usdMicrosPerByteMonth",
  idle: "usdMicrosPerMinute",
  model: "usdMicrosPerToken",
  observability: "usdMicrosPerEvent",
  payment: "usdMicrosPerPeriod",
  platform: "usdMicrosPerRequest",
  recovery: "usdMicrosPerOperation",
  retention: "usdMicrosPerByteMonth",
  retry: "usdMicrosPerOperation",
  search: "usdMicrosPerRequest",
  storage: "usdMicrosPerByteMonth",
  supermemory: "usdMicrosPerToken",
  support: "usdMicrosPerPeriod",
  taskCompute: "usdMicrosPerMinute",
  teardown: "usdMicrosPerOperation",
  whatsapp: "usdMicrosPerEvent",
} satisfies Readonly<Record<CostCategory, PriceUnit>>;

/** Raw measured usage priced by one exact price-book entry. */
export interface CostUsageLine {
  readonly category: CostCategory;
  readonly quantity: bigint;
  readonly sourceProductFactId: string;
  readonly unit: PriceUnit;
  readonly usdMicros: bigint;
  readonly usageId: string;
}

/** Root-bound all-in usage attribution from one reconciled cost ledger. */
export interface RootCostReconciliation {
  readonly allowancePeriodId: string;
  readonly costReconciliationId: string;
  readonly journey: ReferenceJourney;
  readonly plan: "adventurer" | "free";
  readonly priceBookId: string;
  readonly rootId: string;
  readonly usage: ReadonlyArray<CostUsageLine>;
}

/** One measured allowance period that owns root costs and plan revenue. */
export interface CostCohortPeriod {
  readonly allowancePeriodId: string;
  readonly plan: "adventurer" | "free";
  readonly revenueUsdMicros: bigint;
}

/** One raw line retained from the independent monthly provider invoice. */
export interface ProviderBillLine {
  readonly category: CostCategory;
  readonly provider: string;
  readonly quantity: bigint;
  readonly unit: PriceUnit;
  readonly usageId: string;
  readonly usdMicros: bigint;
}

/** Raw scenario usage used to reproduce one monthly cost model. */
export interface ScenarioCostEvidence {
  readonly denominator: number;
  readonly dimension: "betaMonth" | "growthDepthMonth" | "growthWidthMonth" | "publicMonth";
  readonly priceBookId: string;
  readonly usage: ReadonlyArray<CostUsageLine>;
}

/** Raw provider usage row retained independently from the reconciled cost views. */
export interface CostUsageAuthorityRecord extends CostUsageLine {
  readonly provider: string;
  readonly scope: "root" | "scenario";
  readonly subject: string;
}

/** Required cost view derived from root or scenario usage. */
export interface CostSummaryEvidence {
  readonly dimension:
    | "acceptedMessage"
    | "betaMonth"
    | "growthDepthMonth"
    | "growthWidthMonth"
    | "publicMonth"
    | `goodRootOutcome:${ReferenceJourney}`
    | "planPeriod:adventurer"
    | "planPeriod:free";
  readonly denominator: number;
  readonly totalUsdMicros: bigint;
}

/** Complete price, raw usage, attribution, and billed-usage evidence. */
export interface CostEvidence {
  readonly activeAdventurerPeriods: number;
  readonly activeFreePeriods: number;
  readonly adventurerRevenueUsdMicros: bigint;
  readonly billedUsageUsdMicros?: bigint;
  readonly billedUsageArtifactChecksum?: string;
  readonly billedUsageArtifactId?: string;
  readonly billedUsageInvoiceId?: string;
  readonly billedUsageLines?: ReadonlyArray<ProviderBillLine>;
  readonly billedUsageProvider?: string;
  readonly billingMonthEndedAtUtc?: string;
  readonly billingMonthStartedAtUtc?: string;
  readonly cohortPeriods: ReadonlyArray<CostCohortPeriod>;
  readonly economicsArtifactChecksum: string;
  readonly economicsArtifactId: string;
  readonly economicsSource: string;
  readonly economicsWindowEndedAtUtc: string;
  readonly economicsWindowStartedAtUtc: string;
  readonly evaluatedAtEpochMs: number;
  readonly foreignExchangeUsdMicros: bigint;
  readonly goodRootOutcomeIds: ReadonlyArray<string>;
  readonly priceBook: ReadonlyArray<PriceBookEntry>;
  readonly priceBookArtifactChecksum: string;
  readonly priceBookArtifactId: string;
  readonly priceBookId: string;
  readonly priceBookSource: string;
  readonly priceBookVersion: string;
  readonly pricesObservedAtEpochMs: number;
  readonly rootCosts: ReadonlyArray<RootCostReconciliation>;
  readonly scenarios: ReadonlyArray<ScenarioCostEvidence>;
  readonly usageLedgerArtifactChecksum: string;
  readonly usageLedgerArtifactId: string;
  readonly usageLedgerSource: string;
  readonly usageLedgerWindowEndedAtUtc: string;
  readonly usageLedgerWindowStartedAtUtc: string;
  readonly usageAuthorityArtifactChecksum: string;
  readonly usageAuthorityArtifactId: string;
  readonly usageAuthorityRecords: ReadonlyArray<CostUsageAuthorityRecord>;
  readonly usageAuthoritySource: string;
  readonly usageAuthoritySourceVersion: string;
  readonly usageAuthorityWindowEndedAtUtc: string;
  readonly usageAuthorityWindowStartedAtUtc: string;
  readonly taxesUsdMicros: bigint;
}

/** Cost verdict and every summary derived from the reconciled ledger. */
export interface CostAssessment {
  readonly adventurerContributionMargin: number | null;
  readonly findings: ReadonlyArray<QualificationFinding>;
  readonly foreignExchangeUsdMicros: bigint;
  readonly freeCostPerActivePeriodUsdMicros: bigint | null;
  readonly priceBookId: string;
  readonly reconciledRootCostIds: ReadonlyArray<string>;
  readonly summaries: ReadonlyArray<CostSummaryEvidence>;
  readonly taxesUsdMicros: bigint;
  readonly verdict: QualificationVerdict;
}

const requiredJourneys: ReadonlyArray<ReferenceJourney> = [
  "registration",
  "ordinaryConversation",
  "fileAnalysis",
  "reminder",
  "gmail",
  "researchReport",
  "documentBuild",
  "scheduledEmail",
  "accountBillingSafetyDataRights",
];
const scenarioDimensions = [
  "betaMonth",
  "publicMonth",
  "growthWidthMonth",
  "growthDepthMonth",
] as const;
const usageTotal = (usage: ReadonlyArray<CostUsageLine>): bigint =>
  usage.reduce((total, line) => total + line.usdMicros, 0n);
const costFinding = (
  code: string,
  detail: string,
  subject: string,
  verdict: QualificationFinding["verdict"],
): QualificationFinding => ({ code, detail, subject, verdict });

const usageAuthorityKey = (
  scope: CostUsageAuthorityRecord["scope"],
  subject: string,
  line: CostUsageLine,
): string =>
  [
    scope,
    subject,
    line.category,
    line.quantity,
    line.sourceProductFactId,
    line.unit,
    line.usageId,
    line.usdMicros,
  ].join("\u001f");

const providerBillKey = (
  line: Pick<
    ProviderBillLine,
    "category" | "provider" | "quantity" | "unit" | "usageId" | "usdMicros"
  >,
): string =>
  [line.category, line.provider, line.quantity, line.unit, line.usageId, line.usdMicros].join(
    "\u001f",
  );

/** Reconcile raw usage against one price book and derive every economics measure. */
export const assessCostEvidence = (evidence: CostEvidence): CostAssessment => {
  const findings: Array<QualificationFinding> = [];
  const reconciledUsage = [
    ...evidence.rootCosts.flatMap((record) =>
      record.usage.map((line) => ({ line, scope: "root" as const, subject: record.rootId })),
    ),
    ...evidence.scenarios.flatMap((record) =>
      record.usage.map((line) => ({ line, scope: "scenario" as const, subject: record.dimension })),
    ),
  ];
  const authorityRecordCounts = new Map<string, number>();
  for (const record of evidence.usageAuthorityRecords) {
    if (record.provider.length === 0) continue;
    const key = usageAuthorityKey(record.scope, record.subject, record);
    authorityRecordCounts.set(key, (authorityRecordCounts.get(key) ?? 0) + 1);
  }
  const usageAuthorityInvalid =
    evidence.usageAuthorityArtifactId.length === 0 ||
    evidence.usageAuthoritySource.length === 0 ||
    evidence.usageAuthoritySourceVersion.length === 0 ||
    Date.parse(evidence.usageAuthorityWindowEndedAtUtc) <=
      Date.parse(evidence.usageAuthorityWindowStartedAtUtc) ||
    evidence.usageAuthorityArtifactChecksum !==
      qualificationChecksum({
        artifactId: evidence.usageAuthorityArtifactId,
        records: evidence.usageAuthorityRecords,
        source: evidence.usageAuthoritySource,
        sourceVersion: evidence.usageAuthoritySourceVersion,
        windowEndedAtUtc: evidence.usageAuthorityWindowEndedAtUtc,
        windowStartedAtUtc: evidence.usageAuthorityWindowStartedAtUtc,
      }) ||
    evidence.usageAuthorityRecords.length !== reconciledUsage.length ||
    reconciledUsage.some(
      ({ line, scope, subject }) =>
        authorityRecordCounts.get(usageAuthorityKey(scope, subject, line)) !== 1,
    );
  if (usageAuthorityInvalid) {
    findings.push(
      costFinding(
        "usageAuthorityArtifactMissing",
        "Root and scenario quantities do not match one retained provider usage export",
        "usageAuthority",
        "MISSING",
      ),
    );
  }
  if (
    evidence.economicsArtifactId.length === 0 ||
    evidence.economicsArtifactChecksum !==
      qualificationChecksum({
        activeAdventurerPeriods: evidence.activeAdventurerPeriods,
        activeFreePeriods: evidence.activeFreePeriods,
        adventurerRevenueUsdMicros: evidence.adventurerRevenueUsdMicros,
        artifactId: evidence.economicsArtifactId,
        cohortPeriods: evidence.cohortPeriods,
        foreignExchangeUsdMicros: evidence.foreignExchangeUsdMicros,
        goodRootOutcomeIds: evidence.goodRootOutcomeIds,
        source: evidence.economicsSource,
        taxesUsdMicros: evidence.taxesUsdMicros,
        windowEndedAtUtc: evidence.economicsWindowEndedAtUtc,
        windowStartedAtUtc: evidence.economicsWindowStartedAtUtc,
      })
  ) {
    findings.push(
      costFinding(
        "economicsArtifactInvalid",
        "Plan cohort, Good Root, tax, and foreign-exchange facts are not bound to one authority artifact",
        "economics",
        "MISSING",
      ),
    );
  }
  if (
    evidence.priceBookArtifactId.length === 0 ||
    evidence.priceBookArtifactChecksum !==
      qualificationChecksum({
        artifactId: evidence.priceBookArtifactId,
        observedAtEpochMs: evidence.pricesObservedAtEpochMs,
        priceBook: evidence.priceBook,
        priceBookId: evidence.priceBookId,
        source: evidence.priceBookSource,
        version: evidence.priceBookVersion,
      })
  ) {
    findings.push(
      costFinding(
        "priceBookArtifactInvalid",
        "The price book is not bound to its retained provider source artifact",
        "priceBook",
        "MISSING",
      ),
    );
  }
  if (
    evidence.usageLedgerArtifactId.length === 0 ||
    evidence.usageLedgerArtifactChecksum !==
      qualificationChecksum({
        artifactId: evidence.usageLedgerArtifactId,
        rootCosts: evidence.rootCosts,
        scenarios: evidence.scenarios,
        source: evidence.usageLedgerSource,
        windowEndedAtUtc: evidence.usageLedgerWindowEndedAtUtc,
        windowStartedAtUtc: evidence.usageLedgerWindowStartedAtUtc,
      })
  ) {
    findings.push(
      costFinding(
        "usageLedgerArtifactInvalid",
        "The raw usage ledger is not bound to its retained authority artifact",
        "costLedger",
        "MISSING",
      ),
    );
  }
  const prices = new Map(evidence.priceBook.map((entry) => [entry.category, entry]));
  for (const category of requiredCostCategories) {
    const entries = evidence.priceBook.filter((entry) => entry.category === category);
    if (entries.length === 0) {
      findings.push(
        costFinding(
          "priceBookEntryMissing",
          `${category} has no frozen price-book entry`,
          category,
          "MISSING",
        ),
      );
    } else if (
      entries.length > 1 ||
      entries[0]?.unit !== requiredPriceUnits[category] ||
      (entries[0]?.priceUsdMicros ?? -1n) < 0n
    ) {
      findings.push(
        costFinding(
          "priceBookEntryInvalid",
          `${category} has duplicate, negative, or mixed-unit price evidence`,
          category,
          "FAIL",
        ),
      );
    }
  }
  const allUsage = [
    ...evidence.rootCosts.flatMap((record) => record.usage),
    ...evidence.scenarios.flatMap((record) => record.usage),
  ];
  const usageIds = new Set<string>();
  for (const line of allUsage) {
    const price = prices.get(line.category);
    if (
      line.usageId.length === 0 ||
      line.sourceProductFactId.length === 0 ||
      usageIds.has(line.usageId) ||
      line.quantity < 0n ||
      line.usdMicros < 0n ||
      price === undefined ||
      line.unit !== price.unit ||
      line.usdMicros !== line.quantity * price.priceUsdMicros
    ) {
      findings.push(
        costFinding(
          "costUsageInvalid",
          `${line.usageId || line.category} is duplicate, negative, or not derived from the frozen price book`,
          line.usageId || line.category,
          "FAIL",
        ),
      );
    }
    usageIds.add(line.usageId);
  }
  for (const category of requiredCostCategories) {
    if (
      !evidence.rootCosts.some((record) => record.usage.some((line) => line.category === category))
    ) {
      findings.push(
        costFinding(
          "rootCostCategoryMissing",
          `${category} has no root-attributed usage`,
          category,
          "MISSING",
        ),
      );
    }
  }
  const rootIds = new Set<string>();
  const reconciliationIds = new Set<string>();
  for (const record of evidence.rootCosts) {
    if (
      record.rootId.length === 0 ||
      record.allowancePeriodId.length === 0 ||
      record.costReconciliationId.length === 0 ||
      record.priceBookId !== evidence.priceBookId ||
      record.usage.length === 0 ||
      rootIds.has(record.rootId) ||
      reconciliationIds.has(record.costReconciliationId)
    ) {
      findings.push(
        costFinding(
          "rootCostReconciliationInvalid",
          `${record.rootId} has duplicate, empty, or unbound all-in cost evidence`,
          record.rootId,
          "FAIL",
        ),
      );
    }
    rootIds.add(record.rootId);
    reconciliationIds.add(record.costReconciliationId);
  }
  const goodRootIds = new Set(evidence.goodRootOutcomeIds);
  if (
    goodRootIds.size !== evidence.goodRootOutcomeIds.length ||
    evidence.goodRootOutcomeIds.some((rootId) => !rootIds.has(rootId))
  ) {
    findings.push(
      costFinding(
        "goodRootCostCorpusInvalid",
        "Good Root Outcome cost identities are duplicate or outside the root cost ledger",
        "goodRootOutcomes",
        "FAIL",
      ),
    );
  }
  for (const dimension of scenarioDimensions) {
    const records = evidence.scenarios.filter((record) => record.dimension === dimension);
    if (records.length === 0) {
      findings.push(
        costFinding(
          "scenarioCostEvidenceMissing",
          `${dimension} has no raw scenario usage`,
          dimension,
          "MISSING",
        ),
      );
    } else if (
      records.length > 1 ||
      (records[0]?.denominator ?? 0) < 1 ||
      !Number.isInteger(records[0]?.denominator) ||
      records[0]?.priceBookId !== evidence.priceBookId ||
      records[0]?.usage.length === 0
    ) {
      findings.push(
        costFinding(
          "scenarioCostEvidenceInvalid",
          `${dimension} has duplicate, empty, or unbound scenario usage`,
          dimension,
          "FAIL",
        ),
      );
    }
  }
  const rootBilledUsage = evidence.rootCosts.reduce(
    (total, record) => total + usageTotal(record.usage),
    0n,
  );
  const rootAuthorityBillCounts = new Map<string, number>();
  for (const record of evidence.usageAuthorityRecords) {
    if (record.scope !== "root") continue;
    const key = providerBillKey(record);
    rootAuthorityBillCounts.set(key, (rootAuthorityBillCounts.get(key) ?? 0) + 1);
  }
  if (evidence.billedUsageUsdMicros === undefined) {
    findings.push(
      costFinding(
        "billedUsageMissing",
        "Billed usage was not supplied for reconciliation",
        "costReconciliation",
        "MISSING",
      ),
    );
  } else if (
    evidence.billedUsageArtifactId === undefined ||
    evidence.billedUsageArtifactChecksum === undefined ||
    evidence.billedUsageInvoiceId === undefined ||
    evidence.billedUsageLines === undefined ||
    evidence.billedUsageLines.length === 0 ||
    evidence.billedUsageProvider === undefined ||
    evidence.billingMonthStartedAtUtc === undefined ||
    evidence.billingMonthEndedAtUtc === undefined
  ) {
    findings.push(
      costFinding(
        "billedUsageArtifactMissing",
        "Billed usage has no retained provider bill artifact",
        "costReconciliation",
        "MISSING",
      ),
    );
  } else {
    const providerBillCounts = new Map<string, number>();
    for (const line of evidence.billedUsageLines) {
      const key = providerBillKey(line);
      providerBillCounts.set(key, (providerBillCounts.get(key) ?? 0) + 1);
    }
    const billLinesMatchAuthority =
      evidence.billedUsageLines.length ===
        evidence.usageAuthorityRecords.filter(({ scope }) => scope === "root").length &&
      [...rootAuthorityBillCounts].every(([key, count]) => providerBillCounts.get(key) === count) &&
      [...providerBillCounts].every(([key, count]) => rootAuthorityBillCounts.get(key) === count);
    if (
      evidence.billedUsageArtifactChecksum !==
        qualificationChecksum({
          artifactId: evidence.billedUsageArtifactId,
          invoiceId: evidence.billedUsageInvoiceId,
          lines: evidence.billedUsageLines,
          monthEndedAtUtc: evidence.billingMonthEndedAtUtc,
          monthStartedAtUtc: evidence.billingMonthStartedAtUtc,
          priceBookId: evidence.priceBookId,
          provider: evidence.billedUsageProvider,
        }) ||
      evidence.billedUsageLines.reduce((total, line) => total + line.usdMicros, 0n) !==
        evidence.billedUsageUsdMicros ||
      evidence.billedUsageLines.some(
        (line) =>
          line.quantity < 0n ||
          line.usdMicros < 0n ||
          line.provider.length === 0 ||
          line.usageId.length === 0 ||
          line.unit !== requiredPriceUnits[line.category],
      ) ||
      !billLinesMatchAuthority ||
      evidence.billedUsageUsdMicros !== rootBilledUsage ||
      Date.parse(evidence.billingMonthEndedAtUtc) <= Date.parse(evidence.billingMonthStartedAtUtc)
    ) {
      findings.push(
        costFinding(
          "costReconciliationMismatch",
          `Derived ${rootBilledUsage} USD micros does not match the exact retained provider bill lines`,
          "costReconciliation",
          "FAIL",
        ),
      );
    }
  }
  if (
    evidence.priceBookId.length === 0 ||
    evidence.priceBookSource.length === 0 ||
    evidence.priceBookVersion.length === 0 ||
    evidence.economicsSource.length === 0 ||
    evidence.usageLedgerSource.length === 0 ||
    Date.parse(evidence.economicsWindowEndedAtUtc) <=
      Date.parse(evidence.economicsWindowStartedAtUtc) ||
    Date.parse(evidence.usageLedgerWindowEndedAtUtc) <=
      Date.parse(evidence.usageLedgerWindowStartedAtUtc) ||
    evidence.activeFreePeriods < 0 ||
    evidence.activeAdventurerPeriods < 0 ||
    !Number.isInteger(evidence.activeFreePeriods) ||
    !Number.isInteger(evidence.activeAdventurerPeriods) ||
    evidence.adventurerRevenueUsdMicros < 0n ||
    evidence.taxesUsdMicros < 0n ||
    evidence.foreignExchangeUsdMicros < 0n
  ) {
    findings.push(
      costFinding(
        "invalidCostEvidence",
        "Cost evidence contains an invalid price-book identity, amount, or denominator",
        "costEvidence",
        "FAIL",
      ),
    );
  }
  const maximumPriceAgeMs = 30 * 24 * 60 * 60 * 1_000;
  if (
    !Number.isFinite(evidence.evaluatedAtEpochMs) ||
    !Number.isFinite(evidence.pricesObservedAtEpochMs) ||
    evidence.pricesObservedAtEpochMs > evidence.evaluatedAtEpochMs
  ) {
    findings.push(
      costFinding(
        "invalidPriceTimestamp",
        "Price evidence has an invalid or future observation time",
        "prices",
        "FAIL",
      ),
    );
  } else if (evidence.evaluatedAtEpochMs - evidence.pricesObservedAtEpochMs > maximumPriceAgeMs) {
    findings.push(
      costFinding(
        "stalePriceEvidence",
        "At least one price is more than 30 days old",
        "prices",
        "MISSING",
      ),
    );
  }
  if (evidence.activeFreePeriods === 0)
    findings.push(
      costFinding(
        "activeFreePeriodsMissing",
        "No active Free allowance period was measured",
        "freeEconomics",
        "MISSING",
      ),
    );
  if (evidence.activeAdventurerPeriods === 0 || evidence.adventurerRevenueUsdMicros === 0n)
    findings.push(
      costFinding(
        "adventurerRevenueMissing",
        "No active Adventurer revenue cohort was measured",
        "adventurerEconomics",
        "MISSING",
      ),
    );

  const freeRecords = evidence.rootCosts.filter((record) => record.plan === "free");
  const adventurerRecords = evidence.rootCosts.filter((record) => record.plan === "adventurer");
  const cohortByPeriod = new Map(
    evidence.cohortPeriods.map((period) => [period.allowancePeriodId, period]),
  );
  const cohortValid =
    cohortByPeriod.size === evidence.cohortPeriods.length &&
    evidence.cohortPeriods.every(
      (period) => period.allowancePeriodId.length > 0 && period.revenueUsdMicros >= 0n,
    ) &&
    evidence.rootCosts.every((record) => {
      const period = cohortByPeriod.get(record.allowancePeriodId);
      return period !== undefined && period.plan === record.plan;
    });
  const derivedFreePeriods = evidence.cohortPeriods.filter(
    (period) => period.plan === "free",
  ).length;
  const derivedAdventurerPeriods = evidence.cohortPeriods.filter(
    (period) => period.plan === "adventurer",
  ).length;
  const derivedAdventurerRevenue = evidence.cohortPeriods.reduce(
    (total, period) => total + (period.plan === "adventurer" ? period.revenueUsdMicros : 0n),
    0n,
  );
  if (
    !cohortValid ||
    evidence.activeFreePeriods !== derivedFreePeriods ||
    evidence.activeAdventurerPeriods !== derivedAdventurerPeriods ||
    evidence.adventurerRevenueUsdMicros !== derivedAdventurerRevenue
  ) {
    findings.push(
      costFinding(
        "costCohortEvidenceConflict",
        "Plan periods, revenue, and root costs are not bound to one measured cohort",
        "costCohort",
        "FAIL",
      ),
    );
  }
  const freeCost = freeRecords.reduce((total, record) => total + usageTotal(record.usage), 0n);
  const adventurerCost = adventurerRecords.reduce(
    (total, record) => total + usageTotal(record.usage),
    0n,
  );
  const summaries: Array<CostSummaryEvidence> = [
    {
      denominator: evidence.rootCosts.length,
      dimension: "acceptedMessage",
      totalUsdMicros: rootBilledUsage,
    },
    {
      denominator: evidence.activeFreePeriods,
      dimension: "planPeriod:free",
      totalUsdMicros: freeCost,
    },
    {
      denominator: evidence.activeAdventurerPeriods,
      dimension: "planPeriod:adventurer",
      totalUsdMicros: adventurerCost,
    },
    ...scenarioDimensions.flatMap((dimension) => {
      const record = evidence.scenarios.find((candidate) => candidate.dimension === dimension);
      return record === undefined
        ? []
        : [
            {
              denominator: record.denominator,
              dimension,
              totalUsdMicros: usageTotal(record.usage),
            },
          ];
    }),
    ...requiredJourneys.map((journey): CostSummaryEvidence => {
      const records = evidence.rootCosts.filter(
        (record) => record.journey === journey && goodRootIds.has(record.rootId),
      );
      if (records.length === 0) {
        findings.push(
          costFinding(
            "journeyCostEvidenceMissing",
            `${journey} has no root-attributed Good Root Outcome cost`,
            journey,
            "MISSING",
          ),
        );
      }
      return {
        denominator: records.length,
        dimension: `goodRootOutcome:${journey}`,
        totalUsdMicros: records.reduce((total, record) => total + usageTotal(record.usage), 0n),
      };
    }),
  ];
  const freeCostPerActivePeriodUsdMicros =
    evidence.activeFreePeriods === 0 ? null : freeCost / BigInt(evidence.activeFreePeriods);
  const adventurerContributionMargin =
    evidence.adventurerRevenueUsdMicros === 0n
      ? null
      : Number(evidence.adventurerRevenueUsdMicros - adventurerCost) /
        Number(evidence.adventurerRevenueUsdMicros);
  if (evidence.activeFreePeriods > 0 && freeCost > BigInt(evidence.activeFreePeriods) * 500_000n)
    findings.push(
      costFinding(
        "freePeriodCostExceeded",
        `Active Free period cost was ${freeCostPerActivePeriodUsdMicros} USD micros`,
        "freeEconomics",
        "FAIL",
      ),
    );
  if (
    evidence.adventurerRevenueUsdMicros > 0n &&
    adventurerCost * 2n > evidence.adventurerRevenueUsdMicros
  )
    findings.push(
      costFinding(
        "adventurerContributionMarginMissed",
        `Adventurer cost was ${adventurerCost} of ${evidence.adventurerRevenueUsdMicros} USD micros revenue`,
        "adventurerEconomics",
        "FAIL",
      ),
    );
  return {
    ...assessmentFromFindings(findings),
    adventurerContributionMargin,
    foreignExchangeUsdMicros: evidence.foreignExchangeUsdMicros,
    freeCostPerActivePeriodUsdMicros,
    priceBookId: evidence.priceBookId,
    reconciledRootCostIds: evidence.rootCosts.map((record) => record.costReconciliationId),
    summaries,
    taxesUsdMicros: evidence.taxesUsdMicros,
  };
};

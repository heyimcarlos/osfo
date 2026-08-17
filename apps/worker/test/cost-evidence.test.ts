import { describe, expect, it } from "@effect/vitest";

import {
  assessCostEvidence,
  requiredCostCategories,
  requiredPriceUnits,
  type CostEvidence,
} from "../src/qualification/cost-evidence";
import { qualificationChecksum } from "../src/qualification/qualification-checksum";

describe("Qualification cost evidence", () => {
  it("derives summaries and economics from raw root and scenario usage", () => {
    const evidence = completeCostEvidence();
    expect(assessCostEvidence(evidence)).toMatchObject({
      adventurerContributionMargin: 0.999_924,
      findings: [],
      foreignExchangeUsdMicros: 0n,
      freeCostPerActivePeriodUsdMicros: 95n,
      priceBookId: "price-book-v1",
      reconciledRootCostIds: { length: 9 },
      summaries: { length: 16 },
      taxesUsdMicros: 0n,
      verdict: "PASS",
    });
  });

  it("rejects usage not derived from the frozen price book", () => {
    const evidence = completeCostEvidence();
    expect(
      assessCostEvidence({
        ...evidence,
        rootCosts: evidence.rootCosts.map((record, index) =>
          index === 0
            ? Object.assign({}, record, {
                usage: record.usage.map((line, lineIndex) =>
                  lineIndex === 0 ? Object.assign({}, line, { usdMicros: 2n }) : line,
                ),
              })
            : record,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ code: "costUsageInvalid" })]),
      verdict: "FAIL",
    });
  });

  it("fails when derived root usage does not equal the provider bill", () => {
    const evidence = completeCostEvidence();
    expect(assessCostEvidence({ ...evidence, billedUsageUsdMicros: 172n })).toMatchObject({
      findings: [expect.objectContaining({ code: "costReconciliationMismatch" })],
      verdict: "FAIL",
    });
  });

  it("returns MISSING for stale prices, a missing bill, or a missing scenario ledger", () => {
    const evidence = completeCostEvidence();
    const { billedUsageUsdMicros: _bill, ...withoutBill } = evidence;
    expect(
      assessCostEvidence({
        ...withoutBill,
        pricesObservedAtEpochMs: Date.parse("2026-07-01T12:00:00.000Z"),
        scenarios: evidence.scenarios.slice(1),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "stalePriceEvidence" }),
        expect.objectContaining({ code: "billedUsageMissing" }),
        expect.objectContaining({ code: "scenarioCostEvidenceMissing" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("reports taxes and foreign exchange separately", () => {
    const evidence = completeCostEvidence();
    const foreignExchangeUsdMicros = 7_000n;
    const taxesUsdMicros = 11_000n;
    expect(
      assessCostEvidence({
        ...evidence,
        economicsArtifactChecksum: qualificationChecksum({
          activeAdventurerPeriods: evidence.activeAdventurerPeriods,
          activeFreePeriods: evidence.activeFreePeriods,
          adventurerRevenueUsdMicros: evidence.adventurerRevenueUsdMicros,
          artifactId: evidence.economicsArtifactId,
          cohortPeriods: evidence.cohortPeriods,
          foreignExchangeUsdMicros,
          goodRootOutcomeIds: evidence.goodRootOutcomeIds,
          source: evidence.economicsSource,
          taxesUsdMicros,
          windowEndedAtUtc: evidence.economicsWindowEndedAtUtc,
          windowStartedAtUtc: evidence.economicsWindowStartedAtUtc,
        }),
        foreignExchangeUsdMicros,
        taxesUsdMicros,
      }),
    ).toMatchObject({
      foreignExchangeUsdMicros: 7_000n,
      taxesUsdMicros: 11_000n,
      verdict: "PASS",
    });
  });

  it("requires independent source artifacts and period-bound plan economics", () => {
    const evidence = completeCostEvidence();
    expect(
      assessCostEvidence({
        ...evidence,
        cohortPeriods: evidence.cohortPeriods.map((period) =>
          period.plan === "free"
            ? Object.assign({}, period, { allowancePeriodId: "unrelated-period" })
            : period,
        ),
        priceBookArtifactChecksum: "fnv1a64:unbound",
        usageLedgerArtifactChecksum: "fnv1a64:unbound",
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "priceBookArtifactInvalid", verdict: "MISSING" }),
        expect.objectContaining({ code: "usageLedgerArtifactInvalid", verdict: "MISSING" }),
        expect.objectContaining({ code: "costCohortEvidenceConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("excludes failed roots from cost-per-Good-Root-Outcome summaries", () => {
    const evidence = completeCostEvidence();
    const failedRoot = evidence.rootCosts.find((record) => record.journey === "registration");
    expect(failedRoot).toBeDefined();
    if (failedRoot === undefined) return;
    const goodRootOutcomeIds = evidence.goodRootOutcomeIds.filter(
      (rootId) => rootId !== failedRoot.rootId,
    );
    const economicsArtifactChecksum = qualificationChecksum({
      activeAdventurerPeriods: evidence.activeAdventurerPeriods,
      activeFreePeriods: evidence.activeFreePeriods,
      adventurerRevenueUsdMicros: evidence.adventurerRevenueUsdMicros,
      artifactId: evidence.economicsArtifactId,
      cohortPeriods: evidence.cohortPeriods,
      foreignExchangeUsdMicros: evidence.foreignExchangeUsdMicros,
      goodRootOutcomeIds,
      source: evidence.economicsSource,
      taxesUsdMicros: evidence.taxesUsdMicros,
      windowEndedAtUtc: evidence.economicsWindowEndedAtUtc,
      windowStartedAtUtc: evidence.economicsWindowStartedAtUtc,
    });
    expect(
      assessCostEvidence({ ...evidence, economicsArtifactChecksum, goodRootOutcomeIds }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "journeyCostEvidenceMissing", subject: "registration" }),
      ]),
      summaries: expect.arrayContaining([
        expect.objectContaining({
          denominator: 0,
          dimension: "goodRootOutcome:registration",
          totalUsdMicros: 0n,
        }),
      ]),
      verdict: "MISSING",
    });
  });
});

const usageFor = (owner: string) =>
  requiredCostCategories.map((category) => ({
    category,
    quantity: 1n,
    sourceProductFactId: owner,
    unit: requiredPriceUnits[category],
    usdMicros: 1n,
    usageId: `${owner}-${category}`,
  }));

const journeys = [
  "registration",
  "ordinaryConversation",
  "fileAnalysis",
  "reminder",
  "gmail",
  "researchReport",
  "documentBuild",
  "scheduledEmail",
  "accountBillingSafetyDataRights",
] as const;

const completeCostEvidence = (): CostEvidence => {
  const priceBookId = "price-book-v1";
  const priceBookSource = "provider-published-price-book";
  const priceBookVersion = "2026-08-01";
  const pricesObservedAtEpochMs = Date.parse("2026-08-01T12:00:00.000Z");
  const priceBook = requiredCostCategories.map((category) => ({
    category,
    priceUsdMicros: 1n,
    unit: requiredPriceUnits[category],
  }));
  const rootCosts = journeys.map((journey, index) => ({
    allowancePeriodId: index % 2 === 0 ? "free-period-1" : "adventurer-period-1",
    costReconciliationId: `cost-root-${journey}`,
    journey,
    plan: index % 2 === 0 ? ("free" as const) : ("adventurer" as const),
    priceBookId: "price-book-v1",
    rootId: `root-${journey}`,
    usage: usageFor(`root-${journey}`),
  }));
  const scenarios = (
    ["betaMonth", "publicMonth", "growthWidthMonth", "growthDepthMonth"] as const
  ).map((dimension) => ({
    denominator: 1,
    dimension,
    priceBookId: "price-book-v1",
    usage: usageFor(`scenario-${dimension}`),
  }));
  const usageAuthorityRecords = [
    ...rootCosts.flatMap((record) =>
      record.usage.map((line) => ({
        ...line,
        provider: `provider-${line.category}`,
        scope: "root" as const,
        subject: record.rootId,
      })),
    ),
    ...scenarios.flatMap((record) =>
      record.usage.map((line) => ({
        ...line,
        provider: `provider-${line.category}`,
        scope: "scenario" as const,
        subject: record.dimension,
      })),
    ),
  ];
  const usageAuthorityArtifactId = "provider-usage-authority-v1";
  const usageAuthoritySource = "provider-usage-export";
  const usageAuthoritySourceVersion = "2026-08";
  const usageAuthorityWindowStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const usageAuthorityWindowEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const billedUsageArtifactId = "provider-bill-v1";
  const billedUsageInvoiceId = "invoice-2026-08";
  const billedUsageProvider = "cloud-provider";
  const billingMonthStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const billingMonthEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const billedUsageUsdMicros = 171n;
  const billedUsageLines = rootCosts.flatMap((record) =>
    record.usage.map((line) => ({
      category: line.category,
      provider: `provider-${line.category}`,
      quantity: line.quantity,
      unit: line.unit,
      usageId: line.usageId,
      usdMicros: line.usdMicros,
    })),
  );
  const cohortPeriods = [
    { allowancePeriodId: "free-period-1", plan: "free" as const, revenueUsdMicros: 0n },
    {
      allowancePeriodId: "adventurer-period-1",
      plan: "adventurer" as const,
      revenueUsdMicros: 1_000_000n,
    },
  ];
  const economicsArtifactId = "billing-economics-v1";
  const economicsSource = "postgres-billing-export";
  const economicsWindowStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const economicsWindowEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const usageLedgerArtifactId = "cost-ledger-v1";
  const usageLedgerSource = "provider-usage-export";
  const usageLedgerWindowStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const usageLedgerWindowEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const goodRootOutcomeIds = rootCosts.map((record) => record.rootId);
  return {
    activeAdventurerPeriods: 1,
    activeFreePeriods: 1,
    adventurerRevenueUsdMicros: 1_000_000n,
    billedUsageArtifactChecksum: qualificationChecksum({
      artifactId: billedUsageArtifactId,
      invoiceId: billedUsageInvoiceId,
      lines: billedUsageLines,
      monthEndedAtUtc: billingMonthEndedAtUtc,
      monthStartedAtUtc: billingMonthStartedAtUtc,
      priceBookId,
      provider: billedUsageProvider,
    }),
    billedUsageArtifactId,
    billedUsageInvoiceId,
    billedUsageLines,
    billedUsageProvider,
    billedUsageUsdMicros,
    billingMonthEndedAtUtc,
    billingMonthStartedAtUtc,
    cohortPeriods,
    economicsArtifactChecksum: qualificationChecksum({
      activeAdventurerPeriods: 1,
      activeFreePeriods: 1,
      adventurerRevenueUsdMicros: 1_000_000n,
      artifactId: economicsArtifactId,
      cohortPeriods,
      foreignExchangeUsdMicros: 0n,
      goodRootOutcomeIds,
      source: economicsSource,
      taxesUsdMicros: 0n,
      windowEndedAtUtc: economicsWindowEndedAtUtc,
      windowStartedAtUtc: economicsWindowStartedAtUtc,
    }),
    economicsArtifactId,
    economicsSource,
    economicsWindowEndedAtUtc,
    economicsWindowStartedAtUtc,
    evaluatedAtEpochMs: Date.parse("2026-08-17T12:00:00.000Z"),
    foreignExchangeUsdMicros: 0n,
    goodRootOutcomeIds,
    priceBook,
    priceBookArtifactChecksum: qualificationChecksum({
      artifactId: "provider-price-book-v1",
      observedAtEpochMs: pricesObservedAtEpochMs,
      priceBook,
      priceBookId,
      source: priceBookSource,
      version: priceBookVersion,
    }),
    priceBookArtifactId: "provider-price-book-v1",
    priceBookId,
    priceBookSource,
    priceBookVersion,
    pricesObservedAtEpochMs,
    rootCosts,
    scenarios,
    taxesUsdMicros: 0n,
    usageLedgerArtifactChecksum: qualificationChecksum({
      artifactId: usageLedgerArtifactId,
      rootCosts,
      scenarios,
      source: usageLedgerSource,
      windowEndedAtUtc: usageLedgerWindowEndedAtUtc,
      windowStartedAtUtc: usageLedgerWindowStartedAtUtc,
    }),
    usageLedgerArtifactId,
    usageLedgerSource,
    usageLedgerWindowEndedAtUtc,
    usageLedgerWindowStartedAtUtc,
    usageAuthorityArtifactChecksum: qualificationChecksum({
      artifactId: usageAuthorityArtifactId,
      records: usageAuthorityRecords,
      source: usageAuthoritySource,
      sourceVersion: usageAuthoritySourceVersion,
      windowEndedAtUtc: usageAuthorityWindowEndedAtUtc,
      windowStartedAtUtc: usageAuthorityWindowStartedAtUtc,
    }),
    usageAuthorityArtifactId,
    usageAuthorityRecords,
    usageAuthoritySource,
    usageAuthoritySourceVersion,
    usageAuthorityWindowEndedAtUtc,
    usageAuthorityWindowStartedAtUtc,
  };
};

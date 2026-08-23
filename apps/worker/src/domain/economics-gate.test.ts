import { describe, expect, it } from "@effect/vitest";

import { evaluateEconomics, type EconomicsEvidence } from "./economics-gate";

/* oxlint-disable effecttsgo/global-date -- Fixed dates prove evidence freshness. */

describe("shared Plan Usage economics gate", () => {
  it("reports MISSING for any material omitted or stale evidence", () => {
    const evidence = passingEvidence();
    expect(
      evaluateEconomics(
        { ...evidence, supportCostUsdMicros: null },
        new Date("2026-08-23T00:00:00.000Z"),
      ),
    ).toMatchObject({ status: "MISSING" });
    expect(
      evaluateEconomics(
        {
          ...evidence,
          sources: [
            {
              observedAt: new Date("2026-07-01T00:00:00.000Z"),
              reference: "invoice-2026-07",
              source: "bill",
            },
          ],
        },
        new Date("2026-08-23T00:00:00.000Z"),
      ),
    ).toMatchObject({ status: "MISSING" });
  });

  it("applies the fifteen-percent provider stress and exact overshoot", () => {
    const result = evaluateEconomics(passingEvidence(), new Date("2026-08-23T00:00:00.000Z"));
    expect(result).toMatchObject({
      adventurer: { status: "PASS" },
      free: { status: "PASS" },
      status: "PASS",
    });
    if (result.status !== "PASS") return;
    expect(result.free.stressedVariableCostUsdMicros).toBe(2_415_000n);
  });

  it("fails when either Plan misses its all-in threshold", () => {
    const result = evaluateEconomics(
      { ...passingEvidence(), fixedAndIdleCostUsdMicros: 3_000_000n },
      new Date("2026-08-23T00:00:00.000Z"),
    );
    expect(result.status).toBe("FAIL");
    expect(result.free.status).toBe("FAIL");
  });
});

const passingEvidence = (): EconomicsEvidence => ({
  adventurerIncludedUsageUsdMicros: 6_000_000n,
  adventurerConcurrentAdmissions: 3,
  adventurerMaximumOperationUsdMicros: 100_000n,
  adventurerNonUsageCostUsdMicros: 500_000n,
  adventurerRevenueUsdMicrosAtConservativeFx: 18_000_000n,
  fixedAndIdleCostUsdMicros: 300_000n,
  freeIncludedUsageUsdMicros: 2_000_000n,
  freeConcurrentAdmissions: 1,
  freeMaximumOperationUsdMicros: 100_000n,
  freeOtherCompanyCostUsdMicros: 1_000_000n,
  gmSummonExpectedCostUsdMicros: 300_000n,
  paymentCostUsdMicros: 400_000n,
  sources: [
    {
      observedAt: new Date("2026-08-20T00:00:00.000Z"),
      reference: "invoice-2026-08",
      source: "bill",
    },
  ],
  supportCostUsdMicros: 500_000n,
  workloadMeasurements: (
    [
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
    ] as const
  ).map((workload) => ({
    evidenceReference: `measurement:${workload}`,
    measuredCostUsdMicros: 1n,
    workload,
  })),
});

import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { qualificationChecksum } from "./qualification-checksum";
import { qualificationExecutionEvidence, qualifyProduction } from "./production-qualification";
import { completeProductionEvidence } from "../../test/support/qualification-fixtures";
import { withMemorySemanticObservations } from "../../test/support/memory-semantic-fixture";

describe("Production qualification", () => {
  it("produces PASS only from complete evidence for every required gate", () => {
    const evidence = completeProductionEvidence();
    const result = qualifyProduction(evidence);
    expect(result).toMatchObject({
      adventurerContributionMargin: 0.996596,
      findings: [],
      foreignExchangeUsdMicros: 2_000n,
      freeCostPerActivePeriodUsdMicros: 19_617n,
      recoveryReservePerSecond: 2,
      taxesUsdMicros: 3_000n,
      verdict: "PASS",
    });
    expect(result.stageSummaries).toHaveLength(139);
  });

  it("makes an absent retained execution-plan binding MISSING", () => {
    const evidence = completeProductionEvidence();
    const result = qualifyProduction({
      ...evidence,
      execution: {
        ...evidence.execution,
        artifactChecksum: "",
        artifactId: "",
        planChecksum: "",
      },
    });

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "executionEvidenceMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("fails a tampered retained execution-plan binding", () => {
    const evidence = completeProductionEvidence();
    const result = qualifyProduction({
      ...evidence,
      execution: { ...evidence.execution, planChecksum: "different-plan" },
    });

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "executionEvidenceConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("keeps FAIL precedence over simultaneous missing material evidence", () => {
    const evidence = completeProductionEvidence();
    const result = qualifyProduction({
      ...evidence,
      externalGates: evidence.externalGates.filter((gate) => gate.gate !== "modelQuality"),
      runs: {
        ...evidence.runs,
        correctnessViolations: [{ code: "duplicateAuthority", rootId: "root-1" }],
      },
      semantic: {
        ...evidence.semantic,
        localEvidence: evidence.semantic.localEvidence.filter(
          (entry) => entry.store !== "AgentSQLite",
        ),
      },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "localEvidenceMissing", verdict: "MISSING" }),
        expect.objectContaining({ code: "correctnessViolation", verdict: "FAIL" }),
        expect.objectContaining({ code: "externalGateMissing", verdict: "MISSING" }),
      ]),
    );
  });

  it("makes absent retained MemoryProvider semantics MISSING", () => {
    const evidence = completeProductionEvidence();
    expect(
      qualifyProduction({
        ...evidence,
        memorySemantic: withMemorySemanticObservations(evidence.memorySemantic, []),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "memorySemanticObservationMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("requires semantic evidence for the complete accepted run corpus", () => {
    const evidence = completeProductionEvidence();
    const missingRoot = evidence.semantic.acceptedRootIds[0];
    expect(missingRoot).toBeDefined();
    expect(
      qualifyProduction({
        ...evidence,
        cost: withoutFirstRootCost(evidence.cost),
        semantic: {
          ...evidence.semantic,
          acceptedRootIds: evidence.semantic.acceptedRootIds.slice(1),
          localEvidence: evidence.semantic.localEvidence.filter((entry) =>
            entry.store === "AgentSQLite"
              ? entry.rootId !== missingRoot
              : entry.acceptanceReceiptId !== `receipt-${missingRoot}`,
          ),
          productAuthorityExports: evidence.semantic.productAuthorityExports.map((artifact) => {
            const records = artifact.records.filter((record) => record.rootId !== missingRoot);
            return {
              ...artifact,
              checksum: qualificationChecksum({
                artifactId: artifact.artifactId,
                authority: artifact.authority,
                exportedAtUtc: artifact.exportedAtUtc,
                records,
                sourceVersion: artifact.sourceVersion,
              }),
              records,
            };
          }),
          traces: evidence.semantic.traces.filter((trace) => trace.rootId !== missingRoot),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "acceptedRootSemanticEvidenceMissing",
          subject: missingRoot,
        }),
      ]),
      verdict: "MISSING",
    });
  });

  it("requires each regional recovery repetition", () => {
    const evidence = completeProductionEvidence();
    expect(
      qualifyProduction({ ...evidence, recoveryRuns: evidence.recoveryRuns.slice(1) }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "recoveryEvidenceMissing",
          subject: "dependencyOutageRecovery:americas:1",
        }),
      ]),
      recoveryReservePerSecond: 2,
      verdict: "MISSING",
    });
  });

  it("binds recovery authority to the frozen source version", () => {
    const evidence = completeProductionEvidence();
    const first = evidence.recoveryRuns[0];
    const authority = first?.evidence.authorityArtifact;
    expect(first).toBeDefined();
    expect(authority).toBeDefined();
    if (first === undefined || authority === undefined) return;
    const { artifactChecksum: _artifactChecksum, ...authorityContent } = {
      ...authority,
      sourceVersion: "different-source",
    };
    const changedAuthority = {
      ...authorityContent,
      artifactChecksum: qualificationChecksum(authorityContent),
    };
    expect(
      qualifyProduction({
        ...evidence,
        recoveryRuns: evidence.recoveryRuns.map((run) =>
          run === first
            ? Object.assign({}, run, {
                evidence: Object.assign({}, run.evidence, {
                  authorityArtifact: changedAuthority,
                }),
              })
            : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "recoveryAuthorityVersionConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("fails when raw recovery facts omit accepted work from every state transition", () => {
    const evidence = completeProductionEvidence();
    const first = evidence.recoveryRuns[0];
    const authority = first?.evidence.authorityArtifact;
    const laneRun = evidence.runs.laneRuns.find(
      (run) =>
        run.lane === "dependencyOutageRecovery" &&
        run.region === first?.region &&
        run.repetition === first.repetition,
    );
    const omittedRoot = laneRun?.acceptedRootIds[0];
    expect(first).toBeDefined();
    expect(authority).toBeDefined();
    expect(omittedRoot).toBeDefined();
    if (first === undefined || authority === undefined || omittedRoot === undefined) return;
    const throughputWindows = authority.throughputWindows.map((window) => ({
      ...window,
      acceptedRootIds: window.acceptedRootIds.filter((rootId) => rootId !== omittedRoot),
      completedRootIds: window.completedRootIds.filter((rootId) => rootId !== omittedRoot),
    }));
    const { artifactChecksum: _artifactChecksum, ...authorityContent } = {
      ...authority,
      throughputWindows,
    };
    const changedAuthority = {
      ...authorityContent,
      artifactChecksum: qualificationChecksum(authorityContent),
    };

    expect(
      qualifyProduction({
        ...evidence,
        recoveryRuns: evidence.recoveryRuns.map((run) =>
          run === first
            ? Object.assign({}, run, {
                evidence: Object.assign({}, run.evidence, {
                  authorityArtifact: changedAuthority,
                }),
              })
            : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "recoveryAuthorityRunConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "recoveryAuthorityCoverageConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects raw resource facts outside the exact accepted run corpus", () => {
    const evidence = completeProductionEvidence();
    const first = evidence.resourceUse[0];
    const authority = first?.authorityArtifact;
    expect(first).toBeDefined();
    expect(authority).toBeDefined();
    if (first === undefined || authority === undefined) return;
    const records = authority.records.map((record, index) =>
      index === 0 ? Object.assign({}, record, { rootId: "unaccepted-root" }) : record,
    );
    const authorityContent = {
      artifactId: authority.artifactId,
      limitName: first.limitName,
      records,
      runArtifactChecksum: authority.runArtifactChecksum,
      source: authority.source,
      sourceVersion: authority.sourceVersion,
      unit: first.unit,
    };
    expect(
      qualifyProduction({
        ...evidence,
        resourceUse: evidence.resourceUse.map((measurement) =>
          measurement === first
            ? Object.assign({}, measurement, {
                authorityArtifact: Object.assign({}, authority, {
                  artifactChecksum: qualificationChecksum(authorityContent),
                  records,
                }),
              })
            : measurement,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "resourceAuthorityRunConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("binds each run Plan and journey population to root traces and cost records", () => {
    const evidence = completeProductionEvidence();
    expect(
      qualifyProduction({
        ...evidence,
        semantic: {
          ...evidence.semantic,
          traces: evidence.semantic.traces.map((trace, index) =>
            index === 0 ? Object.assign({}, trace, { plan: "adventurer" as const }) : trace,
          ),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "semanticPopulationConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
    expect(
      qualifyProduction({
        ...evidence,
        cost: withoutFirstRootCost(evidence.cost),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "rootCostReconciliationMissing", verdict: "MISSING" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("binds run region, all-cold activation, and Good Root facts to semantic authority", () => {
    const evidence = completeProductionEvidence();
    const firstRoot = evidence.runs.laneRuns[0]?.acceptedRootIds[0];
    const allColdRoot = evidence.runs.laneRuns.find((run) => run.lane === "allCold")
      ?.acceptedRootIds[0];
    expect(firstRoot).toBeDefined();
    expect(allColdRoot).toBeDefined();
    if (firstRoot === undefined || allColdRoot === undefined) return;
    expect(
      qualifyProduction({
        ...evidence,
        semantic: {
          ...evidence.semantic,
          traces: evidence.semantic.traces.map((trace) => {
            if (trace.rootId === firstRoot)
              return Object.assign({}, trace, {
                activation: Object.assign({}, trace.activation, { region: "europe" as const }),
              });
            if (trace.rootId === allColdRoot)
              return Object.assign({}, trace, {
                activation: Object.assign({}, trace.activation, {
                  cause: "warm" as const,
                  classification: "warm" as const,
                }),
              });
            return trace;
          }),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "semanticPopulationConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects a self-consistent Good Root fact that is not the committed semantic outcome", () => {
    const evidence = completeProductionEvidence();
    const firstRun = evidence.runs.laneRuns[0];
    const firstOutcome = firstRun?.rootOutcomes[0];
    expect(firstOutcome).toBeDefined();
    if (firstRun === undefined || firstOutcome === undefined) return;
    const outcomeId = `invented-${firstOutcome.rootId}`;
    const assertions = firstOutcome.assertions.map((assertion) => ({
      ...assertion,
      productFactChecksum: qualificationChecksum({
        assertion: assertion.assertion,
        authorityFactIds: assertion.authorityFactIds,
        occurredAtUtc: assertion.occurredAtUtc,
        passed: assertion.passed,
        productFactId: outcomeId,
        rootId: firstOutcome.rootId,
      }),
      productFactId: outcomeId,
    }));
    expect(
      qualifyProduction({
        ...evidence,
        runs: {
          ...evidence.runs,
          laneRuns: evidence.runs.laneRuns.map((run) =>
            run === firstRun
              ? Object.assign({}, run, {
                  rootOutcomes: run.rootOutcomes.map((outcome) =>
                    outcome === firstOutcome
                      ? Object.assign({}, outcome, { assertions, outcomeId })
                      : outcome,
                  ),
                })
              : run,
          ),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "rootOutcomeAuthorityConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("does not let a duplicate PASS hide an external FAIL", () => {
    const evidence = completeProductionEvidence();
    const modelGate = evidence.externalGates.find((gate) => gate.gate === "modelQuality");
    expect(modelGate).toBeDefined();
    expect(
      qualifyProduction({
        ...evidence,
        externalGates:
          modelGate === undefined
            ? evidence.externalGates
            : [
                ...evidence.externalGates,
                { ...modelGate, evidenceId: "failed-model-gate", verdict: "FAIL" },
              ],
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "duplicateExternalGateEvidence", verdict: "FAIL" }),
        expect.objectContaining({ code: "externalGateFailed", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("excludes a late outcome from the Good Root cost corpus", () => {
    const evidence = completeProductionEvidence();
    const firstRun = evidence.runs.laneRuns[0];
    const firstOutcome = firstRun?.rootOutcomes[0];
    expect(firstOutcome).toBeDefined();
    if (firstRun === undefined || firstOutcome === undefined) return;
    const requirement = evidence.manifest.journeyMix.find(
      (entry) => entry.journey === firstOutcome.journey,
    );
    expect(requirement).toBeDefined();
    if (requirement === undefined) return;
    const evaluatedAtUtc = DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(firstOutcome.acceptedAtUtc) + requirement.deadlineMs + 1),
    );
    expect(
      qualifyProduction({
        ...evidence,
        runs: {
          ...evidence.runs,
          laneRuns: evidence.runs.laneRuns.map((run) =>
            run === firstRun
              ? Object.assign({}, run, {
                  rootOutcomes: run.rootOutcomes.map((outcome) =>
                    outcome === firstOutcome
                      ? Object.assign({}, outcome, { evaluatedAtUtc })
                      : outcome,
                  ),
                })
              : run,
          ),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "goodRootCostCorpusConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("returns MISSING for a materially incomplete manifest", () => {
    const evidence = completeProductionEvidence();
    const { manifestChecksum: _checksum, ...manifestContent } = {
      ...evidence.manifest,
      dependencyVersions: {},
      hardLimits: [],
    };
    const manifest = {
      ...manifestContent,
      manifestChecksum: qualificationChecksum(manifestContent),
    };
    expect(
      qualifyProduction({
        ...evidence,
        execution: qualificationExecutionEvidence(
          manifest,
          evidence.execution.executionId,
          evidence.execution.planChecksum,
          evidence.execution.artifactId,
          evidence.execution.runReceipts,
        ),
        manifest,
        runs: {
          ...evidence.runs,
          challengeRuns: evidence.runs.challengeRuns.map((run) => {
            const receipt = run.faultControllerReceipt;
            if (receipt === null) return run;
            const { artifactChecksum: _artifactChecksum, ...content } = {
              ...receipt,
              manifestChecksum: manifest.manifestChecksum,
            };
            return Object.assign({}, run, {
              faultControllerReceipt: {
                ...content,
                artifactChecksum: qualificationChecksum(content),
              },
            });
          }),
          dependencyVersions: {},
          manifestChecksum: manifest.manifestChecksum,
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "frozenManifestIncomplete", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("rejects manifest policy changed after checksum derivation", () => {
    const evidence = completeProductionEvidence();
    expect(
      qualifyProduction({
        ...evidence,
        manifest: {
          ...evidence.manifest,
          challengeLanes: evidence.manifest.challengeLanes.slice(1),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "manifestChecksumMismatch", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("binds raw stage intervals to committed product authority timestamps", () => {
    const evidence = completeProductionEvidence();
    const measurement = evidence.stages[0];
    const sample = measurement?.samples[0];
    expect(sample).toBeDefined();
    if (measurement === undefined || sample === undefined) return;
    const samples = measurement.samples.map((candidate, index) =>
      index === 0
        ? { ...candidate, endProductFactId: `invented-${candidate.endProductFactId}` }
        : candidate,
    );
    expect(
      qualifyProduction({
        ...evidence,
        stages: evidence.stages.map((candidate) =>
          candidate === measurement
            ? Object.assign({}, candidate, {
                artifactChecksum: qualificationChecksum(samples),
                samples,
              })
            : candidate,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "stageProductAuthorityConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects stale authority exports and unowned scenario cost inputs", () => {
    const evidence = completeProductionEvidence();
    const authorityExport = evidence.semantic.productAuthorityExports[0];
    const scenario = evidence.cost.scenarios[0];
    expect(authorityExport).toBeDefined();
    expect(scenario?.usage[0]).toBeDefined();
    if (authorityExport === undefined || scenario === undefined) return;
    const staleExport = {
      ...authorityExport,
      checksum: qualificationChecksum({
        artifactId: authorityExport.artifactId,
        authority: authorityExport.authority,
        exportedAtUtc: authorityExport.exportedAtUtc,
        records: authorityExport.records,
        sourceVersion: "stale-source-version",
      }),
      sourceVersion: "stale-source-version",
    };
    const scenarios = evidence.cost.scenarios.map((candidate) =>
      candidate === scenario
        ? {
            ...candidate,
            usage: candidate.usage.map((line, index) =>
              index === 0 ? { ...line, sourceProductFactId: "invented-cost-authority" } : line,
            ),
          }
        : candidate,
    );
    expect(
      qualifyProduction({
        ...evidence,
        cost: {
          ...evidence.cost,
          scenarios,
          usageLedgerArtifactChecksum: qualificationChecksum({
            artifactId: evidence.cost.usageLedgerArtifactId,
            rootCosts: evidence.cost.rootCosts,
            scenarios,
            source: evidence.cost.usageLedgerSource,
            windowEndedAtUtc: evidence.cost.usageLedgerWindowEndedAtUtc,
            windowStartedAtUtc: evidence.cost.usageLedgerWindowStartedAtUtc,
          }),
        },
        semantic: {
          ...evidence.semantic,
          productAuthorityExports: evidence.semantic.productAuthorityExports.map((candidate) =>
            candidate === authorityExport ? staleExport : candidate,
          ),
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "productAuthorityExportWindowConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "scenarioCostAuthorityMissing", verdict: "MISSING" }),
      ]),
      verdict: "FAIL",
    });
  });
});

const withoutFirstRootCost = (
  cost: ReturnType<typeof completeProductionEvidence>["cost"],
): ReturnType<typeof completeProductionEvidence>["cost"] => {
  const rootCosts = cost.rootCosts.slice(1);
  const firstRootUsage =
    cost.rootCosts[0]?.usage.reduce((total, line) => total + line.usdMicros, 0n) ?? 0n;
  const billedUsageUsdMicros = (cost.billedUsageUsdMicros ?? 0n) - firstRootUsage;
  const billedUsageLines = (cost.billedUsageLines ?? []).filter((line) =>
    rootCosts.some((record) => record.usage.some((usage) => usage.usageId === line.usageId)),
  );
  const rootIds = new Set(rootCosts.map(({ rootId }) => rootId));
  const usageAuthorityRecords = cost.usageAuthorityRecords.filter(
    (record) => record.scope === "scenario" || rootIds.has(record.subject),
  );
  const goodRootOutcomeIds = rootCosts.map((record) => record.rootId);
  return {
    ...cost,
    billedUsageArtifactChecksum: qualificationChecksum({
      artifactId: cost.billedUsageArtifactId,
      invoiceId: cost.billedUsageInvoiceId,
      lines: billedUsageLines,
      monthEndedAtUtc: cost.billingMonthEndedAtUtc,
      monthStartedAtUtc: cost.billingMonthStartedAtUtc,
      priceBookId: cost.priceBookId,
      provider: cost.billedUsageProvider,
    }),
    billedUsageUsdMicros,
    billedUsageLines,
    economicsArtifactChecksum: qualificationChecksum({
      activeAdventurerPeriods: cost.activeAdventurerPeriods,
      activeFreePeriods: cost.activeFreePeriods,
      adventurerRevenueUsdMicros: cost.adventurerRevenueUsdMicros,
      artifactId: cost.economicsArtifactId,
      cohortPeriods: cost.cohortPeriods,
      foreignExchangeUsdMicros: cost.foreignExchangeUsdMicros,
      goodRootOutcomeIds,
      source: cost.economicsSource,
      taxesUsdMicros: cost.taxesUsdMicros,
      windowEndedAtUtc: cost.economicsWindowEndedAtUtc,
      windowStartedAtUtc: cost.economicsWindowStartedAtUtc,
    }),
    goodRootOutcomeIds,
    rootCosts,
    usageAuthorityArtifactChecksum: qualificationChecksum({
      artifactId: cost.usageAuthorityArtifactId,
      records: usageAuthorityRecords,
      source: cost.usageAuthoritySource,
      sourceVersion: cost.usageAuthoritySourceVersion,
      windowEndedAtUtc: cost.usageAuthorityWindowEndedAtUtc,
      windowStartedAtUtc: cost.usageAuthorityWindowStartedAtUtc,
    }),
    usageAuthorityRecords,
    usageLedgerArtifactChecksum: qualificationChecksum({
      artifactId: cost.usageLedgerArtifactId,
      rootCosts,
      scenarios: cost.scenarios,
      source: cost.usageLedgerSource,
      windowEndedAtUtc: cost.usageLedgerWindowEndedAtUtc,
      windowStartedAtUtc: cost.usageLedgerWindowStartedAtUtc,
    }),
  };
};

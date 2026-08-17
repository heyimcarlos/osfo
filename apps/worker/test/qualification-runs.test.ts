import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { qualificationChecksum } from "../src/qualification/qualification-checksum";
import { assessQualificationRuns } from "../src/qualification/qualification-runs";
import {
  compactManifest,
  compactPublicManifest,
  completeRunEvidence,
} from "./support/qualification-fixtures";

describe("Qualification runs", () => {
  it("requires each exact lane repetition with frozen seed and arrival corpus", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    expect(assessQualificationRuns(manifest, evidence)).toEqual({ findings: [], verdict: "PASS" });

    expect(
      assessQualificationRuns(manifest, { ...evidence, laneRuns: evidence.laneRuns.slice(1) }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "laneRepetitionMissing",
          subject: "baseline:americas:1",
          verdict: "MISSING",
        }),
        expect.objectContaining({ code: "journeyOutcomeAggregateConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        laneRuns: evidence.laneRuns.map((run, index) =>
          index === 0
            ? Object.assign({}, run, {
                actualArrivals: Object.assign({}, run.actualArrivals, { count: 0 }),
                seed: -1,
              })
            : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "workloadSeedMismatch" }),
        expect.objectContaining({ code: "actualArrivalCountMismatch" }),
        expect.objectContaining({ code: "arrivalResolutionMismatch" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("requires isolated rare-journey and all-Adventurer lanes before the cascade", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        challengeRuns: evidence.challengeRuns.filter((run) => run.challenge !== "rareJourney"),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "challengeRunMissing",
          subject: "rareJourney:americas",
          verdict: "MISSING",
        }),
        expect.objectContaining({ code: "journeyOutcomeAggregateConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        challengeRuns: evidence.challengeRuns.map((run) =>
          run.challenge === "combinedTargetCascade" ? Object.assign({}, run, { sequence: 1 }) : run,
        ),
      }),
    ).toMatchObject({
      findings: [expect.objectContaining({ code: "combinedCascadeStartedEarly" })],
      verdict: "FAIL",
    });
  });

  it("applies 100 percent deterministic and 99 percent live journey floors with deadlines", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        journeyOutcomes: evidence.journeyOutcomes.map((outcome) =>
          outcome.journey === "registration"
            ? Object.assign({}, outcome, { goodRootOutcomes: 99 })
            : outcome,
        ),
      }),
    ).toMatchObject({
      findings: [
        {
          code: "journeyOutcomeAggregateConflict",
          subject: "registration",
          verdict: "FAIL",
        },
      ],
      verdict: "FAIL",
    });
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        journeyOutcomes: evidence.journeyOutcomes.map((outcome) =>
          outcome.journey === "ordinaryConversation"
            ? Object.assign({}, outcome, { deadlineMs: 1 })
            : outcome,
        ),
      }),
    ).toMatchObject({
      findings: [{ code: "journeyOutcomeInvalid", verdict: "FAIL" }],
      verdict: "FAIL",
    });
  });

  it("does not require a progress milestone when a long journey is already terminal", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    const run = evidence.laneRuns.find((candidate) =>
      candidate.rootOutcomes.some((outcome) => outcome.journey === "researchReport"),
    );
    const outcome = run?.rootOutcomes.find((candidate) => candidate.journey === "researchReport");
    expect(outcome?.assertions[0]).toBeDefined();
    if (run === undefined || outcome === undefined) return;
    const evaluatedAtUtc = DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(outcome.acceptedAtUtc) + 1_000),
    );
    const assertions = outcome.assertions.map((assertion) => ({
      ...assertion,
      occurredAtUtc: evaluatedAtUtc,
      productFactChecksum: qualificationChecksum({
        assertion: assertion.assertion,
        authorityFactIds: assertion.authorityFactIds,
        occurredAtUtc: evaluatedAtUtc,
        passed: assertion.passed,
        productFactId: assertion.productFactId,
        rootId: outcome.rootId,
      }),
    }));
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        journeyOutcomes: evidence.journeyOutcomes.map((aggregate) =>
          aggregate.journey === "researchReport"
            ? {
                ...aggregate,
                milestoneEligibleRoots: aggregate.milestoneEligibleRoots - 1,
                timelyMilestoneOutcomes: aggregate.timelyMilestoneOutcomes - 1,
              }
            : aggregate,
        ),
        laneRuns: evidence.laneRuns.map((candidate) =>
          candidate === run
            ? Object.assign({}, candidate, {
                rootOutcomes: candidate.rootOutcomes.map((rootOutcome) =>
                  rootOutcome === outcome
                    ? {
                        ...rootOutcome,
                        assertions,
                        evaluatedAtUtc,
                        milestoneAssertions: [],
                        milestoneEvaluatedAtUtc: null,
                      }
                    : rootOutcome,
                ),
              })
            : candidate,
        ),
      }),
    ).toEqual({ findings: [], verdict: "PASS" });
  });

  it("keeps a valid failed live outcome in the denominator without failing the evidence", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    const run = evidence.laneRuns.find((candidate) =>
      candidate.rootOutcomes.some((outcome) => outcome.journey === "ordinaryConversation"),
    );
    const outcome = run?.rootOutcomes.find(
      (candidate) => candidate.journey === "ordinaryConversation",
    );
    expect(outcome?.assertions[0]).toBeDefined();
    if (run === undefined || outcome === undefined) return;
    const assertions = outcome.assertions.map((assertion) => ({
      ...assertion,
      passed: false,
      productFactChecksum: qualificationChecksum({
        assertion: assertion.assertion,
        authorityFactIds: assertion.authorityFactIds,
        occurredAtUtc: assertion.occurredAtUtc,
        passed: false,
        productFactId: assertion.productFactId,
        rootId: outcome.rootId,
      }),
    }));
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        journeyOutcomes: evidence.journeyOutcomes.map((aggregate) =>
          aggregate.journey === "ordinaryConversation"
            ? { ...aggregate, goodRootOutcomes: aggregate.goodRootOutcomes - 1 }
            : aggregate,
        ),
        laneRuns: evidence.laneRuns.map((candidate) =>
          candidate === run
            ? Object.assign({}, candidate, {
                rootOutcomes: candidate.rootOutcomes.map((rootOutcome) =>
                  rootOutcome === outcome
                    ? Object.assign({}, rootOutcome, { assertions })
                    : rootOutcome,
                ),
              })
            : candidate,
        ),
      }),
    ).toEqual({ findings: [], verdict: "PASS" });
  });

  it("fails duplicate challenge, journey, and reused root evidence", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    const duplicateChallenge = evidence.challengeRuns[0];
    const duplicateJourney = evidence.journeyOutcomes[0];
    const firstRun = evidence.laneRuns[0];
    const secondRun = evidence.laneRuns[1];
    expect(duplicateChallenge).toBeDefined();
    expect(duplicateJourney).toBeDefined();
    expect(firstRun?.acceptedRootIds[0]).toBeDefined();
    expect(secondRun).toBeDefined();
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        challengeRuns:
          duplicateChallenge === undefined
            ? evidence.challengeRuns
            : [...evidence.challengeRuns, duplicateChallenge],
        journeyOutcomes:
          duplicateJourney === undefined
            ? evidence.journeyOutcomes
            : [...evidence.journeyOutcomes, duplicateJourney],
        laneRuns:
          secondRun === undefined || firstRun?.acceptedRootIds[0] === undefined
            ? evidence.laneRuns
            : evidence.laneRuns.map((run, index) =>
                index === 1
                  ? Object.assign({}, run, {
                      acceptedRootIds: [firstRun.acceptedRootIds[0] ?? ""],
                    })
                  : run,
              ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "duplicateChallengeRun" }),
        expect.objectContaining({ code: "duplicateJourneyOutcome" }),
        expect.objectContaining({ code: "acceptedRootReusedAcrossRuns" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("gives correctness and teardown failures zero tolerance", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        correctnessViolations: [{ code: "duplicateEffect", rootId: "target-1" }],
        teardownInventory: ["r2:orphaned-test-object"],
      }),
    ).toMatchObject({
      findings: [
        expect.objectContaining({ code: "correctnessViolation" }),
        expect.objectContaining({ code: "teardownIncomplete" }),
      ],
      verdict: "FAIL",
    });
  });

  it("binds the bundle to the exact manifest and deployed versions", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    expect(
      assessQualificationRuns(manifest, { ...evidence, manifestChecksum: "other" }),
    ).toMatchObject({
      findings: [{ code: "evidenceBundleVersionMismatch", verdict: "FAIL" }],
      verdict: "FAIL",
    });
  });

  it("rejects changed arrivals, windows, and fault parameters", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    const firstRun = evidence.laneRuns[0];
    const firstFaultRun = evidence.challengeRuns.find((run) => run.faultInjection !== null);
    expect(firstRun).toBeDefined();
    expect(firstFaultRun).toBeDefined();
    if (firstFaultRun === undefined) return;
    const changedChallengeArrivals = firstFaultRun.intendedArrivals.records.map((arrival, index) =>
      index === 0
        ? Object.assign({}, arrival, { offeredAtEpochMs: arrival.offeredAtEpochMs + 1 })
        : arrival,
    );
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        challengeRuns: evidence.challengeRuns.map((run) =>
          run === firstFaultRun && run.faultInjection !== null
            ? Object.assign({}, run, {
                faultInjection: Object.assign({}, run.faultInjection, { durationSeconds: 1 }),
                intendedArrivals: {
                  ...run.intendedArrivals,
                  checksum: qualificationChecksum(changedChallengeArrivals),
                  records: changedChallengeArrivals,
                },
              })
            : run,
        ),
        laneRuns: evidence.laneRuns.map((run) =>
          run === firstRun
            ? Object.assign({}, run, {
                windows: run.windows.map((window, index) =>
                  index === 0 ? Object.assign({}, window, { kind: "idle" as const }) : window,
                ),
              })
            : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "workloadWindowSequenceConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "faultInjectionManifestConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "challengeEvidenceInvalid", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects duplicate actual roots, incomplete outcome denominators, and failed fault invariants", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    const firstRun = evidence.laneRuns[0];
    const faultRun = evidence.challengeRuns.find((run) => run.faultInjection !== null);
    expect(firstRun?.actualArrivals.records[0]).toBeDefined();
    expect(faultRun?.faultObservations.records[0]).toBeDefined();
    if (firstRun === undefined || faultRun === undefined) return;
    const duplicatedActual = firstRun.actualArrivals.records.map((arrival, index) =>
      index === 1 ? (firstRun.actualArrivals.records[0] ?? arrival) : arrival,
    );
    const failedFaultRecords = faultRun.faultObservations.records.map((record) =>
      Object.assign({}, record, { invariantHeld: false }),
    );
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        challengeRuns: evidence.challengeRuns.map((run) =>
          run === faultRun
            ? {
                ...run,
                faultObservations: {
                  ...run.faultObservations,
                  checksum: qualificationChecksum(failedFaultRecords),
                  records: failedFaultRecords,
                },
              }
            : run,
        ),
        laneRuns: evidence.laneRuns.map((run) =>
          run === firstRun
            ? Object.assign({}, run, {
                actualArrivals: {
                  ...run.actualArrivals,
                  checksum: qualificationChecksum(duplicatedActual),
                  records: duplicatedActual,
                },
                rootOutcomes: run.rootOutcomes.slice(1),
              })
            : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "actualArrivalIdentityConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "rootOutcomeDenominatorConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "faultInvariantEvidenceMissing", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects impossible dispositions, unbound outcomes, and replayed fault observations", () => {
    const manifest = compactManifest();
    const evidence = completeRunEvidence(manifest);
    const firstRun = evidence.laneRuns[0];
    const faultRuns = evidence.challengeRuns.filter((run) => run.faultInjection !== null);
    const sourceFault = faultRuns[0];
    const targetFault = faultRuns[1];
    expect(firstRun?.dispositions[0]).toBeDefined();
    expect(firstRun?.rootOutcomes[0]?.assertions[0]).toBeDefined();
    expect(sourceFault?.faultObservations.records[0]).toBeDefined();
    expect(targetFault).toBeDefined();
    if (firstRun === undefined || sourceFault === undefined || targetFault === undefined) return;
    const dispositions = firstRun.dispositions.map((record, index) =>
      index === 0
        ? Object.assign({}, record, { resolvedAtUtc: "2026-08-17T11:59:59.000Z" })
        : record,
    );
    const rootOutcomes = firstRun.rootOutcomes.map((outcome, index) =>
      index === 0
        ? Object.assign({}, outcome, {
            assertions: outcome.assertions.map((assertion, assertionIndex) =>
              assertionIndex === 0
                ? Object.assign({}, assertion, { productFactChecksum: "fnv1a64:replayed" })
                : assertion,
            ),
          })
        : outcome,
    );
    const replayedFaultRecords = sourceFault.faultObservations.records;
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        challengeRuns: evidence.challengeRuns.map((run) =>
          run === targetFault
            ? {
                ...run,
                faultObservations: {
                  ...run.faultObservations,
                  checksum: qualificationChecksum(replayedFaultRecords),
                  count: replayedFaultRecords.length,
                  records: replayedFaultRecords,
                },
              }
            : run,
        ),
        laneRuns: evidence.laneRuns.map((run) =>
          run === firstRun ? Object.assign({}, run, { dispositions, rootOutcomes }) : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "arrivalDispositionConflict", verdict: "FAIL" }),
        expect.objectContaining({ code: "rootOutcomeEvidenceInvalid", verdict: "FAIL" }),
        expect.objectContaining({ code: "faultInvariantEvidenceMissing" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("derives public promotion and Growth Corpus facts from checksum-backed records", () => {
    const manifest = compactPublicManifest();
    const evidence = completeRunEvidence(manifest);
    const continued = evidence.continuedBeta;
    const growth = evidence.growthCorpusRuns[0];
    expect(continued).not.toBeNull();
    expect(growth).toBeDefined();
    if (continued === null || growth === undefined) return;
    const dailyRecords = continued.dailyEvidence.records.map((record, index) =>
      index === 0
        ? Object.assign({}, record, {
            acceptedRegisteredMessages: record.acceptedRegisteredMessages + 1,
            goodRootOutcomes: record.goodRootOutcomes + 1,
          })
        : record,
    );
    const corpusRecords = growth.corpusArtifact.records.map((record) =>
      Object.assign({}, record, { registeredUsers: record.registeredUsers - 1 }),
    );
    const characterizationRecords = growth.characterizationResultArtifact.records.map((record) =>
      Object.assign({}, record, { failedQueries: 1 }),
    );
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        continuedBeta: {
          ...continued,
          dailyEvidence: {
            ...continued.dailyEvidence,
            checksum: qualificationChecksum(dailyRecords),
            records: dailyRecords,
          },
        },
        growthCorpusRuns: evidence.growthCorpusRuns.map((run) =>
          run === growth
            ? Object.assign({}, run, {
                corpusArtifact: {
                  ...run.corpusArtifact,
                  checksum: qualificationChecksum(corpusRecords),
                  records: corpusRecords,
                },
                characterizationResultArtifact: {
                  ...run.characterizationResultArtifact,
                  checksum: qualificationChecksum(characterizationRecords),
                  records: characterizationRecords,
                },
              })
            : run,
        ),
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "continuedBetaDailyEvidenceInvalid", verdict: "FAIL" }),
        expect.objectContaining({
          code: "growthCorpusCharacterizationMissing",
          verdict: "MISSING",
        }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects empty or sub-SLO continued-beta days", () => {
    const manifest = compactPublicManifest();
    const evidence = completeRunEvidence(manifest);
    const continued = evidence.continuedBeta;
    expect(continued).not.toBeNull();
    if (continued === null) return;
    const records = continued.dailyEvidence.records.map((record, index) =>
      index === 7 ? { ...record, acceptedRegisteredMessages: 0, goodRootOutcomes: 0 } : record,
    );
    const splitRecords = continued.sloSplits.records.map((record, index) =>
      index === 0
        ? Object.assign({}, record, { goodRootOutcomes: 98, rollingSevenDayRatio: 0.98 })
        : record,
    );
    const sloSplits = {
      ...continued.sloSplits,
      checksum: qualificationChecksum(splitRecords),
      records: splitRecords,
    };
    const dailyEvidence = {
      ...continued.dailyEvidence,
      checksum: qualificationChecksum(records),
      records,
    };
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        continuedBeta: {
          ...continued,
          dailyEvidence,
          errorBudget28DayArtifactChecksum: qualificationChecksum({
            artifactId: continued.errorBudget28DayArtifactId,
            burnWindows: continued.burnWindows,
            dailyEvidenceChecksum: dailyEvidence.checksum,
            sloSplitsChecksum: sloSplits.checksum,
          }),
          sloSplits,
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "continuedBetaDailyEvidenceInvalid", verdict: "FAIL" }),
        expect.objectContaining({ code: "continuedBetaSplitEvidenceInvalid", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("uses stage-specific rolling floors and zero-tolerance daily correctness", () => {
    const manifest = compactPublicManifest();
    const evidence = completeRunEvidence(manifest);
    const continued = evidence.continuedBeta;
    expect(continued).not.toBeNull();
    if (continued === null) return;
    const splitRecords = continued.sloSplits.records.map((record) =>
      record.split === "stage:scheduledEmailOutcome"
        ? { ...record, eligibleRoots: 1_000, goodRootOutcomes: 999, rollingSevenDayRatio: 0.999 }
        : record,
    );
    const dailyRecords = continued.dailyEvidence.records.map((record, index) =>
      index === 10 ? { ...record, correctnessViolations: ["duplicateEffect" as const] } : record,
    );
    const sloSplits = {
      ...continued.sloSplits,
      checksum: qualificationChecksum(splitRecords),
      records: splitRecords,
    };
    const dailyEvidence = {
      ...continued.dailyEvidence,
      checksum: qualificationChecksum(dailyRecords),
      records: dailyRecords,
    };
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        continuedBeta: {
          ...continued,
          dailyEvidence,
          errorBudget28DayArtifactChecksum: qualificationChecksum({
            artifactId: continued.errorBudget28DayArtifactId,
            burnWindows: continued.burnWindows,
            dailyEvidenceChecksum: dailyEvidence.checksum,
            sloSplitsChecksum: sloSplits.checksum,
          }),
          sloSplits,
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "continuedBetaDailyEvidenceInvalid", verdict: "FAIL" }),
        expect.objectContaining({ code: "continuedBetaSplitEvidenceInvalid", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects an unbound observed trace with missing or impossible dimensions", () => {
    const manifest = compactPublicManifest();
    const evidence = completeRunEvidence(manifest);
    const continued = evidence.continuedBeta;
    expect(continued).not.toBeNull();
    if (continued === null) return;
    const records = [
      {
        acceptedRegisteredMessages: 25_000,
        amplificationDistribution: {},
        coldCauseBasisPoints: {
          deployment: 0,
          faultRecovery: 0,
          firstUse: 0,
          idleEviction: 0,
          warm: 10_000,
        },
        costUsdMicros: { p50: 1, p95: 2, p99: 3 },
        geographyBasisPoints: { americas: 10_001, asiaPacific: 0, europe: -1 },
        historyDepth: { p50: 1, p95: 2, p99: 3 },
        journeyMix: {
          accountBillingSafetyDataRights: 5,
          documentBuild: 2,
          fileAnalysis: 8,
          gmail: 4,
          ordinaryConversation: 67,
          registration: 5,
          reminder: 5,
          researchReport: 3,
          scheduledEmail: 1,
        },
        planMixBasisPoints: { adventurer: 1_000, free: 9_000 },
        productionDays: 30,
      },
    ];
    const traceArtifact = {
      artifactId: "observed-trace",
      checksum: qualificationChecksum(records),
      count: records.length,
      records,
      windowEndedAtUtc: continued.dailyEvidence.windowEndedAtUtc,
      windowStartedAtUtc: continued.dailyEvidence.windowStartedAtUtc,
    };
    expect(
      assessQualificationRuns(manifest, {
        ...evidence,
        continuedBeta: {
          ...continued,
          observedTraceReplacement: {
            acceptedRegisteredMessages: 25_000,
            artifactId: "unbound-wrapper",
            checksum: traceArtifact.checksum,
            productionDays: 30,
            traceArtifact,
          },
          productionDays: 30,
        },
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "observedTraceAmplificationMissing", verdict: "MISSING" }),
        expect.objectContaining({ code: "observedTraceReplacementInvalid", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });
});

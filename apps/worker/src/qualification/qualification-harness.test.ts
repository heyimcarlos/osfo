import { describe, expect, it } from "@effect/vitest";

import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "./qualification-manifest";
import { qualificationChecksum } from "./qualification-checksum";
import { assessRecovery } from "./recovery-evidence";
import { assessResourceHeadroom } from "./resource-headroom";
import { generateOpenArrivals } from "./workload-generation";
import {
  completeProductionEvidence,
  manifestVersions,
} from "../../test/support/qualification-fixtures";

describe("Production qualification harness", () => {
  it("freezes exact versions, corpora, mixes, windows, and Challenge Lanes", () => {
    const manifest = createBoundedBetaManifest(manifestVersions);

    expect(manifest).toMatchObject({
      acceptanceLevel: "BoundedBeta",
      corpus: { registeredUsers: 1_000, retainedRegisteredMessages: 57_000 },
      dependencyVersions: manifestVersions.dependencyVersions,
      manifestChecksum: manifest.manifestChecksum,
      manifestVersion: "production-qualification-v1",
      planMixBasisPoints: { adventurer: 1_000, free: 9_000 },
      sourceVersion: "45e5d17",
      topologyVersion: "cloudflare-v1",
      workloadSeed: 17,
    });
    expect(manifest.lanes.map((lane) => lane.kind)).toEqual([
      "baseline",
      "target",
      "stress",
      "linearRamp",
      "zeroToBurst",
      "allCold",
      "dependencyOutageRecovery",
    ]);
    expect(manifest.journeyMix.map(({ journey, percentage }) => [journey, percentage])).toEqual([
      ["registration", 5],
      ["ordinaryConversation", 67],
      ["fileAnalysis", 8],
      ["reminder", 5],
      ["gmail", 4],
      ["researchReport", 3],
      ["documentBuild", 2],
      ["scheduledEmail", 1],
      ["accountBillingSafetyDataRights", 5],
    ]);
    expect(manifest.lanes.every((lane) => lane.windows.at(-2)?.kind === "audit")).toBe(true);
    expect(manifest.lanes.every((lane) => lane.windows.at(-1)?.kind === "teardown")).toBe(true);
    expect(manifest.challengeLanes.at(-3)).toMatchObject({ kind: "rareJourney", mode: "isolated" });
    expect(manifest.challengeLanes.at(-2)).toMatchObject({
      kind: "allAdventurer",
      mode: "isolated",
    });
    expect(manifest.challengeLanes.at(-1)).toEqual({
      kind: "combinedTargetCascade",
      minimumEligibleRoots: "targetWindow",
      mode: "combined",
      offerDurationSeconds: "targetDuration",
      offeredRatePerSecond: "targetRate",
      planPolicy: "referenceMix",
      requiredJourneys: [],
      seedOffset: 20_003,
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.dependencyVersions)).toBe(true);
    expect(Object.isFrozen(manifest.lanes)).toBe(true);
  });

  it("generates a deterministic clock-driven open-arrival trace", () => {
    const manifest = createBoundedBetaManifest(manifestVersions);
    const arrivals = generateOpenArrivals({
      identityPrefix: "beta-target-1",
      journeyMix: manifest.journeyMix,
      planMixBasisPoints: manifest.planMixBasisPoints,
      seed: 17,
      startsAtEpochMs: 1_786_968_000_000,
      window: {
        durationSeconds: 1,
        endRatePerSecond: 100,
        kind: "offer",
        startRatePerSecond: 100,
      },
    });

    expect(arrivals).toHaveLength(100);
    expect(arrivals.slice(0, 3).map((arrival) => arrival.offeredAtEpochMs)).toEqual([
      1_786_968_000_005, 1_786_968_000_015, 1_786_968_000_025,
    ]);
    expect(new Set(arrivals.map((arrival) => arrival.rootId)).size).toBe(100);
    expect(arrivals.filter((arrival) => arrival.plan === "free")).toHaveLength(90);
  });

  it("freezes public regional rates and both retained Growth Corpora", () => {
    const manifest = createScaleQualifiedPublicManifest(manifestVersions);
    expect(manifest).toMatchObject({
      acceptanceLevel: "ScaleQualifiedPublic",
      corpus: { registeredUsers: 100_000, retainedRegisteredMessages: 5_700_000 },
      growthCorpora: [
        { kind: "width", registeredUsers: 1_000_000, retainedRegisteredMessages: 57_000_000 },
        {
          allowancePeriods: 12,
          kind: "depth",
          registeredUsers: 100_000,
          retainedRegisteredMessages: 68_400_000,
        },
      ],
      regions: ["americas", "europe", "asiaPacific"],
    });
    expect(
      manifest.lanes.find((lane) => lane.kind === "target")?.windows[0]?.startRatePerSecond,
    ).toBe(25);
    expect(
      manifest.lanes.find((lane) => lane.kind === "stress")?.windows[0]?.startRatePerSecond,
    ).toBe(50);
  });

  it("requires measured 30 percent headroom and rejects duplicate evidence", () => {
    const manifest = createBoundedBetaManifest(manifestVersions);
    const measurements = completeProductionEvidence().resourceUse;
    const firstMeasurement = measurements[0] ?? {
      limitName: "sqlQueries",
      maximumObserved: 700,
      region: "americas" as const,
      repetition: 1,
      runArtifactChecksum: qualificationChecksum({ repetition: 1 }),
      unit: "queries",
    };
    expect(assessResourceHeadroom(manifest, [])).toMatchObject({ verdict: "MISSING" });
    expect(
      assessResourceHeadroom(
        manifest,
        measurements.map((entry, index) =>
          index === 0 ? Object.assign({}, entry, { maximumObserved: 701 }) : entry,
        ),
      ),
    ).toMatchObject({ verdict: "FAIL" });
    expect(assessResourceHeadroom(manifest, measurements)).toEqual({
      findings: [],
      verdict: "PASS",
    });
    expect(
      assessResourceHeadroom(
        manifest,
        measurements.map(
          ({ authorityArtifact: _authorityArtifact, ...measurement }) => measurement,
        ),
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "resourceAuthorityEvidenceMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
    expect(
      assessResourceHeadroom(manifest, [
        ...measurements,
        Object.assign({}, firstMeasurement, { maximumObserved: 1 }),
      ]),
    ).toMatchObject({
      findings: [expect.objectContaining({ code: "duplicateHardLimitMeasurement" })],
      verdict: "FAIL",
    });
  });

  it("measures Recovery Reserve and rejects invalid measurements", () => {
    const evidence = completeProductionEvidence().recoveryRuns[0]?.evidence;
    expect(evidence).toBeDefined();
    if (evidence === undefined) return;
    expect(assessRecovery(evidence)).toEqual({
      findings: [],
      recoveryReservePerSecond: 2,
      verdict: "PASS",
    });
    const { authorityArtifact: _authorityArtifact, ...selfReported } = evidence;
    expect(assessRecovery(selfReported)).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "recoveryAuthorityEvidenceMissing", verdict: "MISSING" }),
      ]),
      recoveryReservePerSecond: null,
      verdict: "MISSING",
    });
    expect(assessRecovery({ ...evidence, recoveryGoodputPerSecond: 99 })).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "recoveryAuthorityMeasurementConflict" }),
      ]),
      verdict: "FAIL",
    });
    expect(
      assessRecovery({
        acceptedDemandPerSecond: -1,
        backlogSlopeBecameNegativeAfterSeconds: 240,
        interruptedAgentSettledAfterSeconds: 45,
        lostAcceptedRoots: 0,
        recoverableBacklogSettledAfterSeconds: 1_100,
        recoveryGoodputPerSecond: 7,
      }),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "recoveryEvidenceBoundaryInvalid" }),
      ]),
      verdict: "FAIL",
    });
  });
});

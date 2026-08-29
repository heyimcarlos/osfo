import { Data, Effect } from "effect";

import type {
  ChallengeLane,
  FaultInjection,
  ProductionQualificationManifest,
  ReferenceJourney,
  WorkloadLane,
  WorkloadWindow,
} from "./qualification-manifest";
import { expectedRunSeed } from "./qualification-manifest";
import type {
  ProductionQualificationEvidence,
  ProductionQualificationReport,
} from "./production-qualification";
import { qualifyProduction } from "./production-qualification";
import { qualificationChecksum } from "./qualification-checksum";
import { generateOpenArrivals, type OpenWorkloadArrival } from "./workload-generation";

export interface QualificationExecutionWindow extends WorkloadWindow {
  readonly endsAtEpochMs: number;
  readonly index: number;
  readonly startsAtEpochMs: number;
}

export interface QualificationCharacterizationArrival {
  readonly offeredAtEpochMs: number;
  readonly rootId: string;
}

interface QualificationExecutionRunBase {
  readonly arrivals: ReadonlyArray<OpenWorkloadArrival | QualificationCharacterizationArrival>;
  readonly endsAtEpochMs: number;
  readonly region: ProductionQualificationManifest["regions"][number];
  readonly runId: string;
  readonly seed: number;
  readonly startsAtEpochMs: number;
}

export interface QualificationLaneExecutionRun extends QualificationExecutionRunBase {
  readonly fault: FaultInjection | null;
  readonly kind: "lane";
  readonly lane: WorkloadLane["kind"];
  readonly repetition: number;
  readonly windows: ReadonlyArray<QualificationExecutionWindow>;
}

export interface QualificationChallengeExecutionRun extends QualificationExecutionRunBase {
  readonly challenge: ChallengeLane["kind"];
  readonly fault: FaultInjection | null;
  readonly kind: "challenge";
  readonly sequence: number;
  readonly windows: readonly [QualificationExecutionWindow];
}

export interface QualificationCharacterizationExecutionRun extends QualificationExecutionRunBase {
  readonly characterization: "historical232" | "historical464";
  readonly fault: null;
  readonly kind: "characterization";
  readonly windows: readonly [QualificationExecutionWindow];
}

export type QualificationExecutionRun =
  | QualificationLaneExecutionRun
  | QualificationChallengeExecutionRun
  | QualificationCharacterizationExecutionRun;

/** Reproducible executable suite derived from one frozen manifest and start instant. */
export interface QualificationExecutionPlan {
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly runs: ReadonlyArray<QualificationExecutionRun>;
  readonly sourceVersion: string;
  readonly startsAtEpochMs: number;
  readonly topologyVersion: string;
}

export interface QualificationExecutionDriver<E> {
  readonly collectEvidence: (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
  ) => Effect.Effect<ProductionQualificationEvidence, E>;
  readonly executeRun: (run: QualificationExecutionRun) => Effect.Effect<void, E>;
  readonly prepare: (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
  ) => Effect.Effect<void, E>;
  readonly teardown: (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
  ) => Effect.Effect<void, E>;
}

export class QualificationExecutionInvalid extends Data.TaggedError(
  "QualificationExecutionInvalid",
)<{ readonly message: string }> {}

const singletonWindow = (
  window: QualificationExecutionWindow,
): readonly [QualificationExecutionWindow] => [window];

const scheduleWindows = (
  windows: ReadonlyArray<WorkloadWindow>,
  startsAtEpochMs: number,
): ReadonlyArray<QualificationExecutionWindow> => {
  let cursor = startsAtEpochMs;
  return windows.map((window, index) => {
    const scheduled = Object.freeze({
      ...window,
      endsAtEpochMs: cursor + window.durationSeconds * 1_000,
      index,
      startsAtEpochMs: cursor,
    });
    cursor = scheduled.endsAtEpochMs;
    return scheduled;
  });
};

const journeyAt = (
  manifest: ProductionQualificationManifest,
  challenge: ChallengeLane,
  index: number,
): ReferenceJourney => {
  if (challenge.kind === "rareJourney" && index < challenge.requiredJourneys.length) {
    return challenge.requiredJourneys[index] ?? "ordinaryConversation";
  }
  if (challenge.planPolicy !== "referenceMix") return "ordinaryConversation";
  const bucket = index % 100;
  let upperBound = 0;
  for (const entry of manifest.journeyMix) {
    upperBound += entry.percentage;
    if (bucket < upperBound) return entry.journey;
  }
  return "ordinaryConversation";
};

const challengeArrivalCount = (
  manifest: ProductionQualificationManifest,
  challenge: ChallengeLane,
) => {
  const targetWindow = manifest.lanes
    .find(({ kind }) => kind === "target")
    ?.windows.find(({ kind }) => kind === "offer");
  const rate =
    challenge.offeredRatePerSecond === "targetRate"
      ? (targetWindow?.startRatePerSecond ?? 0)
      : challenge.offeredRatePerSecond;
  const durationSeconds =
    challenge.offerDurationSeconds === "targetDuration"
      ? (targetWindow?.durationSeconds ?? 0)
      : challenge.offerDurationSeconds;
  return { count: rate * durationSeconds, durationSeconds, rate };
};

const challengeArrivals = (
  manifest: ProductionQualificationManifest,
  challenge: ChallengeLane,
  identityPrefix: string,
  startsAtEpochMs: number,
): ReadonlyArray<OpenWorkloadArrival> => {
  const { count, rate } = challengeArrivalCount(manifest, challenge);
  return Array.from({ length: count }, (_, index) => ({
    journey: journeyAt(manifest, challenge, index),
    offeredAtEpochMs: startsAtEpochMs + Math.floor((index * 1_000) / rate),
    plan:
      challenge.planPolicy === "allAdventurer"
        ? "adventurer"
        : challenge.planPolicy === "referenceMix" && index % 10 === 9
          ? "adventurer"
          : "free",
    rootId: `${identityPrefix}-${index}`,
  }));
};

/** Build the exact lane, Challenge Lane, fault, and characterization execution schedule. */
export const createQualificationExecutionPlan = (
  manifest: ProductionQualificationManifest,
  startsAtEpochMs: number,
): QualificationExecutionPlan => {
  let cursor = startsAtEpochMs;
  const runs: Array<QualificationExecutionRun> = [];
  for (const region of manifest.regions) {
    for (const lane of manifest.lanes) {
      for (let repetition = 1; repetition <= lane.repetitions; repetition += 1) {
        const runId = `${manifest.acceptanceLevel}:${region}:${lane.kind}:${repetition}`;
        const seed = expectedRunSeed(manifest, lane.kind, region, repetition);
        const windows = scheduleWindows(lane.windows, cursor);
        const arrivals = windows.flatMap((window) =>
          window.kind === "offer" || window.kind === "fault"
            ? generateOpenArrivals({
                identityPrefix: runId,
                journeyMix: manifest.journeyMix,
                planMixBasisPoints: manifest.planMixBasisPoints,
                seed,
                startsAtEpochMs: window.startsAtEpochMs,
                window,
              })
            : [],
        );
        const fault =
          lane.kind === "dependencyOutageRecovery"
            ? (manifest.faults.find(({ kind }) => kind === "dependencyOutage") ?? null)
            : lane.kind === "allCold"
              ? (manifest.faults.find(({ kind }) => kind === "coldActivation") ?? null)
              : null;
        const endsAtEpochMs = windows.at(-1)?.endsAtEpochMs ?? cursor;
        runs.push(
          Object.freeze({
            arrivals: Object.freeze(arrivals),
            endsAtEpochMs,
            fault,
            kind: "lane",
            lane: lane.kind,
            region,
            repetition,
            runId,
            seed,
            startsAtEpochMs: cursor,
            windows: Object.freeze(windows),
          }),
        );
        cursor = endsAtEpochMs;
      }
    }

    for (const [challengeIndex, challenge] of manifest.challengeLanes.entries()) {
      const runId = `${manifest.acceptanceLevel}:${region}:challenge:${challenge.kind}`;
      const seed =
        manifest.workloadSeed + challenge.seedOffset + Array.from(manifest.regions).indexOf(region);
      const { durationSeconds, rate } = challengeArrivalCount(manifest, challenge);
      const windows = scheduleWindows(
        [{ durationSeconds, endRatePerSecond: rate, kind: "offer", startRatePerSecond: rate }],
        cursor,
      );
      const window = windows[0];
      if (window === undefined) continue;
      const arrivals = challengeArrivals(manifest, challenge, runId, cursor);
      const fault = manifest.faults.find(({ kind }) => kind === challenge.kind) ?? null;
      runs.push(
        Object.freeze({
          arrivals: Object.freeze(arrivals),
          challenge: challenge.kind,
          endsAtEpochMs: window.endsAtEpochMs,
          fault,
          kind: "challenge",
          region,
          runId,
          seed,
          sequence: challengeIndex + 1,
          startsAtEpochMs: cursor,
          windows: Object.freeze(singletonWindow(window)),
        }),
      );
      cursor = window.endsAtEpochMs;
    }

    for (const characterization of manifest.characterizationLanes) {
      const runId = `${manifest.acceptanceLevel}:${region}:${characterization.kind}`;
      const windows = scheduleWindows(
        [
          {
            durationSeconds: characterization.durationSeconds,
            endRatePerSecond: characterization.offeredRatePerSecond,
            kind: "offer",
            startRatePerSecond: characterization.offeredRatePerSecond,
          },
        ],
        cursor,
      );
      const window = windows[0];
      if (window === undefined) continue;
      const arrivals = Array.from(
        { length: characterization.offeredRatePerSecond * characterization.durationSeconds },
        (_, index) => ({
          offeredAtEpochMs:
            cursor + Math.floor((index * 1_000) / characterization.offeredRatePerSecond),
          rootId: `${runId}-${index}`,
        }),
      );
      runs.push(
        Object.freeze({
          arrivals: Object.freeze(arrivals),
          characterization: characterization.kind,
          endsAtEpochMs: window.endsAtEpochMs,
          fault: null,
          kind: "characterization",
          region,
          runId,
          seed: manifest.workloadSeed,
          startsAtEpochMs: cursor,
          windows: Object.freeze(singletonWindow(window)),
        }),
      );
      cursor = window.endsAtEpochMs;
    }
  }
  const content = {
    manifestChecksum: manifest.manifestChecksum,
    runs: Object.freeze(runs),
    sourceVersion: manifest.sourceVersion,
    startsAtEpochMs,
    topologyVersion: manifest.topologyVersion,
  };
  return Object.freeze({ ...content, planChecksum: qualificationChecksum(content) });
};

/** Execute every planned run, always tear down, then evaluate retained evidence once. */
export const executeQualification = Effect.fn("ProductionQualification.execute")(function* <E>({
  driver,
  manifest,
  plan,
}: {
  readonly driver: QualificationExecutionDriver<E>;
  readonly manifest: ProductionQualificationManifest;
  readonly plan: QualificationExecutionPlan;
}): Effect.fn.Return<ProductionQualificationReport, E | QualificationExecutionInvalid> {
  const { planChecksum, ...content } = plan;
  if (
    plan.manifestChecksum !== manifest.manifestChecksum ||
    plan.sourceVersion !== manifest.sourceVersion ||
    plan.topologyVersion !== manifest.topologyVersion ||
    planChecksum !== qualificationChecksum(content)
  ) {
    return yield* new QualificationExecutionInvalid({
      message: "Execution plan is not bound to the manifest",
    });
  }
  return yield* Effect.gen(function* () {
    yield* driver.prepare(manifest, plan);
    yield* Effect.forEach(plan.runs, driver.executeRun, { discard: true });
    const evidence = yield* driver.collectEvidence(manifest, plan);
    if (
      evidence.manifest.manifestChecksum !== manifest.manifestChecksum ||
      evidence.manifest.sourceVersion !== manifest.sourceVersion ||
      evidence.manifest.topologyVersion !== manifest.topologyVersion
    ) {
      return yield* new QualificationExecutionInvalid({
        message: "Collected evidence is not bound to the executed manifest",
      });
    }
    return qualifyProduction(evidence);
  }).pipe(Effect.ensuring(driver.teardown(manifest, plan).pipe(Effect.orDie)));
});

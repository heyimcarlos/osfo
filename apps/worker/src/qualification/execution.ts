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
  QualificationRunExecutionReceipt,
} from "./production-qualification";
import { qualificationRunExecutionReceipt, qualifyProduction } from "./production-qualification";
import { qualificationChecksum } from "./qualification-checksum";
import {
  openArrivalCount,
  openWorkloadArrivalAt,
  type OpenWorkloadArrival,
} from "./workload-generation";

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
  /** Exact cardinality; arrivals are derived lazily with qualificationRunArrivals. */
  readonly arrivalCount: number;
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

/** Reproducible compact suite derived from one frozen manifest and start instant. */
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
    runReceipts: ReadonlyArray<QualificationRunExecutionReceipt>,
  ) => Effect.Effect<ProductionQualificationEvidence, E>;
  readonly executeRun: (
    manifest: ProductionQualificationManifest,
    run: QualificationExecutionRun,
  ) => Effect.Effect<QualificationRunExecutionReceipt, E>;
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

const laneArrivalCount = (windows: ReadonlyArray<QualificationExecutionWindow>): number =>
  windows.reduce(
    (total, window) =>
      window.kind === "offer" || window.kind === "fault" ? total + openArrivalCount(window) : total,
    0,
  );

/**
 * Derive one run's arrivals on demand. Drivers must consume this iterator as a
 * clock-driven stream; the plan intentionally retains no per-arrival objects.
 */
export function* qualificationRunArrivals(
  manifest: ProductionQualificationManifest,
  run: QualificationExecutionRun,
): IterableIterator<OpenWorkloadArrival | QualificationCharacterizationArrival> {
  if (run.kind === "lane") {
    for (const window of run.windows) {
      if (window.kind !== "offer" && window.kind !== "fault") continue;
      const count = openArrivalCount(window);
      const input = {
        identityPrefix: `${run.runId}:window:${window.index}`,
        journeyMix: manifest.journeyMix,
        planMixBasisPoints: manifest.planMixBasisPoints,
        seed: run.seed + window.index,
        startsAtEpochMs: window.startsAtEpochMs,
        window,
      };
      for (let index = 0; index < count; index += 1) {
        yield openWorkloadArrivalAt(input, index);
      }
    }
    return;
  }

  if (run.kind === "challenge") {
    const challenge = manifest.challengeLanes.find(({ kind }) => kind === run.challenge);
    const window = run.windows[0];
    if (challenge === undefined) return;
    const rate = window.startRatePerSecond;
    for (let index = 0; index < run.arrivalCount; index += 1) {
      yield {
        journey: journeyAt(manifest, challenge, index),
        offeredAtEpochMs: window.startsAtEpochMs + Math.floor((index * 1_000) / rate),
        plan:
          challenge.planPolicy === "allAdventurer"
            ? "adventurer"
            : challenge.planPolicy === "referenceMix" && index % 10 === 9
              ? "adventurer"
              : "free",
        rootId: `${run.runId}:${index}`,
      };
    }
    return;
  }

  const window = run.windows[0];
  const rate = window.startRatePerSecond;
  for (let index = 0; index < run.arrivalCount; index += 1) {
    yield {
      offeredAtEpochMs: window.startsAtEpochMs + Math.floor((index * 1_000) / rate),
      rootId: `${run.runId}:${index}`,
    };
  }
}

const plannedRuns = function* (
  manifest: ProductionQualificationManifest,
  startsAtEpochMs: number,
): IterableIterator<QualificationExecutionRun> {
  let cursor = startsAtEpochMs;
  for (const region of manifest.regions) {
    for (const lane of manifest.lanes) {
      for (let repetition = 1; repetition <= lane.repetitions; repetition += 1) {
        const runId = `${manifest.acceptanceLevel}:${region}:${lane.kind}:${repetition}`;
        const seed = expectedRunSeed(manifest, lane.kind, region, repetition);
        const windows = scheduleWindows(lane.windows, cursor);
        const fault =
          lane.kind === "dependencyOutageRecovery"
            ? (manifest.faults.find(({ kind }) => kind === "dependencyOutage") ?? null)
            : lane.kind === "allCold"
              ? (manifest.faults.find(({ kind }) => kind === "coldActivation") ?? null)
              : null;
        const endsAtEpochMs = windows.at(-1)?.endsAtEpochMs ?? cursor;
        yield Object.freeze({
          arrivalCount: laneArrivalCount(windows),
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
        });
        cursor = endsAtEpochMs;
      }
    }

    for (const [challengeIndex, challenge] of manifest.challengeLanes.entries()) {
      const runId = `${manifest.acceptanceLevel}:${region}:challenge:${challenge.kind}`;
      const seed =
        manifest.workloadSeed + challenge.seedOffset + Array.from(manifest.regions).indexOf(region);
      const { count, durationSeconds, rate } = challengeArrivalCount(manifest, challenge);
      const windows = scheduleWindows(
        [{ durationSeconds, endRatePerSecond: rate, kind: "offer", startRatePerSecond: rate }],
        cursor,
      );
      const window = windows[0];
      if (window === undefined) continue;
      const fault = manifest.faults.find(({ kind }) => kind === challenge.kind) ?? null;
      yield Object.freeze({
        arrivalCount: count,
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
      });
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
      yield Object.freeze({
        arrivalCount: characterization.offeredRatePerSecond * characterization.durationSeconds,
        characterization: characterization.kind,
        endsAtEpochMs: window.endsAtEpochMs,
        fault: null,
        kind: "characterization",
        region,
        runId,
        seed: manifest.workloadSeed,
        startsAtEpochMs: cursor,
        windows: Object.freeze(singletonWindow(window)),
      });
      cursor = window.endsAtEpochMs;
    }
  }
};

/** Build the exact compact lane, Challenge Lane, fault, and characterization schedule. */
export const createQualificationExecutionPlan = (
  manifest: ProductionQualificationManifest,
  startsAtEpochMs: number,
): QualificationExecutionPlan => {
  const runs = Object.freeze(Array.from(plannedRuns(manifest, startsAtEpochMs)));
  const content = {
    manifestChecksum: manifest.manifestChecksum,
    runs,
    sourceVersion: manifest.sourceVersion,
    startsAtEpochMs,
    topologyVersion: manifest.topologyVersion,
  };
  return Object.freeze({ ...content, planChecksum: qualificationChecksum(content) });
};

/** Build the persisted receipt shape a driver must retain after executing one run. */
export const qualificationExecutionReceiptForRun = (
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  arrivalArtifactChecksum: string,
  artifactId: string,
): QualificationRunExecutionReceipt =>
  qualificationRunExecutionReceipt({
    arrivalArtifactChecksum,
    arrivalCount: run.arrivalCount,
    artifactId,
    endedAtEpochMs: run.endsAtEpochMs,
    planChecksum: plan.planChecksum,
    runDescriptorChecksum: qualificationChecksum(run),
    runId: run.runId,
    startedAtEpochMs: run.startsAtEpochMs,
    windowsChecksum: qualificationChecksum(run.windows),
  });

const hasExpectedRuns = (
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
): boolean => {
  const expected = plannedRuns(manifest, plan.startsAtEpochMs);
  for (const actual of plan.runs) {
    const next = expected.next();
    if (next.done || qualificationChecksum(actual) !== qualificationChecksum(next.value)) {
      return false;
    }
  }
  return expected.next().done === true;
};

const hasExpectedRunReceipts = (
  plan: QualificationExecutionPlan,
  receipts: ReadonlyArray<QualificationRunExecutionReceipt>,
): boolean =>
  receipts.length === plan.runs.length &&
  receipts.every((receipt, index) => {
    const run = plan.runs[index];
    if (run === undefined) return false;
    const { artifactChecksum, ...content } = receipt;
    return (
      artifactChecksum === qualificationChecksum(content) &&
      receipt.arrivalArtifactChecksum.length > 0 &&
      receipt.artifactId.length > 0 &&
      receipt.planChecksum === plan.planChecksum &&
      receipt.runId === run.runId &&
      receipt.runDescriptorChecksum === qualificationChecksum(run) &&
      receipt.windowsChecksum === qualificationChecksum(run.windows) &&
      receipt.arrivalCount === run.arrivalCount &&
      receipt.startedAtEpochMs === run.startsAtEpochMs &&
      receipt.endedAtEpochMs === run.endsAtEpochMs
    );
  });

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
    planChecksum !== qualificationChecksum(content) ||
    !hasExpectedRuns(manifest, plan)
  ) {
    return yield* new QualificationExecutionInvalid({
      message: "Execution plan is not bound to the manifest",
    });
  }
  return yield* Effect.gen(function* () {
    yield* driver.prepare(manifest, plan);
    const runReceipts = yield* Effect.forEach(plan.runs, (run) => driver.executeRun(manifest, run));
    if (!hasExpectedRunReceipts(plan, runReceipts)) {
      return yield* new QualificationExecutionInvalid({
        message: "Run execution receipts do not prove the exact frozen plan",
      });
    }
    const evidence = yield* driver.collectEvidence(manifest, plan, runReceipts);
    if (
      evidence.manifest.manifestChecksum !== manifest.manifestChecksum ||
      evidence.manifest.sourceVersion !== manifest.sourceVersion ||
      evidence.manifest.topologyVersion !== manifest.topologyVersion ||
      evidence.execution.planChecksum !== plan.planChecksum ||
      qualificationChecksum(evidence.execution.runReceipts) !== qualificationChecksum(runReceipts)
    ) {
      return yield* new QualificationExecutionInvalid({
        message: "Collected evidence is not bound to the executed manifest and plan",
      });
    }
    return qualifyProduction(evidence);
  }).pipe(Effect.onExit(() => driver.teardown(manifest, plan)));
});

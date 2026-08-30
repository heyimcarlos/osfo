import { Clock, Data, DateTime, Duration, Effect, Fiber, Schema, Stream } from "effect";

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
import {
  qualificationExecutionEvidence,
  qualificationRunExecutionReceipt,
  qualifyProduction,
  unavailableProductionQualificationReport,
} from "./production-qualification";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import type { FaultControllerReceipt } from "./qualification-runs";
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
  readonly executionId: string;
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
  readonly verifyRun: (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
    run: QualificationExecutionRun,
    receipt: QualificationRunExecutionReceipt,
  ) => Effect.Effect<void, E | QualificationExecutionInvalid>;
}

/** Immutable bytes used for retained qualification execution artifacts. */
export interface QualificationExecutionArtifactStore<E> {
  readonly read: (artifactId: string) => Effect.Effect<string | null, E>;
  readonly writeImmutable: (artifactId: string, encoded: string) => Effect.Effect<void, E>;
}

export interface QualificationArrivalAuthorityRecord {
  readonly attemptId: string;
  readonly authorityFactId: string;
  readonly executedAtUtc: string;
  readonly executionId: string;
  readonly rootId: string;
  readonly submittedAtUtc: string;
}

/** Stable authority idempotency identity for one offered root. */
export interface QualificationArrivalAttempt {
  readonly attemptId: string;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly runId: string;
}

/** Frozen idempotency and trigger contract for one controller operation. */
export interface QualificationFaultAttempt {
  readonly attemptId: string;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly requiresAuthorityFact: boolean;
  readonly runId: string;
  readonly scheduledTriggerAtUtc: string;
}

export type QualificationAuthorityReadPhase = "collect" | "reload";

type AuthorityRead<K extends keyof ProductionQualificationEvidence, E> = (
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  phase: QualificationAuthorityReadPhase,
) => Effect.Effect<ProductionQualificationEvidence[K], E>;

/**
 * Authority-specific adapters expose retained facts, never a preassembled verdict input.
 * The production harness owns manifest and execution provenance and assembles the bundle.
 */
export interface QualificationAuthorityCollectors<E> {
  readonly cost: AuthorityRead<"cost", E>;
  readonly externalGates: AuthorityRead<"externalGates", E>;
  readonly memorySemantic: AuthorityRead<"memorySemantic", E>;
  readonly recoveryRuns: AuthorityRead<"recoveryRuns", E>;
  readonly resourceUse: AuthorityRead<"resourceUse", E>;
  readonly runs: AuthorityRead<"runs", E>;
  readonly semantic: AuthorityRead<"semantic", E>;
  readonly stages: AuthorityRead<"stages", E>;
}

/** Production ports: the harness owns arrival enumeration, retention, and verification. */
export interface DurableQualificationExecutionPorts<E> {
  readonly applyFault: (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
    run: QualificationExecutionRun,
    fault: FaultInjection,
    attempt: QualificationFaultAttempt,
  ) => Effect.Effect<FaultControllerReceipt, E>;
  readonly artifacts: QualificationExecutionArtifactStore<E>;
  readonly authorities: QualificationAuthorityCollectors<E>;
  readonly executeArrival: (
    manifest: ProductionQualificationManifest,
    run: QualificationExecutionRun,
    arrival: OpenWorkloadArrival | QualificationCharacterizationArrival,
    attempt: QualificationArrivalAttempt,
  ) => Effect.Effect<QualificationArrivalAuthorityRecord, E>;
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
  for (let index = 0; index < run.arrivalCount; index += 1) {
    const arrival = qualificationRunArrivalAt(manifest, run, index);
    if (arrival !== undefined) yield arrival;
  }
}

/** Derive one canonical arrival without materializing or replaying the preceding workload. */
export const qualificationRunArrivalAt = (
  manifest: ProductionQualificationManifest,
  run: QualificationExecutionRun,
  index: number,
): OpenWorkloadArrival | QualificationCharacterizationArrival | undefined => {
  if (!Number.isInteger(index) || index < 0 || index >= run.arrivalCount) return undefined;
  if (run.kind === "lane") {
    let windowOffset = index;
    for (const window of run.windows) {
      if (window.kind !== "offer" && window.kind !== "fault") continue;
      const count = openArrivalCount(window);
      if (windowOffset >= count) {
        windowOffset -= count;
        continue;
      }
      return openWorkloadArrivalAt(
        {
          identityPrefix: run.runId,
          journeyMix: manifest.journeyMix,
          planMixBasisPoints: manifest.planMixBasisPoints,
          seed: run.seed,
          startsAtEpochMs: window.startsAtEpochMs,
          window,
        },
        windowOffset,
      );
    }
    return undefined;
  }
  const window = run.windows[0];
  const rate = window.startRatePerSecond;
  if (run.kind === "challenge") {
    const challenge = manifest.challengeLanes.find(({ kind }) => kind === run.challenge);
    if (challenge === undefined) return undefined;
    return {
      journey: journeyAt(manifest, challenge, index),
      offeredAtEpochMs: window.startsAtEpochMs + Math.floor((index * 1_000) / rate),
      plan:
        challenge.planPolicy === "allAdventurer"
          ? "adventurer"
          : challenge.planPolicy === "referenceMix" && index % 10 === 9
            ? "adventurer"
            : "free",
      rootId: `${run.runId}-${index}`,
    };
  }
  return {
    offeredAtEpochMs: window.startsAtEpochMs + Math.floor((index * 1_000) / rate),
    rootId: `${run.runId}:${index}`,
  };
};

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
      const endsAtEpochMs = Math.max(
        window.endsAtEpochMs,
        cursor + (fault?.durationSeconds ?? 0) * 1_000,
      );
      yield Object.freeze({
        arrivalCount: count,
        challenge: challenge.kind,
        endsAtEpochMs,
        fault,
        kind: "challenge",
        region,
        runId,
        seed,
        sequence: challengeIndex + 1,
        startsAtEpochMs: cursor,
        windows: Object.freeze(singletonWindow(window)),
      });
      cursor = endsAtEpochMs;
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
  executionId: string,
): QualificationExecutionPlan => {
  const runs = Object.freeze(Array.from(plannedRuns(manifest, startsAtEpochMs)));
  const content = {
    executionId,
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
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    runDescriptorChecksum: qualificationChecksum(run),
    runId: run.runId,
    startedAtEpochMs: run.startsAtEpochMs,
    windowsChecksum: qualificationChecksum(run.windows),
  });

const StoredArrival = Schema.Union([
  Schema.Struct({
    journey: Schema.Literals([
      "accountBillingSafetyDataRights",
      "documentBuild",
      "fileAnalysis",
      "gmail",
      "ordinaryConversation",
      "registration",
      "reminder",
      "researchReport",
      "scheduledEmail",
    ]),
    offeredAtEpochMs: Schema.Finite,
    plan: Schema.Literals(["adventurer", "free"]),
    rootId: Schema.String,
  }),
  Schema.Struct({ offeredAtEpochMs: Schema.Finite, rootId: Schema.String }),
]);
const StoredArrivalRecord = Schema.Struct({
  arrival: StoredArrival,
  attemptId: Schema.String,
  authorityFactId: Schema.String,
  executedAtUtc: Schema.String,
  executionId: Schema.String,
  rootId: Schema.String,
  submittedAtUtc: Schema.String,
});
const StoredArrivalChunk = Schema.Struct({
  artifactChecksum: Schema.String,
  chunkIndex: Schema.Int,
  executionId: Schema.String,
  planChecksum: Schema.String,
  records: Schema.Array(StoredArrivalRecord),
  runId: Schema.String,
});
const StoredRunManifest = Schema.Struct({
  arrivalCount: Schema.Int,
  artifactChecksum: Schema.String,
  chunks: Schema.Array(
    Schema.Struct({
      artifactChecksum: Schema.String,
      artifactId: Schema.String,
      count: Schema.Int,
      index: Schema.Int,
    }),
  ),
  executionId: Schema.String,
  faultReceipt: Schema.NullOr(
    Schema.Struct({
      applicationAuthorityFactId: Schema.String,
      applicationStatus: Schema.Literals(["applied", "notApplied"]),
      artifactChecksum: Schema.String,
      artifactId: Schema.String,
      controllerOperationId: Schema.String,
      controllerSource: Schema.String,
      durationSeconds: Schema.Int,
      endedAtUtc: Schema.String,
      executionId: Schema.String,
      injectedAtUtc: Schema.String,
      kind: Schema.String,
      manifestChecksum: Schema.String,
      planChecksum: Schema.String,
      runId: Schema.String,
      restorationAuthorityFactId: Schema.String,
      scheduledTriggerAtUtc: Schema.String,
      target: Schema.String,
      trigger: Schema.String,
      triggerAuthorityFactId: Schema.NullOr(Schema.String),
      triggerObservedAtUtc: Schema.String,
    }),
  ),
  planChecksum: Schema.String,
  runDescriptorChecksum: Schema.String,
  runId: Schema.String,
});
const StoredPlanArtifact = Schema.Struct({
  artifactChecksum: Schema.String,
  encodedPlan: Schema.String,
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
});
const StoredAuthorityBundle = Schema.Struct({
  artifactChecksum: Schema.String,
  componentChecksums: Schema.Struct({
    cost: Schema.String,
    externalGates: Schema.String,
    memorySemantic: Schema.String,
    recoveryRuns: Schema.String,
    resourceUse: Schema.String,
    runs: Schema.String,
    semantic: Schema.String,
    stages: Schema.String,
  }),
  evidenceArtifactChecksum: Schema.String,
  evidenceArtifactId: Schema.String,
  evidenceChecksum: Schema.String,
  executionId: Schema.String,
  planChecksum: Schema.String,
  runReceiptsChecksum: Schema.String,
  sourceVersion: Schema.String,
  topologyVersion: Schema.String,
});
const EncodedArrivalChunk = Schema.fromJsonString(StoredArrivalChunk);
const EncodedRunManifest = Schema.fromJsonString(StoredRunManifest);
const EncodedPlanArtifact = Schema.fromJsonString(StoredPlanArtifact);
const EncodedAuthorityBundle = Schema.fromJsonString(StoredAuthorityBundle);
const EncodedUnknown = Schema.fromJsonString(Schema.Unknown);
type StoredArrivalChunk = typeof StoredArrivalChunk.Type;
type StoredRunManifest = typeof StoredRunManifest.Type;

const executionArtifactPrefix = (executionId: string): string =>
  `qualification/executions/${encodeURIComponent(executionId)}`;
const runArtifactPrefix = (plan: QualificationExecutionPlan, run: QualificationExecutionRun) =>
  `${executionArtifactPrefix(plan.executionId)}/runs/${encodeURIComponent(run.runId)}`;
const invalidExecution = (message: string) => new QualificationExecutionInvalid({ message });
const encodeArtifact = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError(() => invalidExecution("Qualification execution artifact cannot be encoded")),
  );
const decodeArtifact = <A, I>(schema: Schema.Codec<A, I>, encoded: I) =>
  Schema.decodeEffect(schema)(encoded).pipe(
    Effect.mapError(() => invalidExecution("Qualification execution artifact cannot be decoded")),
  );

const retainAndVerifyPlan = <E>(
  artifacts: QualificationExecutionArtifactStore<E>,
  plan: QualificationExecutionPlan,
) =>
  Effect.gen(function* () {
    const encodedPlan = yield* encodeArtifact(EncodedUnknown, plan);
    const content = {
      encodedPlan,
      executionId: plan.executionId,
      manifestChecksum: plan.manifestChecksum,
      planChecksum: plan.planChecksum,
    };
    const artifact = { ...content, artifactChecksum: qualificationChecksum(content) };
    const artifactId = `${executionArtifactPrefix(plan.executionId)}/plan.json`;
    yield* artifacts.writeImmutable(
      artifactId,
      yield* encodeArtifact(EncodedPlanArtifact, artifact),
    );
    const retainedEncoded = yield* artifacts.read(artifactId);
    if (retainedEncoded === null)
      return yield* invalidExecution("Execution plan is missing after write");
    const retained = yield* decodeArtifact(EncodedPlanArtifact, retainedEncoded);
    const { artifactChecksum, ...retainedContent } = retained;
    if (
      artifactChecksum !== qualificationChecksum(retainedContent) ||
      artifactChecksum !== artifact.artifactChecksum ||
      retained.encodedPlan !== encodedPlan ||
      retained.executionId !== plan.executionId ||
      retained.manifestChecksum !== plan.manifestChecksum ||
      retained.planChecksum !== plan.planChecksum
    ) {
      return yield* invalidExecution("Retained execution plan conflicts after reload");
    }
    return undefined;
  });

const arrivalAttemptFor = (
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  arrival: OpenWorkloadArrival | QualificationCharacterizationArrival,
): QualificationArrivalAttempt => {
  const content = {
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    rootId: arrival.rootId,
    runId: run.runId,
  };
  return { ...content, attemptId: qualificationChecksum(content) };
};

const validateArrivalAuthority = (
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  arrival: OpenWorkloadArrival | QualificationCharacterizationArrival,
  authority: QualificationArrivalAuthorityRecord,
) => {
  const attempt = arrivalAttemptFor(plan, run, arrival);
  const submittedAt = Date.parse(authority.submittedAtUtc);
  const executedAt = Date.parse(authority.executedAtUtc);
  return (
    authority.attemptId === attempt.attemptId &&
    authority.executionId === plan.executionId &&
    authority.rootId === arrival.rootId &&
    authority.authorityFactId.length > 0 &&
    Number.isFinite(submittedAt) &&
    Number.isFinite(executedAt) &&
    submittedAt >= arrival.offeredAtEpochMs &&
    executedAt >= submittedAt
  );
};

const maximumOfferLagMs = 250;

const authorityTriggeredFaults = new Set([
  "afterAcceptanceBeforeUpdate",
  "afterConfirmedProgress",
  "afterExternalEffectBeforeStepCommit",
  "afterFirstAcceptance",
  "afterProviderAcceptanceBeforeResponse",
  "beforeProviderContact",
  "simultaneousAdmission",
]);

const faultAttemptFor = (
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  fault: FaultInjection,
): QualificationFaultAttempt => {
  const triggerWindowKind =
    fault.trigger === "startOfFaultWindow"
      ? "fault"
      : fault.trigger === "startOfOfferWindow"
        ? "offer"
        : undefined;
  const scheduledTriggerAtEpochMs =
    run.windows.find(({ kind }) => kind === triggerWindowKind)?.startsAtEpochMs ??
    run.startsAtEpochMs;
  const content = {
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    requiresAuthorityFact: authorityTriggeredFaults.has(fault.trigger),
    runId: run.runId,
    scheduledTriggerAtUtc: DateTime.formatIso(DateTime.makeUnsafe(scheduledTriggerAtEpochMs)),
  };
  return { ...content, attemptId: qualificationChecksum(content) };
};

const validateFaultReceipt = (
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  fault: FaultInjection,
  attempt: QualificationFaultAttempt,
  receipt: FaultControllerReceipt,
): boolean => {
  const { artifactChecksum, ...content } = receipt;
  const scheduledAt = Date.parse(receipt.scheduledTriggerAtUtc);
  const observedAt = Date.parse(receipt.triggerObservedAtUtc);
  const injectedAt = Date.parse(receipt.injectedAtUtc);
  const endedAt = Date.parse(receipt.endedAtUtc);
  const controlledBeforeOffer =
    receipt.kind === "coldActivation" &&
    receipt.target === "osfoAgent" &&
    receipt.trigger === "beforeOffer";
  return (
    artifactChecksum === qualificationChecksum(content) &&
    receipt.applicationStatus === "applied" &&
    receipt.applicationAuthorityFactId.length > 0 &&
    receipt.restorationAuthorityFactId.length > 0 &&
    receipt.applicationAuthorityFactId !== receipt.restorationAuthorityFactId &&
    receipt.executionId === plan.executionId &&
    receipt.manifestChecksum === manifest.manifestChecksum &&
    receipt.planChecksum === plan.planChecksum &&
    receipt.runId === run.runId &&
    receipt.kind === fault.kind &&
    receipt.target === fault.target &&
    receipt.trigger === fault.trigger &&
    receipt.durationSeconds === fault.durationSeconds &&
    receipt.scheduledTriggerAtUtc === attempt.scheduledTriggerAtUtc &&
    Number.isFinite(scheduledAt) &&
    Number.isFinite(observedAt) &&
    Number.isFinite(injectedAt) &&
    (controlledBeforeOffer
      ? receipt.triggerAuthorityFactId === null &&
        observedAt === injectedAt &&
        injectedAt <= endedAt &&
        endedAt <= scheduledAt
      : observedAt >= scheduledAt &&
        injectedAt >= observedAt &&
        endedAt === injectedAt + receipt.durationSeconds * 1_000 &&
        (attempt.requiresAuthorityFact
          ? receipt.triggerAuthorityFactId !== null
          : receipt.triggerAuthorityFactId === null &&
            injectedAt - scheduledAt <= maximumOfferLagMs))
  );
};

const executeOpenArrival = <E>(
  ports: DurableQualificationExecutionPorts<E>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  arrival: OpenWorkloadArrival | QualificationCharacterizationArrival,
) =>
  Effect.gen(function* () {
    const delayMs = arrival.offeredAtEpochMs - (yield* Clock.currentTimeMillis);
    if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs));
    const offeredAt = yield* Clock.currentTimeMillis;
    if (offeredAt - arrival.offeredAtEpochMs > maximumOfferLagMs) {
      return yield* invalidExecution(
        `${run.runId} exceeded open-arrival offer lag for ${arrival.rootId}`,
      );
    }
    const attempt = arrivalAttemptFor(plan, run, arrival);
    const authority = yield* ports.executeArrival(manifest, run, arrival, attempt);
    if (!validateArrivalAuthority(plan, run, arrival, authority)) {
      return yield* invalidExecution(`${run.runId} returned invalid arrival authority`);
    }
    return {
      arrival,
      attemptId: authority.attemptId,
      authorityFactId: authority.authorityFactId,
      executedAtUtc: authority.executedAtUtc,
      executionId: plan.executionId,
      rootId: arrival.rootId,
      submittedAtUtc: authority.submittedAtUtc,
    } satisfies StoredArrivalChunk["records"][number];
  });

/** Drive one bounded chunk from offered timestamps without waiting for prior completions. */
export const executeOpenArrivalChunk = <E>(
  ports: DurableQualificationExecutionPorts<E>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  arrivals: ReadonlyArray<OpenWorkloadArrival | QualificationCharacterizationArrival>,
) =>
  Effect.forEach(arrivals, (arrival) => executeOpenArrival(ports, manifest, plan, run, arrival), {
    concurrency: 256,
  });

const validateStoredChunk = (
  chunk: StoredArrivalChunk,
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  chunkIndex: number,
  arrivals: ReadonlyArray<OpenWorkloadArrival | QualificationCharacterizationArrival>,
): boolean => {
  const { artifactChecksum, ...content } = chunk;
  return (
    artifactChecksum === qualificationChecksum(content) &&
    chunk.chunkIndex === chunkIndex &&
    chunk.executionId === plan.executionId &&
    chunk.planChecksum === plan.planChecksum &&
    chunk.runId === run.runId &&
    chunk.records.length === arrivals.length &&
    chunk.records.every((record, index) => {
      const arrival = arrivals[index];
      return (
        arrival !== undefined &&
        qualificationChecksum(record.arrival) === qualificationChecksum(arrival) &&
        record.executionId === plan.executionId &&
        validateArrivalAuthority(plan, run, arrival, record)
      );
    })
  );
};

export const retainDurableQualificationRun = <E>(
  ports: DurableQualificationExecutionPorts<E>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
) =>
  Effect.gen(function* () {
    const faultAttempt = run.fault === null ? null : faultAttemptFor(plan, run, run.fault);
    const faultIsBarrier = run.fault !== null && !authorityTriggeredFaults.has(run.fault.trigger);
    const barrierFaultReceipt =
      run.fault === null || faultAttempt === null || !faultIsBarrier
        ? null
        : yield* ports.applyFault(manifest, plan, run, run.fault, faultAttempt);
    const faultFiber =
      run.fault === null || faultAttempt === null || faultIsBarrier
        ? null
        : yield* ports
            .applyFault(manifest, plan, run, run.fault, faultAttempt)
            .pipe(Effect.forkChild);
    const chunks: Array<StoredRunManifest["chunks"][number]> = [];
    const expected = qualificationRunArrivals(manifest, run);
    let chunkIndex = 0;
    let firstMissing: Array<OpenWorkloadArrival | QualificationCharacterizationArrival> = [];
    while (firstMissing.length === 0) {
      const expectedChunk: Array<OpenWorkloadArrival | QualificationCharacterizationArrival> = [];
      while (expectedChunk.length < 256) {
        const next = expected.next();
        if (next.done) break;
        expectedChunk.push(next.value);
      }
      if (expectedChunk.length === 0) break;
      const artifactId = `${runArtifactPrefix(plan, run)}/arrivals-${chunkIndex}.json`;
      const existing = yield* ports.artifacts.read(artifactId);
      if (existing === null) {
        firstMissing = expectedChunk;
        break;
      }
      const artifact = yield* decodeArtifact(EncodedArrivalChunk, existing);
      if (!validateStoredChunk(artifact, plan, run, chunkIndex, expectedChunk)) {
        return yield* invalidExecution(`${run.runId} retained arrival chunk conflicts`);
      }
      chunks.push({
        artifactChecksum: artifact.artifactChecksum,
        artifactId,
        count: expectedChunk.length,
        index: chunkIndex,
      });
      chunkIndex += 1;
    }
    const remaining = {
      *[Symbol.iterator]() {
        yield* firstMissing;
        for (let next = expected.next(); !next.done; next = expected.next()) yield next.value;
      },
    };
    const retainedChunks = yield* Stream.fromIterable(remaining).pipe(
      Stream.mapEffect((arrival) => executeOpenArrival(ports, manifest, plan, run, arrival), {
        concurrency: 256,
      }),
      Stream.grouped(256),
      Stream.mapEffect(
        (records, relativeIndex) =>
          Effect.gen(function* () {
            const index = chunkIndex + relativeIndex;
            const artifactId = `${runArtifactPrefix(plan, run)}/arrivals-${index}.json`;
            const content = {
              chunkIndex: index,
              executionId: plan.executionId,
              planChecksum: plan.planChecksum,
              records,
              runId: run.runId,
            };
            const retained = { ...content, artifactChecksum: qualificationChecksum(content) };
            yield* ports.artifacts.writeImmutable(
              artifactId,
              yield* encodeArtifact(EncodedArrivalChunk, retained),
            );
            return {
              artifactChecksum: retained.artifactChecksum,
              artifactId,
              count: records.length,
              index,
            } satisfies StoredRunManifest["chunks"][number];
          }),
        { concurrency: 4 },
      ),
      Stream.runCollect,
    );
    chunks.push(...retainedChunks);
    const faultReceipt =
      barrierFaultReceipt ?? (faultFiber === null ? null : yield* Fiber.join(faultFiber));
    if (
      run.fault !== null &&
      faultAttempt !== null &&
      faultReceipt !== null &&
      !validateFaultReceipt(manifest, plan, run, run.fault, faultAttempt, faultReceipt)
    ) {
      return yield* invalidExecution(`${run.runId} fault controller did not apply frozen trigger`);
    }
    const artifactId = `${runArtifactPrefix(plan, run)}/manifest.json`;
    const content = {
      arrivalCount: run.arrivalCount,
      chunks,
      executionId: plan.executionId,
      faultReceipt,
      planChecksum: plan.planChecksum,
      runDescriptorChecksum: qualificationChecksum(run),
      runId: run.runId,
    };
    const retained = { ...content, artifactChecksum: qualificationChecksum(content) };
    yield* ports.artifacts.writeImmutable(
      artifactId,
      yield* encodeArtifact(EncodedRunManifest, retained),
    );
    return qualificationExecutionReceiptForRun(plan, run, retained.artifactChecksum, artifactId);
  });

const verifyDurableRun = <E>(
  artifacts: QualificationExecutionArtifactStore<E>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
  receipt: QualificationRunExecutionReceipt,
) =>
  Effect.gen(function* () {
    const encodedManifest = yield* artifacts.read(receipt.artifactId);
    if (encodedManifest === null)
      return yield* invalidExecution(`${run.runId} retained manifest is missing`);
    const retained = yield* decodeArtifact(EncodedRunManifest, encodedManifest);
    const { artifactChecksum, ...manifestContent } = retained;
    const retainedFaultContent =
      retained.faultReceipt === null
        ? null
        : (({ artifactChecksum: _artifactChecksum, ...content }) => content)(retained.faultReceipt);
    if (
      artifactChecksum !== qualificationChecksum(manifestContent) ||
      artifactChecksum !== receipt.arrivalArtifactChecksum ||
      retained.executionId !== plan.executionId ||
      retained.planChecksum !== plan.planChecksum ||
      retained.runId !== run.runId ||
      retained.runDescriptorChecksum !== qualificationChecksum(run) ||
      retained.arrivalCount !== run.arrivalCount ||
      retained.chunks.reduce((count, chunk) => count + chunk.count, 0) !== run.arrivalCount ||
      (run.fault === null) !== (retained.faultReceipt === null) ||
      (retained.faultReceipt !== null &&
        (retainedFaultContent === null ||
          retained.faultReceipt.artifactChecksum !== qualificationChecksum(retainedFaultContent) ||
          retained.faultReceipt.applicationStatus !== "applied" ||
          retained.faultReceipt.executionId !== plan.executionId ||
          retained.faultReceipt.runId !== run.runId ||
          retained.faultReceipt.kind !== run.fault?.kind))
    ) {
      return yield* invalidExecution(`${run.runId} retained manifest conflicts with the plan`);
    }
    const expected = qualificationRunArrivals(manifest, run);
    for (const descriptor of retained.chunks) {
      const encodedChunk = yield* artifacts.read(descriptor.artifactId);
      if (encodedChunk === null)
        return yield* invalidExecution(`${run.runId} retained arrival chunk is missing`);
      const chunk = yield* decodeArtifact(EncodedArrivalChunk, encodedChunk);
      const { artifactChecksum: chunkChecksum, ...chunkContent } = chunk;
      if (
        chunkChecksum !== qualificationChecksum(chunkContent) ||
        chunkChecksum !== descriptor.artifactChecksum ||
        chunk.chunkIndex !== descriptor.index ||
        chunk.executionId !== plan.executionId ||
        chunk.planChecksum !== plan.planChecksum ||
        chunk.runId !== run.runId ||
        chunk.records.length !== descriptor.count
      ) {
        return yield* invalidExecution(`${run.runId} retained arrival chunk conflicts`);
      }
      for (const record of chunk.records) {
        const canonical = expected.next();
        if (
          canonical.done ||
          qualificationChecksum(record.arrival) !== qualificationChecksum(canonical.value) ||
          record.executionId !== plan.executionId ||
          !validateArrivalAuthority(plan, run, canonical.value, record)
        ) {
          return yield* invalidExecution(`${run.runId} retained arrival authority conflicts`);
        }
      }
    }
    if (!expected.next().done)
      return yield* invalidExecution(`${run.runId} retained arrivals are incomplete`);
    return undefined;
  });

const collectAuthorityEvidence = <E>(
  collectors: QualificationAuthorityCollectors<E>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  receipts: ReadonlyArray<QualificationRunExecutionReceipt>,
  phase: QualificationAuthorityReadPhase,
) =>
  Effect.gen(function* () {
    const cost = yield* collectors.cost(manifest, plan, phase);
    const externalGates = yield* collectors.externalGates(manifest, plan, phase);
    const memorySemantic = yield* collectors.memorySemantic(manifest, plan, phase);
    const recoveryRuns = yield* collectors.recoveryRuns(manifest, plan, phase);
    const resourceUse = yield* collectors.resourceUse(manifest, plan, phase);
    const runs = yield* collectors.runs(manifest, plan, phase);
    const semantic = yield* collectors.semantic(manifest, plan, phase);
    const stages = yield* collectors.stages(manifest, plan, phase);
    return {
      cost,
      execution: qualificationExecutionEvidence(
        manifest,
        plan.executionId,
        plan.planChecksum,
        `${executionArtifactPrefix(plan.executionId)}/authority-bundle.json`,
        receipts,
      ),
      externalGates,
      manifest,
      memorySemantic,
      recoveryRuns,
      resourceUse,
      runs,
      semantic,
      stages,
    } satisfies ProductionQualificationEvidence;
  });

const authorityComponentChecksums = (evidence: ProductionQualificationEvidence) => ({
  cost: qualificationChecksum(evidence.cost),
  externalGates: qualificationChecksum(evidence.externalGates),
  memorySemantic: qualificationChecksum(evidence.memorySemantic),
  recoveryRuns: qualificationChecksum(evidence.recoveryRuns),
  resourceUse: qualificationChecksum(evidence.resourceUse),
  runs: qualificationChecksum(evidence.runs),
  semantic: qualificationChecksum(evidence.semantic),
  stages: qualificationChecksum(evidence.stages),
});

const readExecutedRunArtifact = <E>(
  artifacts: QualificationExecutionArtifactStore<E>,
  receipt: QualificationRunExecutionReceipt,
) =>
  Effect.gen(function* () {
    const encodedManifest = yield* artifacts.read(receipt.artifactId);
    if (encodedManifest === null)
      return yield* invalidExecution(`${receipt.runId} execution manifest is unavailable`);
    const manifest = yield* decodeArtifact(EncodedRunManifest, encodedManifest);
    const records = yield* Effect.forEach(manifest.chunks, (descriptor) =>
      artifacts.read(descriptor.artifactId).pipe(
        Effect.flatMap((encoded) =>
          encoded === null
            ? invalidExecution(`${receipt.runId} execution chunk is unavailable`)
            : decodeArtifact(EncodedArrivalChunk, encoded),
        ),
        Effect.map((chunk) => chunk.records),
      ),
    );
    return { faultReceipt: manifest.faultReceipt, records: records.flat() };
  });

const verifyEvidenceExecutionCorrelation = <E>(
  artifacts: QualificationExecutionArtifactStore<E>,
  plan: QualificationExecutionPlan,
  receipts: ReadonlyArray<QualificationRunExecutionReceipt>,
  evidence: ProductionQualificationEvidence,
) =>
  Effect.gen(function* () {
    const workerFacts = new Map(
      evidence.semantic.productAuthorityExports
        .filter(({ authority }) => authority === "worker_admission_receipts")
        .flatMap(({ records }) =>
          records.flatMap((record) =>
            "admissionDecision" in record
              ? [
                  [
                    record.productFactId,
                    { decision: record.admissionDecision, rootId: record.rootId },
                  ] as const,
                ]
              : [],
          ),
        ),
    );
    const allAuthorityFactIds = new Set<string>();
    for (const [index, run] of plan.runs.entries()) {
      const receipt = receipts[index];
      if (receipt === undefined)
        return yield* invalidExecution(`${run.runId} has no retained execution receipt`);
      const executed = yield* readExecutedRunArtifact(artifacts, receipt);
      const correlated =
        run.kind === "lane"
          ? evidence.runs.laneRuns.find(
              (candidate) =>
                candidate.lane === run.lane &&
                candidate.region === run.region &&
                candidate.repetition === run.repetition,
            )
          : run.kind === "challenge"
            ? evidence.runs.challengeRuns.find(
                (candidate) =>
                  candidate.challenge === run.challenge && candidate.region === run.region,
              )
            : evidence.runs.characterizationRuns.find(
                (candidate) =>
                  candidate.kind === run.characterization && candidate.region === run.region,
              );
      const actualArrivals =
        correlated === undefined
          ? undefined
          : "actualArrivals" in correlated
            ? correlated.actualArrivals.records
            : correlated.arrivals.records;
      if (
        correlated === undefined ||
        actualArrivals === undefined ||
        qualificationChecksum(actualArrivals.map(({ rootId }) => rootId)) !==
          qualificationChecksum(executed.records.map(({ rootId }) => rootId))
      ) {
        return yield* invalidExecution(`${run.runId} evidence names a different executed workload`);
      }
      if ("dispositions" in correlated) {
        const dispositionByRoot = new Map(
          correlated.dispositions.map((record) => [record.rootId, record] as const),
        );
        for (const record of executed.records) {
          const disposition = dispositionByRoot.get(record.rootId);
          if (
            disposition === undefined ||
            disposition.authorityFactId !== record.authorityFactId ||
            allAuthorityFactIds.has(record.authorityFactId) ||
            workerFacts.get(record.authorityFactId)?.rootId !== record.rootId ||
            workerFacts.get(record.authorityFactId)?.decision !== disposition.disposition
          ) {
            return yield* invalidExecution(
              `${run.runId} arrival authority does not join to committed product facts`,
            );
          }
          allAuthorityFactIds.add(record.authorityFactId);
        }
        const evidenceFault = correlated.faultControllerReceipt;
        const triggerDisposition =
          executed.faultReceipt?.triggerAuthorityFactId === null || executed.faultReceipt === null
            ? undefined
            : correlated.dispositions.find(
                ({ authorityFactId }) =>
                  authorityFactId === executed.faultReceipt?.triggerAuthorityFactId,
              );
        const firstSubmittedAt = executed.records.reduce(
          (earliest, record) => Math.min(earliest, Date.parse(record.submittedAtUtc)),
          Number.POSITIVE_INFINITY,
        );
        const faultAuthorityConflict =
          executed.faultReceipt !== null &&
          (allAuthorityFactIds.has(executed.faultReceipt.applicationAuthorityFactId) ||
            allAuthorityFactIds.has(executed.faultReceipt.restorationAuthorityFactId) ||
            (!authorityTriggeredFaults.has(executed.faultReceipt.trigger) &&
              Date.parse(executed.faultReceipt.injectedAtUtc) > firstSubmittedAt));
        if (
          (evidenceFault === null) !== (executed.faultReceipt === null) ||
          (evidenceFault !== null &&
            executed.faultReceipt !== null &&
            qualificationChecksum(evidenceFault) !==
              qualificationChecksum(executed.faultReceipt)) ||
          (executed.faultReceipt?.triggerAuthorityFactId !== null &&
            executed.faultReceipt !== null &&
            (triggerDisposition === undefined ||
              Date.parse(triggerDisposition.resolvedAtUtc) >
                Date.parse(executed.faultReceipt.triggerObservedAtUtc))) ||
          faultAuthorityConflict
        ) {
          return yield* invalidExecution(
            `${run.runId} fault evidence does not join to the applied controller receipt`,
          );
        }
        if (executed.faultReceipt !== null) {
          allAuthorityFactIds.add(executed.faultReceipt.applicationAuthorityFactId);
          allAuthorityFactIds.add(executed.faultReceipt.restorationAuthorityFactId);
        }
      }
    }
    return undefined;
  });

const retainAndReloadAuthorityBundle = <E>(
  ports: DurableQualificationExecutionPorts<E>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  receipts: ReadonlyArray<QualificationRunExecutionReceipt>,
) =>
  Effect.gen(function* () {
    const collected = yield* collectAuthorityEvidence(
      ports.authorities,
      manifest,
      plan,
      receipts,
      "collect",
    );
    yield* verifyEvidenceExecutionCorrelation(ports.artifacts, plan, receipts, collected);
    const evidenceArtifactId = `${executionArtifactPrefix(plan.executionId)}/authority-evidence.json`;
    const encodedEvidence = canonicalQualificationJson(collected);
    const evidenceArtifactChecksum = qualificationChecksum({ encodedEvidence });
    yield* ports.artifacts.writeImmutable(evidenceArtifactId, encodedEvidence);
    const content = {
      componentChecksums: authorityComponentChecksums(collected),
      evidenceArtifactChecksum,
      evidenceArtifactId,
      evidenceChecksum: qualificationChecksum(collected),
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      runReceiptsChecksum: qualificationChecksum(receipts),
      sourceVersion: manifest.sourceVersion,
      topologyVersion: manifest.topologyVersion,
    };
    const retained = { ...content, artifactChecksum: qualificationChecksum(content) };
    const artifactId = `${executionArtifactPrefix(plan.executionId)}/authority-bundle.json`;
    yield* ports.artifacts.writeImmutable(
      artifactId,
      yield* encodeArtifact(EncodedAuthorityBundle, retained),
    );
    const encoded = yield* ports.artifacts.read(artifactId);
    if (encoded === null) return yield* invalidExecution("Authority bundle is missing after write");
    const reloadedBundle = yield* decodeArtifact(EncodedAuthorityBundle, encoded);
    const { artifactChecksum, ...reloadedContent } = reloadedBundle;
    if (
      artifactChecksum !== qualificationChecksum(reloadedContent) ||
      artifactChecksum !== retained.artifactChecksum
    ) {
      return yield* invalidExecution("Authority bundle conflicts after reload");
    }
    const reloadedEvidenceArtifact = yield* ports.artifacts.read(reloadedBundle.evidenceArtifactId);
    if (
      reloadedEvidenceArtifact === null ||
      qualificationChecksum({ encodedEvidence: reloadedEvidenceArtifact }) !==
        reloadedBundle.evidenceArtifactChecksum ||
      reloadedEvidenceArtifact !== encodedEvidence
    ) {
      return yield* invalidExecution("Retained authority evidence conflicts after reload");
    }
    const reloaded = yield* collectAuthorityEvidence(
      ports.authorities,
      manifest,
      plan,
      receipts,
      "reload",
    );
    yield* verifyEvidenceExecutionCorrelation(ports.artifacts, plan, receipts, reloaded);
    if (
      qualificationChecksum(reloaded) !== retained.evidenceChecksum ||
      qualificationChecksum(authorityComponentChecksums(reloaded)) !==
        qualificationChecksum(retained.componentChecksums)
    ) {
      return yield* invalidExecution("Reloaded authority evidence conflicts with retained bundle");
    }
    return reloaded;
  });

/** Execute, retain, reload, and verify the production qualification authority bundle. */
export const executeDurableQualification = <E>({
  manifest,
  plan,
  ports,
}: {
  readonly manifest: ProductionQualificationManifest;
  readonly plan: QualificationExecutionPlan;
  readonly ports: DurableQualificationExecutionPorts<E>;
}) => {
  const driver: QualificationExecutionDriver<E | QualificationExecutionInvalid> = {
    collectEvidence: (_manifest, _plan, receipts) =>
      retainAndReloadAuthorityBundle(ports, manifest, plan, receipts),
    executeRun: (_manifest, run) => retainDurableQualificationRun(ports, manifest, plan, run),
    prepare: () =>
      retainAndVerifyPlan(ports.artifacts, plan).pipe(
        Effect.andThen(ports.prepare(manifest, plan)),
      ),
    teardown: () => ports.teardown(manifest, plan),
    verifyRun: (_manifest, _plan, run, receipt) =>
      verifyDurableRun(ports.artifacts, manifest, plan, run, receipt),
  };
  return executeQualification({ driver, manifest, plan }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        unavailableProductionQualificationReport(
          manifest,
          error instanceof QualificationExecutionInvalid
            ? "qualificationExecutionConflict"
            : "qualificationMaterialUnavailable",
          error instanceof QualificationExecutionInvalid
            ? error.message
            : "A required execution artifact or authority component was unavailable",
          error instanceof QualificationExecutionInvalid ? "FAIL" : "MISSING",
        ),
      ),
    ),
  );
};

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
      receipt.executionId === plan.executionId &&
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
    plan.executionId.length === 0 ||
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
    yield* Effect.forEach(plan.runs, (run, index) => {
      const receipt = runReceipts[index];
      return receipt === undefined
        ? new QualificationExecutionInvalid({ message: `${run.runId} has no execution receipt` })
        : driver.verifyRun(manifest, plan, run, receipt);
    });
    const evidence = yield* driver.collectEvidence(manifest, plan, runReceipts);
    if (
      evidence.manifest.manifestChecksum !== manifest.manifestChecksum ||
      evidence.manifest.sourceVersion !== manifest.sourceVersion ||
      evidence.manifest.topologyVersion !== manifest.topologyVersion ||
      evidence.execution.planChecksum !== plan.planChecksum ||
      evidence.execution.executionId !== plan.executionId ||
      qualificationChecksum(evidence.execution.runReceipts) !== qualificationChecksum(runReceipts)
    ) {
      return yield* new QualificationExecutionInvalid({
        message: "Collected evidence is not bound to the executed manifest and plan",
      });
    }
    return qualifyProduction(evidence);
  }).pipe(Effect.onExit(() => driver.teardown(manifest, plan)));
});

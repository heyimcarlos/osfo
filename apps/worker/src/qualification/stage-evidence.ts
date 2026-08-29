import { Option, Schema } from "effect";

import {
  ArtifactChecksum,
  EvidenceCount,
  NonNegativeMeasurement,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import type {
  ProductionQualificationManifest,
  ReferenceJourney,
  WorkloadLane,
} from "./qualification-manifest";
import { qualificationChecksum } from "./qualification-checksum";
import type { ProductStageBoundary } from "./semantic-evidence";
import {
  assessmentFromFindings,
  type QualificationFinding,
  type QualificationVerdict,
} from "./verdict";

/** One measured production stage in the exact Reference Workload Trace. */
export type QualificationStage =
  | "coldDurableAcceptance"
  | "combinedLiveAdmission"
  | "firstDeliveryAttempt"
  | "firstMeaningfulUserUpdate"
  | "scheduledEmailOutcome"
  | "scheduledEmailProtectedSendStart"
  | "scheduledTaskHandlerStart"
  | "scheduledTaskSubmissionAcceptance"
  | "warmDurableAcceptance"
  | "workflowOutcomeFollowUpAcceptance"
  | "workflowStartAcceptance"
  | "workflowWakeMilestoneCommit";

/** Explicit cause for one cold activation split. */
export type ColdCause = "deployment" | "faultRecovery" | "firstUse" | "idleEviction";

/** Supported regional split for qualification measurements. */
export type QualificationRegion = "americas" | "asiaPacific" | "europe";

/** Frozen latency limit and ratio for one production stage. */
export interface StageObjective {
  readonly maximumLatencyMs: number;
  readonly requiredRatio: number;
  readonly stage: QualificationStage;
}

/** Frozen v1 stage objectives evaluated independently for each required split. */
export const stageObjectives: ReadonlyArray<StageObjective> = Object.freeze([
  { maximumLatencyMs: 1_000, requiredRatio: 0.999, stage: "warmDurableAcceptance" },
  { maximumLatencyMs: 3_000, requiredRatio: 0.99, stage: "coldDurableAcceptance" },
  { maximumLatencyMs: 3_000, requiredRatio: 0.999, stage: "combinedLiveAdmission" },
  { maximumLatencyMs: 10_000, requiredRatio: 0.99, stage: "firstMeaningfulUserUpdate" },
  { maximumLatencyMs: 2_000, requiredRatio: 0.99, stage: "firstDeliveryAttempt" },
  { maximumLatencyMs: 60_000, requiredRatio: 0.99, stage: "scheduledTaskHandlerStart" },
  { maximumLatencyMs: 90_000, requiredRatio: 0.99, stage: "scheduledTaskSubmissionAcceptance" },
  { maximumLatencyMs: 3_000, requiredRatio: 0.999, stage: "workflowStartAcceptance" },
  { maximumLatencyMs: 60_000, requiredRatio: 0.99, stage: "workflowWakeMilestoneCommit" },
  { maximumLatencyMs: 60_000, requiredRatio: 0.99, stage: "workflowOutcomeFollowUpAcceptance" },
  { maximumLatencyMs: 60_000, requiredRatio: 0.99, stage: "scheduledEmailProtectedSendStart" },
  { maximumLatencyMs: 120_000, requiredRatio: 1, stage: "scheduledEmailOutcome" },
]);

/** One root-correlated raw latency sample. */
export interface StageLatencySample {
  readonly endedAtUtc: string;
  readonly endProductFactId: string;
  readonly latencyMs: number;
  readonly rootId: string;
  readonly startedAtUtc: string;
  readonly startProductFactId: string;
}

/** Raw stage evidence for one exact qualifying lane repetition and split. */
export interface StageMeasurement {
  readonly artifactChecksum: string;
  readonly coldCause?: ColdCause;
  readonly eligibleRootIds: ReadonlyArray<string>;
  readonly lane: "allCold" | "dependencyOutageRecovery" | "stress" | "target";
  readonly region: QualificationRegion;
  readonly repetition: number;
  readonly runArtifactChecksum: string;
  readonly samples: ReadonlyArray<StageLatencySample>;
  readonly stage: QualificationStage;
}

/** Parser for one complete raw stage denominator and its latency samples. */
export const StageMeasurementBoundary = Schema.Struct({
  coldCause: Schema.optionalKey(
    Schema.Literals(["deployment", "faultRecovery", "firstUse", "idleEviction"]),
  ),
  eligibleRootIds: Schema.Array(QualificationId),
  lane: Schema.Literals(["allCold", "dependencyOutageRecovery", "stress", "target"]),
  region: Schema.Literals(["americas", "asiaPacific", "europe"]),
  repetition: EvidenceCount,
  runArtifactChecksum: ArtifactChecksum,
  samples: Schema.Array(
    Schema.Struct({
      endedAtUtc: QualificationUtcInstant,
      endProductFactId: QualificationId,
      latencyMs: NonNegativeMeasurement,
      rootId: QualificationId,
      startedAtUtc: QualificationUtcInstant,
      startProductFactId: QualificationId,
    }),
  ),
  artifactChecksum: ArtifactChecksum,
  stage: Schema.Literals([
    "coldDurableAcceptance",
    "combinedLiveAdmission",
    "firstDeliveryAttempt",
    "firstMeaningfulUserUpdate",
    "scheduledEmailOutcome",
    "scheduledEmailProtectedSendStart",
    "scheduledTaskHandlerStart",
    "scheduledTaskSubmissionAcceptance",
    "warmDurableAcceptance",
    "workflowOutcomeFollowUpAcceptance",
    "workflowStartAcceptance",
    "workflowWakeMilestoneCommit",
  ]),
});

interface StageAuthorityPair {
  readonly end: ProductStageBoundary;
  readonly start: ProductStageBoundary;
}

const stageAuthorityByStage = {
  coldDurableAcceptance: { end: "durableAcceptanceCommitted", start: "messageObserved" },
  combinedLiveAdmission: { end: "durableAcceptanceCommitted", start: "messageObserved" },
  firstDeliveryAttempt: { end: "deliveryAttemptStarted", start: "meaningfulUpdateCommitted" },
  firstMeaningfulUserUpdate: {
    end: "meaningfulUpdateCommitted",
    start: "durableAcceptanceCommitted",
  },
  scheduledEmailOutcome: {
    end: "scheduledEmailOutcomeCommitted",
    start: "protectedSendStarted",
  },
  scheduledEmailProtectedSendStart: { end: "protectedSendStarted", start: "scheduledEmailDue" },
  scheduledTaskHandlerStart: { end: "scheduledTaskHandlerStarted", start: "scheduledTaskDue" },
  scheduledTaskSubmissionAcceptance: {
    end: "scheduledTaskSubmissionAccepted",
    start: "scheduledTaskHandlerStarted",
  },
  warmDurableAcceptance: { end: "durableAcceptanceCommitted", start: "messageObserved" },
  workflowOutcomeFollowUpAcceptance: { end: "followUpAccepted", start: "workflowOutcomeCommitted" },
  workflowStartAcceptance: { end: "workflowStarted", start: "scheduledTaskSubmissionAccepted" },
  workflowWakeMilestoneCommit: { end: "workflowMilestoneCommitted", start: "workflowWakeDue" },
} as const satisfies Readonly<Record<QualificationStage, StageAuthorityPair>>;

/** Owning committed product facts that define one stage interval. */
export const stageAuthorityComponents = (stage: QualificationStage) => stageAuthorityByStage[stage];

/** Journeys that can produce a stage, or null when every journey can produce it. */
export const stageApplicableJourneys = (
  stage: QualificationStage,
): ReadonlyArray<ReferenceJourney> | null =>
  stage === "scheduledEmailOutcome" || stage === "scheduledEmailProtectedSendStart"
    ? ["scheduledEmail"]
    : stage === "scheduledTaskHandlerStart" ||
        stage === "scheduledTaskSubmissionAcceptance" ||
        stage === "workflowOutcomeFollowUpAcceptance" ||
        stage === "workflowStartAcceptance" ||
        stage === "workflowWakeMilestoneCommit"
      ? ["reminder", "scheduledEmail"]
      : null;

/** Reproduced percentiles and objective ratio for one complete split. */
export interface StageSummary {
  readonly coldCause?: ColdCause;
  readonly lane: StageMeasurement["lane"];
  readonly maximumLatencyMs: number;
  readonly maximumObservedLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly region: QualificationRegion;
  readonly repetition: number;
  readonly sampleCount: number;
  readonly stage: QualificationStage;
  readonly withinObjectiveRatio: number;
}

/** Stage verdict with summaries retained for audit. */
export interface StageAssessment {
  readonly findings: ReadonlyArray<QualificationFinding>;
  readonly summaries: ReadonlyArray<StageSummary>;
  readonly verdict: QualificationVerdict;
}

const coldCauses: ReadonlyArray<ColdCause> = [
  "firstUse",
  "idleEviction",
  "deployment",
  "faultRecovery",
];
const measuredLanes: ReadonlyArray<StageMeasurement["lane"]> = [
  "target",
  "stress",
  "allCold",
  "dependencyOutageRecovery",
];
const objectivesForLane = (lane: StageMeasurement["lane"]): ReadonlyArray<StageObjective> =>
  lane === "allCold"
    ? stageObjectives.filter(({ stage }) => stage === "coldDurableAcceptance")
    : stageObjectives;
const causesForObjective = (objective: StageObjective): ReadonlyArray<ColdCause | undefined> =>
  objective.stage === "coldDurableAcceptance" ? coldCauses : [undefined];

/** Exact number of independently reduced stage splits required for one lane run. */
export const qualificationStageDimensionCount = (lane: StageMeasurement["lane"]): number =>
  objectivesForLane(lane).reduce(
    (total, objective) => total + causesForObjective(objective).length,
    0,
  );

const percentile = (sorted: ReadonlyArray<number>, ratio: number): number =>
  sorted.at(Math.max(0, Math.ceil(sorted.length * ratio) - 1)) ?? 0;

const repetitionsFor = (
  manifest: ProductionQualificationManifest,
  lane: StageMeasurement["lane"],
): number => manifest.lanes.find((candidate) => candidate.kind === lane)?.repetitions ?? 0;

/** Assess every required regional, run, stage, and cold-cause split. */
export const assessStageEvidence = (
  manifest: ProductionQualificationManifest,
  measurements: ReadonlyArray<StageMeasurement>,
): StageAssessment => {
  const findings: Array<QualificationFinding> = [];
  const parsedMeasurements = measurements.flatMap((measurement) =>
    Option.toArray(Schema.decodeOption(StageMeasurementBoundary)(measurement)),
  );
  if (parsedMeasurements.length !== measurements.length) {
    findings.push({
      code: "stageEvidenceBoundaryInvalid",
      detail: "Stage evidence failed its refined boundary parser",
      subject: "stageEvidence",
      verdict: "FAIL",
    });
  }
  const summaries: Array<StageSummary> = [];
  for (const lane of measuredLanes) {
    for (const region of manifest.regions) {
      for (let repetition = 1; repetition <= repetitionsFor(manifest, lane); repetition += 1) {
        for (const objective of objectivesForLane(lane)) {
          for (const coldCause of causesForObjective(objective)) {
            const matches = parsedMeasurements.filter(
              (candidate) =>
                candidate.lane === lane &&
                candidate.region === region &&
                candidate.repetition === repetition &&
                candidate.stage === objective.stage &&
                candidate.coldCause === coldCause,
            );
            const subject = [lane, region, repetition, objective.stage, coldCause]
              .filter((part) => part !== undefined)
              .join(":");
            if (matches.length > 1)
              findings.push({
                code: "duplicateStageSplit",
                detail: `${subject} has ${matches.length} measurement records`,
                subject,
                verdict: "FAIL",
              });
            const measurement = matches[0];
            if (
              measurement === undefined ||
              measurement.eligibleRootIds.length === 0 ||
              measurement.runArtifactChecksum.length === 0 ||
              measurement.artifactChecksum.length === 0
            ) {
              findings.push({
                code: "stageSplitMissing",
                detail: `${subject} has no retained raw latency samples`,
                subject,
                verdict: "MISSING",
              });
              continue;
            }
            if (
              new Set(measurement.eligibleRootIds).size !== measurement.eligibleRootIds.length ||
              measurement.eligibleRootIds.some((rootId) => rootId.length === 0)
            ) {
              findings.push({
                code: "invalidStageDenominator",
                detail: `${subject} has duplicate or empty eligible root identities`,
                subject,
                verdict: "FAIL",
              });
              continue;
            }
            if (
              measurement.samples.some(
                (sample) =>
                  sample.rootId.length === 0 ||
                  sample.startProductFactId.length === 0 ||
                  sample.endProductFactId.length === 0 ||
                  !Number.isFinite(sample.latencyMs) ||
                  sample.latencyMs < 0 ||
                  Date.parse(sample.endedAtUtc) < Date.parse(sample.startedAtUtc) ||
                  sample.latencyMs !==
                    Date.parse(sample.endedAtUtc) - Date.parse(sample.startedAtUtc),
              )
            ) {
              findings.push({
                code: "invalidStageSample",
                detail: `${subject} has an invalid root identity or latency`,
                subject,
                verdict: "FAIL",
              });
              continue;
            }
            if (measurement.artifactChecksum !== qualificationChecksum(measurement.samples)) {
              findings.push({
                code: "stageArtifactChecksumMismatch",
                detail: `${subject} raw intervals do not match the retained artifact checksum`,
                subject,
                verdict: "FAIL",
              });
              continue;
            }
            const sampleRoots = measurement.samples.map((sample) => sample.rootId);
            if (new Set(sampleRoots).size !== sampleRoots.length) {
              findings.push({
                code: "duplicateStageSample",
                detail: `${subject} has more than one latency sample for one eligible root`,
                subject,
                verdict: "FAIL",
              });
            }
            const eligibleRoots = new Set(measurement.eligibleRootIds);
            if (sampleRoots.some((rootId) => !eligibleRoots.has(rootId))) {
              findings.push({
                code: "ineligibleStageSample",
                detail: `${subject} contains a sample outside its eligible identity set`,
                subject,
                verdict: "FAIL",
              });
            }
            if (measurement.eligibleRootIds.some((rootId) => !sampleRoots.includes(rootId))) {
              findings.push({
                code: "stageSampleMissing",
                detail: `${subject} omits at least one eligible root latency sample`,
                subject,
                verdict: "MISSING",
              });
            }
            const sorted = measurement.samples.map((sample) => sample.latencyMs);
            // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh array.
            sorted.sort((a, b) => a - b);
            const passing = sorted.filter(
              (latency) => latency <= objective.maximumLatencyMs,
            ).length;
            const withinObjectiveRatio = passing / sorted.length;
            const summary = {
              lane,
              maximumLatencyMs: objective.maximumLatencyMs,
              maximumObservedLatencyMs: sorted.at(-1) ?? 0,
              p50LatencyMs: percentile(sorted, 0.5),
              p95LatencyMs: percentile(sorted, 0.95),
              p99LatencyMs: percentile(sorted, 0.99),
              region,
              repetition,
              sampleCount: sorted.length,
              stage: objective.stage,
              withinObjectiveRatio,
            };
            summaries.push(coldCause === undefined ? summary : { ...summary, coldCause });
            if (withinObjectiveRatio < objective.requiredRatio) {
              findings.push({
                code: "stageObjectiveMissed",
                detail: `${subject} achieved ${withinObjectiveRatio}, required ${objective.requiredRatio}`,
                subject,
                verdict: "FAIL",
              });
            }
          }
        }
      }
    }
  }
  return { ...assessmentFromFindings(findings), summaries };
};

/** Identify workload lanes that must provide complete stage evidence. */
export const isMeasuredStageLane = (lane: WorkloadLane["kind"]): lane is StageMeasurement["lane"] =>
  lane === "target" ||
  lane === "stress" ||
  lane === "allCold" ||
  lane === "dependencyOutageRecovery";

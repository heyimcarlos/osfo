import type {
  EvidenceStore,
  SemanticComponent,
  SemanticCorrelation,
  SemanticStage,
} from "./semantic-evidence";
import { qualificationChecksum } from "./qualification-checksum";

/** One exact platform, provider, storage, concurrency, or cost hard limit. */
export interface HardLimit {
  readonly maximum: number;
  readonly name: string;
  readonly unit: string;
}

/** Immutable inputs that bind one qualification manifest to exact deployable code. */
export interface QualificationManifestVersions {
  readonly dependencyVersions: Readonly<Record<string, string>>;
  readonly hardLimits: ReadonlyArray<HardLimit>;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
  readonly workloadSeed: number;
}

/** One explicit qualification workload window. */
export interface WorkloadWindow {
  readonly durationSeconds: number;
  readonly endRatePerSecond: number;
  readonly kind: "audit" | "drain" | "fault" | "idle" | "offer" | "teardown";
  readonly startRatePerSecond: number;
}

/** One reproducible production workload lane. */
export interface WorkloadLane {
  readonly kind:
    | "allCold"
    | "baseline"
    | "dependencyOutageRecovery"
    | "linearRamp"
    | "stress"
    | "target"
    | "zeroToBurst";
  readonly repetitions: number;
  readonly windows: ReadonlyArray<WorkloadWindow>;
}

/** High-rate historical lane retained for characterization, never as a production SLO. */
export interface CharacterizationLane {
  readonly durationSeconds: 60;
  readonly kind: "historical232" | "historical464";
  readonly offeredRatePerSecond: 232 | 464;
}

/** One isolated fault dimension used by a Challenge Lane. */
export interface FaultInjection {
  readonly durationSeconds: number;
  readonly expectedInvariant: string;
  readonly kind:
    | "allowanceRace"
    | "ambiguousSend"
    | "coldActivation"
    | "conflictingStatus"
    | "costExhaustion"
    | "dependencyOutage"
    | "deploymentReplacement"
    | "duplicateWebhook"
    | "hotAgentFairness"
    | "maximumFile"
    | "maximumHistory"
    | "regionalLatency"
    | "synchronizedWake"
    | "workflowRetryAfterEffect";
  readonly target: string;
  readonly trigger: string;
}

/** One mandatory challenge that must pass before the combined cascade. */
export interface ChallengeLane {
  readonly kind: FaultInjection["kind"] | "allAdventurer" | "combinedTargetCascade" | "rareJourney";
  readonly minimumEligibleRoots: number | "targetWindow";
  readonly mode: "combined" | "isolated";
  readonly offerDurationSeconds: 1 | 10 | "targetDuration";
  readonly offeredRatePerSecond: 1 | 10 | "targetRate";
  readonly planPolicy: "allAdventurer" | "referenceMix" | "unconstrained";
  readonly requiredJourneys: ReadonlyArray<ReferenceJourney>;
  readonly seedOffset: number;
}

/** Independent production authority required by system qualification. */
export type ExternalGate =
  | "browserJourneys"
  | "migrationChains"
  | "modelQuality"
  | "protectedStackDeployment"
  | "providerConformance";

/** One journey in the initial versioned Reference Workload Trace. */
export type ReferenceJourney =
  | "accountBillingSafetyDataRights"
  | "documentBuild"
  | "fileAnalysis"
  | "gmail"
  | "ordinaryConversation"
  | "registration"
  | "reminder"
  | "researchReport"
  | "scheduledEmail";

/** Frozen journey mix and its Good Root Outcome rule. */
export interface JourneyRequirement {
  readonly assertionAuthorities: ReadonlyArray<SemanticComponent>;
  readonly assertions: ReadonlyArray<string>;
  readonly assertionVersion: "good-root-outcome-v1";
  readonly deadlineMs: number;
  readonly journey: ReferenceJourney;
  readonly milestoneDeadlineMs: 900_000 | null;
  readonly milestoneAssertions: readonly [] | readonly ["required progress milestone committed"];
  readonly outcomeFloor: 0.99 | 1;
  readonly percentage: number;
  readonly workloadClass: "deterministic" | "live";
}

/** Semantic requirements owned by the manifest for one journey. */
export interface JourneySemanticRequirement {
  readonly amplificationLimits: Readonly<Record<string, number>>;
  readonly requiredComponents: ReadonlyArray<SemanticComponent>;
  readonly requiredCorrelations: ReadonlyArray<SemanticCorrelation>;
  readonly requiredStages: ReadonlyArray<SemanticStage>;
  readonly requiredStores: ReadonlyArray<EvidenceStore>;
}

/** One mandatory retained-data characterization corpus for public promotion. */
export interface GrowthCorpus {
  readonly allowancePeriods?: 12;
  readonly kind: "depth" | "width";
  readonly registeredUsers: number;
  readonly retainedRegisteredMessages: number;
}

interface QualificationManifestBase {
  readonly challengeLanes: ReadonlyArray<ChallengeLane>;
  readonly characterizationLanes: ReadonlyArray<CharacterizationLane>;
  readonly corpus: {
    readonly registeredUsers: number;
    readonly retainedRegisteredMessages: number;
  };
  readonly dependencyVersions: Readonly<Record<string, string>>;
  readonly faults: ReadonlyArray<FaultInjection>;
  readonly hardLimits: ReadonlyArray<HardLimit>;
  readonly journeyMix: ReadonlyArray<JourneyRequirement>;
  readonly lanes: ReadonlyArray<WorkloadLane>;
  readonly manifestChecksum: string;
  readonly manifestVersion: "production-qualification-v1";
  readonly planMixBasisPoints: {
    readonly adventurer: 1_000;
    readonly free: 9_000;
  };
  readonly providers: readonly ["gmail", "memory", "model", "search", "taskCompute", "whatsapp"];
  readonly requiredExternalGates: ReadonlyArray<ExternalGate>;
  readonly semanticRequirements: Readonly<Record<ReferenceJourney, JourneySemanticRequirement>>;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
  readonly workloadSeed: number;
}

/** Frozen Bounded Beta qualification inputs and workload topology. */
export interface BoundedBetaQualificationManifest extends QualificationManifestBase {
  readonly acceptanceLevel: "BoundedBeta";
  readonly corpus: {
    readonly registeredUsers: 1_000;
    readonly retainedRegisteredMessages: 57_000;
  };
  readonly regions: readonly ["americas"];
}

/** Frozen Scale-Qualified Public Launch inputs and regional workload topology. */
export interface ScaleQualifiedPublicManifest extends QualificationManifestBase {
  readonly acceptanceLevel: "ScaleQualifiedPublic";
  readonly corpus: {
    readonly registeredUsers: 100_000;
    readonly retainedRegisteredMessages: 5_700_000;
  };
  readonly growthCorpora: readonly [GrowthCorpus, GrowthCorpus];
  readonly regions: readonly ["americas", "europe", "asiaPacific"];
}

/** Either production acceptance manifest supported by the v1 harness. */
export type ProductionQualificationManifest =
  | BoundedBetaQualificationManifest
  | ScaleQualifiedPublicManifest;

const window = (
  kind: WorkloadWindow["kind"],
  durationSeconds: number,
  startRatePerSecond: number,
  endRatePerSecond = startRatePerSecond,
): WorkloadWindow => Object.freeze({ durationSeconds, endRatePerSecond, kind, startRatePerSecond });

const lane = (
  kind: WorkloadLane["kind"],
  repetitions: number,
  activeWindows: ReadonlyArray<WorkloadWindow>,
): WorkloadLane =>
  Object.freeze({
    kind,
    repetitions,
    windows: Object.freeze([
      ...activeWindows,
      window("drain", 1_200, 0),
      window("audit", 600, 0),
      window("teardown", 600, 0),
    ]),
  });

const faultDefinitions: ReadonlyArray<FaultInjection> = Object.freeze(
  (
    [
      {
        durationSeconds: 0,
        expectedInvariant: "a new activation identity and exact cold cause are recorded",
        kind: "coldActivation",
        target: "osfoAgent",
        trigger: "beforeOffer",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "accepted work settles once under the replacement activation",
        kind: "deploymentReplacement",
        target: "osfoAgent",
        trigger: "afterAcceptanceBeforeUpdate",
      },
      {
        durationSeconds: 900,
        expectedInvariant: "quiet Agents retain compliant admission and outcomes",
        kind: "hotAgentFairness",
        target: "agentAdmission",
        trigger: "startOfOfferWindow",
      },
      {
        durationSeconds: 60,
        expectedInvariant:
          "each due occurrence starts once and remains within amplification bounds",
        kind: "synchronizedWake",
        target: "scheduledTasksAndWorkflows",
        trigger: "sharedDueTime",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "maximum retained history preserves ordering and deadlines",
        kind: "maximumHistory",
        target: "thinkSession",
        trigger: "beforeOffer",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "maximum accepted file remains bounded and correctly correlated",
        kind: "maximumFile",
        target: "fileAnalysis",
        trigger: "beforeOffer",
      },
      {
        durationSeconds: 900,
        expectedInvariant: "accepted work remains durable and drains after recovery",
        kind: "dependencyOutage",
        target: "externalDependency",
        trigger: "startOfFaultWindow",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "duplicate delivery returns one acceptance identity and one authority",
        kind: "duplicateWebhook",
        target: "whatsappIngress",
        trigger: "afterFirstAcceptance",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "ambiguous application blocks blind retry and remains explicit",
        kind: "ambiguousSend",
        target: "whatsappDelivery",
        trigger: "afterProviderAcceptanceBeforeResponse",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "confirmed delivery progress never moves backward",
        kind: "conflictingStatus",
        target: "providerDeliveryStatus",
        trigger: "afterConfirmedProgress",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "the external effect is not applied twice",
        kind: "workflowRetryAfterEffect",
        target: "workflowStep",
        trigger: "afterExternalEffectBeforeStepCommit",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "soft-cap use stays idempotent and bounded under concurrency",
        kind: "allowanceRace",
        target: "allowanceConsumption",
        trigger: "simultaneousAdmission",
      },
      {
        durationSeconds: 0,
        expectedInvariant: "new ordinary work stops before its per-operation cost bound",
        kind: "costExhaustion",
        target: "modelAccessPolicy",
        trigger: "beforeProviderContact",
      },
      {
        durationSeconds: 900,
        expectedInvariant: "each required region passes independently",
        kind: "regionalLatency",
        target: "clientRegion",
        trigger: "startOfOfferWindow",
      },
    ] satisfies ReadonlyArray<FaultInjection>
  ).map((fault) => Object.freeze(fault)),
);

const challengeLanes: ReadonlyArray<ChallengeLane> = Object.freeze([
  ...faultDefinitions.map((fault, index) =>
    Object.freeze({
      kind: fault.kind,
      minimumEligibleRoots: 1,
      mode: "isolated" as const,
      offerDurationSeconds: 1 as const,
      offeredRatePerSecond: 1 as const,
      planPolicy: "unconstrained" as const,
      requiredJourneys: Object.freeze([]),
      seedOffset: 10_000 + index,
    }),
  ),
  Object.freeze({
    kind: "rareJourney" as const,
    minimumEligibleRoots: 100,
    mode: "isolated" as const,
    offerDurationSeconds: 10 as const,
    offeredRatePerSecond: 10 as const,
    planPolicy: "unconstrained" as const,
    requiredJourneys: Object.freeze([
      "registration",
      "reminder",
      "gmail",
      "researchReport",
      "documentBuild",
      "scheduledEmail",
      "accountBillingSafetyDataRights",
    ] as const),
    seedOffset: 20_001,
  }),
  Object.freeze({
    kind: "allAdventurer" as const,
    minimumEligibleRoots: 100,
    mode: "isolated" as const,
    offerDurationSeconds: 10 as const,
    offeredRatePerSecond: 10 as const,
    planPolicy: "allAdventurer" as const,
    requiredJourneys: Object.freeze([]),
    seedOffset: 20_002,
  }),
  Object.freeze({
    kind: "combinedTargetCascade" as const,
    minimumEligibleRoots: "targetWindow" as const,
    mode: "combined" as const,
    offerDurationSeconds: "targetDuration" as const,
    offeredRatePerSecond: "targetRate" as const,
    planPolicy: "referenceMix" as const,
    requiredJourneys: Object.freeze([]),
    seedOffset: 20_003,
  }),
]);

const characterizationLanes: ReadonlyArray<CharacterizationLane> = Object.freeze([
  Object.freeze({
    durationSeconds: 60 as const,
    kind: "historical232" as const,
    offeredRatePerSecond: 232 as const,
  }),
  Object.freeze({
    durationSeconds: 60 as const,
    kind: "historical464" as const,
    offeredRatePerSecond: 464 as const,
  }),
]);

const requiredExternalGates: ReadonlyArray<ExternalGate> = Object.freeze([
  "modelQuality",
  "providerConformance",
  "protectedStackDeployment",
  "migrationChains",
  "browserJourneys",
]);

const goodRootAssertions = {
  accountBillingSafetyDataRights: ["account, billing, safety, or data-rights command reconciled"],
  documentBuild: ["document artifact and terminal delivery reconciled"],
  fileAnalysis: ["file analysis result and retained object reconciled"],
  gmail: ["Gmail provider outcome and user update reconciled"],
  ordinaryConversation: ["conversation outcome and required user update reconciled"],
  registration: ["registration state and welcome outcome reconciled"],
  reminder: ["scheduled reminder and workflow outcome reconciled"],
  researchReport: ["research artifact, citations, and delivery outcome reconciled"],
  scheduledEmail: ["protected email send and provider outcome reconciled"],
} as const satisfies Readonly<Record<ReferenceJourney, ReadonlyArray<string>>>;

const goodRootAssertionAuthorities = {
  accountBillingSafetyDataRights: ["PostgreSQL", "Worker", "Provider"],
  documentBuild: ["R2", "TaskCompute", "Provider"],
  fileAnalysis: ["R2", "ModelAccess", "Provider"],
  gmail: ["Gmail", "Provider", "WhatsApp"],
  ordinaryConversation: ["Think", "Memory", "Provider", "WhatsApp"],
  registration: ["Worker", "AgentSQLite", "Provider"],
  reminder: ["Workflow", "TaskCompute", "Provider"],
  researchReport: ["R2", "ModelAccess", "TaskCompute", "Provider"],
  scheduledEmail: ["Gmail", "Workflow", "TaskCompute", "Provider"],
} as const satisfies Readonly<Record<ReferenceJourney, ReadonlyArray<SemanticComponent>>>;

const journeyMix: ReadonlyArray<JourneyRequirement> = Object.freeze(
  (
    [
      {
        deadlineMs: 120_000,
        journey: "registration",
        milestoneDeadlineMs: null,
        outcomeFloor: 1,
        percentage: 5,
        workloadClass: "deterministic",
      },
      {
        deadlineMs: 120_000,
        journey: "ordinaryConversation",
        milestoneDeadlineMs: null,
        outcomeFloor: 0.99,
        percentage: 67,
        workloadClass: "live",
      },
      {
        deadlineMs: 300_000,
        journey: "fileAnalysis",
        milestoneDeadlineMs: null,
        outcomeFloor: 0.99,
        percentage: 8,
        workloadClass: "live",
      },
      {
        deadlineMs: 120_000,
        journey: "reminder",
        milestoneDeadlineMs: null,
        outcomeFloor: 1,
        percentage: 5,
        workloadClass: "deterministic",
      },
      {
        deadlineMs: 300_000,
        journey: "gmail",
        milestoneDeadlineMs: null,
        outcomeFloor: 0.99,
        percentage: 4,
        workloadClass: "live",
      },
      {
        deadlineMs: 3_600_000,
        journey: "researchReport",
        milestoneDeadlineMs: 900_000,
        outcomeFloor: 0.99,
        percentage: 3,
        workloadClass: "live",
      },
      {
        deadlineMs: 3_600_000,
        journey: "documentBuild",
        milestoneDeadlineMs: 900_000,
        outcomeFloor: 0.99,
        percentage: 2,
        workloadClass: "live",
      },
      {
        deadlineMs: 120_000,
        journey: "scheduledEmail",
        milestoneDeadlineMs: null,
        outcomeFloor: 0.99,
        percentage: 1,
        workloadClass: "live",
      },
      {
        deadlineMs: 120_000,
        journey: "accountBillingSafetyDataRights",
        milestoneDeadlineMs: null,
        outcomeFloor: 1,
        percentage: 5,
        workloadClass: "deterministic",
      },
    ] as const
  ).map((entry) =>
    Object.freeze({
      ...entry,
      assertionAuthorities: goodRootAssertionAuthorities[entry.journey],
      assertions: goodRootAssertions[entry.journey],
      assertionVersion: "good-root-outcome-v1" as const,
      milestoneAssertions:
        entry.milestoneDeadlineMs === null
          ? ([] as const)
          : (["required progress milestone committed"] as const),
    }),
  ),
);

const stages: ReadonlyArray<SemanticStage> = Object.freeze([
  "durableAcceptance",
  "thinkSubmissionAccepted",
  "terminalOutcome",
  "resourceUseReconciled",
  "costReconciled",
]);
const coreStores: ReadonlyArray<EvidenceStore> = Object.freeze(["PostgreSQL", "AgentSQLite"]);
const coreComponents: ReadonlyArray<SemanticComponent> = Object.freeze([
  "Worker",
  "AgentActivation",
  "PostgreSQL",
  "AgentSQLite",
  "ModelAccess",
  "Think",
  "WhatsApp",
  "Provider",
]);
const amplificationLimits = Object.freeze({
  providerEffects: 1,
  thinkSubmissions: 1,
  workflowStarts: 1,
});

const semanticRequirement = (
  components: ReadonlyArray<SemanticComponent>,
  stores: ReadonlyArray<EvidenceStore> = coreStores,
  correlations: ReadonlyArray<SemanticCorrelation> = [],
): JourneySemanticRequirement =>
  Object.freeze({
    amplificationLimits,
    requiredComponents: Object.freeze([...coreComponents, ...components]),
    requiredCorrelations: Object.freeze([
      "acceptanceReceiptId",
      "allowanceConsumptionId",
      "costReconciliationId",
      "deliveryId",
      "outcomeId",
      "priceBookId",
      "thinkRequestId",
      "thinkSubmissionId",
      "userMessageId",
      "userUpdateId",
      ...correlations,
    ] satisfies ReadonlyArray<SemanticCorrelation>),
    requiredStages: stages,
    requiredStores: stores,
  });

const semanticRequirements: Readonly<Record<ReferenceJourney, JourneySemanticRequirement>> =
  Object.freeze({
    accountBillingSafetyDataRights: semanticRequirement(["ModelAccess"]),
    documentBuild: semanticRequirement(["ModelAccess", "TaskCompute", "R2"], coreStores, [
      "r2ObjectId",
    ]),
    fileAnalysis: semanticRequirement(["ModelAccess", "R2"], coreStores, ["r2ObjectId"]),
    gmail: semanticRequirement(["Gmail", "Provider"]),
    ordinaryConversation: semanticRequirement(["ModelAccess", "Memory"]),
    registration: semanticRequirement([]),
    reminder: semanticRequirement(["TaskCompute", "Workflow"], coreStores, [
      "scheduledTaskId",
      "workflowId",
    ]),
    researchReport: semanticRequirement(["ModelAccess", "TaskCompute", "R2"], coreStores, [
      "r2ObjectId",
    ]),
    scheduledEmail: semanticRequirement(
      ["Gmail", "Provider", "TaskCompute", "Workflow"],
      coreStores,
      ["scheduledTaskId", "workflowId"],
    ),
  });

const lanesFor = (targetRate: number, stressRate: number): ReadonlyArray<WorkloadLane> =>
  Object.freeze([
    lane("baseline", 1, [window("offer", 3_600, targetRate)]),
    lane("target", 3, [window("offer", 1_800, targetRate)]),
    lane("stress", 3, [window("offer", 900, stressRate)]),
    lane("linearRamp", 1, [window("offer", 900, 0, stressRate)]),
    lane("zeroToBurst", 1, [window("idle", 1_800, 0), window("offer", 15, stressRate * 2)]),
    lane("allCold", 1, [window("offer", 1_800, targetRate)]),
    lane("dependencyOutageRecovery", 3, [window("fault", 900, targetRate)]),
  ]);

const commonManifest = (versions: QualificationManifestVersions) => ({
  challengeLanes,
  characterizationLanes,
  dependencyVersions: Object.freeze({ ...versions.dependencyVersions }),
  faults: faultDefinitions,
  hardLimits: Object.freeze(versions.hardLimits.map((limit) => Object.freeze({ ...limit }))),
  journeyMix,
  manifestVersion: "production-qualification-v1" as const,
  planMixBasisPoints: Object.freeze({ adventurer: 1_000 as const, free: 9_000 as const }),
  providers: Object.freeze([
    "gmail",
    "memory",
    "model",
    "search",
    "taskCompute",
    "whatsapp",
  ] as const),
  requiredExternalGates,
  semanticRequirements,
  sourceVersion: versions.sourceVersion,
  topologyVersion: versions.topologyVersion,
  workloadSeed: versions.workloadSeed,
});

/** Create the complete frozen Bounded Beta qualification manifest. */
export const createBoundedBetaManifest = (
  versions: QualificationManifestVersions,
): BoundedBetaQualificationManifest => {
  const manifest: Omit<BoundedBetaQualificationManifest, "manifestChecksum"> = {
    ...commonManifest(versions),
    acceptanceLevel: "BoundedBeta",
    corpus: Object.freeze({
      registeredUsers: 1_000 as const,
      retainedRegisteredMessages: 57_000 as const,
    }),
    lanes: lanesFor(5, 10),
    regions: Object.freeze(["americas"] as const),
  };
  return Object.freeze({ ...manifest, manifestChecksum: qualificationChecksum(manifest) });
};

/** Create the complete frozen Scale-Qualified Public Launch manifest. */
export const createScaleQualifiedPublicManifest = (
  versions: QualificationManifestVersions,
): ScaleQualifiedPublicManifest => {
  const manifest: Omit<ScaleQualifiedPublicManifest, "manifestChecksum"> = {
    ...commonManifest(versions),
    acceptanceLevel: "ScaleQualifiedPublic",
    corpus: Object.freeze({
      registeredUsers: 100_000 as const,
      retainedRegisteredMessages: 5_700_000 as const,
    }),
    growthCorpora: Object.freeze([
      Object.freeze({
        kind: "width",
        registeredUsers: 1_000_000,
        retainedRegisteredMessages: 57_000_000,
      }),
      Object.freeze({
        allowancePeriods: 12 as const,
        kind: "depth",
        registeredUsers: 100_000,
        retainedRegisteredMessages: 68_400_000,
      }),
    ] as const),
    lanes: lanesFor(25, 50),
    regions: Object.freeze(["americas", "europe", "asiaPacific"] as const),
  };
  return Object.freeze({ ...manifest, manifestChecksum: qualificationChecksum(manifest) });
};

/** Derive the exact seed for one lane, region, and repetition. */
export const expectedRunSeed = (
  manifest: ProductionQualificationManifest,
  laneKind: WorkloadLane["kind"],
  region: ProductionQualificationManifest["regions"][number],
  repetition: number,
): number =>
  manifest.workloadSeed +
  manifest.lanes.findIndex((laneValue) => laneValue.kind === laneKind) * 100 +
  manifest.regions.findIndex((regionValue) => regionValue === region) * 10_000 +
  repetition;

/** Calculate the exact number of arrivals intended by one lane. */
export const intendedArrivalCount = (laneValue: WorkloadLane): number =>
  laneValue.windows.reduce(
    (total, windowValue) =>
      windowValue.kind === "offer" || windowValue.kind === "fault"
        ? total +
          Math.floor(
            ((windowValue.startRatePerSecond + windowValue.endRatePerSecond) / 2) *
              windowValue.durationSeconds,
          )
        : total,
    0,
  );

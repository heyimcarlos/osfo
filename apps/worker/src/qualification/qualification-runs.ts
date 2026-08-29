import { Schema } from "effect";

import {
  expectedRunSeed,
  intendedArrivalCount,
  type ChallengeLane,
  type FaultInjection,
  type ProductionQualificationManifest,
  type ReferenceJourney,
  type WorkloadLane,
} from "./qualification-manifest";
import { qualificationChecksum } from "./qualification-checksum";
import {
  ArtifactChecksum,
  NonNegativeMeasurement,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import { parseEvidenceArtifact, type EvidenceArtifact } from "./evidence-artifact";
export type { EvidenceArtifact } from "./evidence-artifact";
import { generateOpenArrivals, type OpenWorkloadArrival } from "./workload-generation";
import { assessPublicPromotionEvidence } from "./public-promotion-evidence";
export { requiredContinuedBetaSplits } from "./public-promotion-evidence";
import {
  assessmentFromFindings,
  type QualificationAssessment,
  type QualificationFinding,
} from "./verdict";

const ReferenceJourneyBoundary = Schema.Literals([
  "accountBillingSafetyDataRights",
  "documentBuild",
  "fileAnalysis",
  "gmail",
  "ordinaryConversation",
  "registration",
  "reminder",
  "researchReport",
  "scheduledEmail",
]);
const OpenArrivalBoundary = Schema.Struct({
  journey: ReferenceJourneyBoundary,
  offeredAtEpochMs: Schema.Finite,
  plan: Schema.Literals(["adventurer", "free"]),
  rootId: QualificationId,
});
const ActualArrivalBoundary = Schema.Struct({
  ...OpenArrivalBoundary.fields,
  observedAtEpochMs: Schema.Finite,
});
const CharacterizationArrivalBoundary = Schema.Struct({
  offeredAtEpochMs: Schema.Finite,
  rootId: QualificationId,
});
const FaultObservationBoundary = Schema.Struct({
  authorityFactIds: Schema.Array(QualificationId),
  arrivalChecksum: ArtifactChecksum,
  identityChecksum: ArtifactChecksum,
  injectedAtUtc: QualificationUtcInstant,
  invariant: QualificationId,
  invariantHeld: Schema.Boolean,
  observationId: QualificationId,
  observedState: Schema.Literals(["invariantHeld", "invariantViolated"]),
  observedAtUtc: QualificationUtcInstant,
  runId: QualificationId,
  target: QualificationId,
  trigger: QualificationId,
});

/** One actual clock observation for an intended open arrival. */
export interface ActualArrivalRecord extends OpenWorkloadArrival {
  readonly observedAtEpochMs: number;
}

/** Root-bound terminal disposition for one actual open arrival. */
export interface ArrivalDisposition {
  readonly authorityFactId: string;
  readonly disposition: "accepted" | "capacityRejected" | "typedStressRejected";
  readonly resolvedAtUtc: string;
  readonly rootId: string;
}

/** Versioned assertion evaluated for one accepted root. */
export interface RootOutcomeAssertion {
  readonly assertion: string;
  readonly authorityFactIds: ReadonlyArray<string>;
  readonly occurredAtUtc: string;
  readonly passed: boolean;
  readonly productFactChecksum: string;
  readonly productFactId: string;
}

/** Closed-window Good Root Outcome evidence for one accepted identity. */
export interface RootOutcomeRecord {
  readonly acceptedAtUtc: string;
  readonly assertionVersion: string;
  readonly assertions: ReadonlyArray<RootOutcomeAssertion>;
  readonly evaluatedAtUtc: string;
  readonly journey: ReferenceJourney;
  readonly milestoneAssertions: ReadonlyArray<RootOutcomeAssertion>;
  readonly milestoneEvaluatedAtUtc: string | null;
  readonly outcomeId: string;
  readonly rootId: string;
}

/** One exact workload window observation in manifest order. */
export interface LaneWindowEvidence {
  readonly endedAtUtc: string;
  readonly index: number;
  readonly kind: WorkloadLane["windows"][number]["kind"];
  readonly startedAtUtc: string;
}

/** Terminal admission totals for one complete arrival corpus. */
export interface ResolutionCounts {
  readonly accepted: number;
  readonly capacityRejected: number;
  readonly typedStressRejected: number;
}

/** Exact accepted Plan population for one run. */
export interface PlanCounts {
  readonly adventurer: number;
  readonly free: number;
}

/** Exact accepted journey population for one run. */
export type JourneyCounts = Readonly<Record<ReferenceJourney, number>>;

/** Immutable receipt returned by the owning qualification fault controller. */
export interface FaultControllerReceipt {
  readonly applicationAuthorityFactId: string;
  readonly applicationStatus: "applied" | "notApplied";
  readonly artifactChecksum: string;
  readonly artifactId: string;
  readonly controllerOperationId: string;
  readonly controllerSource: string;
  readonly durationSeconds: number;
  readonly endedAtUtc: string;
  readonly executionId: string;
  readonly injectedAtUtc: string;
  readonly kind: FaultInjection["kind"];
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly runId: string;
  readonly restorationAuthorityFactId: string;
  readonly scheduledTriggerAtUtc: string;
  readonly target: FaultInjection["target"];
  readonly trigger: FaultInjection["trigger"];
  readonly triggerAuthorityFactId: string | null;
  readonly triggerObservedAtUtc: string;
}

/** Parser for one producer-owned applied/restored fault-controller receipt. */
export const FaultControllerReceiptBoundary = Schema.Struct({
  applicationAuthorityFactId: QualificationId,
  applicationStatus: Schema.Literals(["applied", "notApplied"]),
  artifactChecksum: ArtifactChecksum,
  artifactId: QualificationId,
  controllerOperationId: QualificationId,
  controllerSource: QualificationId,
  durationSeconds: NonNegativeMeasurement,
  endedAtUtc: QualificationUtcInstant,
  executionId: QualificationId,
  injectedAtUtc: QualificationUtcInstant,
  kind: QualificationId,
  manifestChecksum: ArtifactChecksum,
  planChecksum: ArtifactChecksum,
  restorationAuthorityFactId: QualificationId,
  runId: QualificationId,
  scheduledTriggerAtUtc: QualificationUtcInstant,
  target: QualificationId,
  trigger: QualificationId,
  triggerAuthorityFactId: Schema.NullOr(QualificationId),
  triggerObservedAtUtc: QualificationUtcInstant,
});

/** Evidence retained for one lane repetition and region. */
export interface LaneRunEvidence {
  readonly acceptedRootIds: ReadonlyArray<string>;
  readonly actualArrivals: EvidenceArtifact<ActualArrivalRecord>;
  readonly clean: boolean;
  readonly dispositions: ReadonlyArray<ArrivalDisposition>;
  readonly faultControllerReceipt: FaultControllerReceipt | null;
  readonly identityPrefix: string;
  readonly intendedArrivals: EvidenceArtifact<OpenWorkloadArrival>;
  readonly lane: WorkloadLane["kind"];
  readonly journeyCounts: JourneyCounts;
  readonly planCounts: PlanCounts;
  readonly region: ProductionQualificationManifest["regions"][number];
  readonly repetition: number;
  readonly resolutions: ResolutionCounts;
  readonly rootOutcomes: ReadonlyArray<RootOutcomeRecord>;
  readonly seed: number;
  readonly windows: ReadonlyArray<LaneWindowEvidence>;
}

/** One measured Good Root Outcome denominator for a journey class. */
export interface JourneyOutcomeEvidence {
  readonly deadlineMs: number;
  readonly eligibleRoots: number;
  readonly goodRootOutcomes: number;
  readonly journey: ReferenceJourney;
  readonly milestoneDeadlineMs: number | null;
  readonly milestoneEligibleRoots: number;
  readonly timelyMilestoneOutcomes: number;
}

/** One complete isolated or combined Challenge Lane result. */
export interface ChallengeRunEvidence {
  readonly acceptedRootIds: ReadonlyArray<string>;
  readonly actualArrivals: EvidenceArtifact<ActualArrivalRecord>;
  readonly challenge: ChallengeLane["kind"];
  readonly completedAtUtc: string;
  readonly dispositions: ReadonlyArray<ArrivalDisposition>;
  readonly eligibleRoots: number;
  readonly faultInjection: FaultInjection | null;
  readonly faultControllerReceipt: FaultControllerReceipt | null;
  readonly faultObservations: EvidenceArtifact<{
    readonly authorityFactIds: ReadonlyArray<string>;
    readonly arrivalChecksum: string;
    readonly identityChecksum: string;
    readonly injectedAtUtc: string;
    readonly invariant: string;
    readonly invariantHeld: boolean;
    readonly observationId: string;
    readonly observedAtUtc: string;
    readonly observedState: "invariantHeld" | "invariantViolated";
    readonly runId: string;
    readonly target: string;
    readonly trigger: string;
  }>;
  readonly goodRootOutcomes: number;
  readonly identitySet: EvidenceArtifact;
  readonly identityPrefix: string;
  readonly intendedArrivals: EvidenceArtifact<OpenWorkloadArrival>;
  readonly journeyCounts: JourneyCounts;
  readonly passed: boolean;
  readonly planCounts: PlanCounts;
  readonly region: ProductionQualificationManifest["regions"][number];
  readonly rootOutcomes: ReadonlyArray<RootOutcomeRecord>;
  readonly seed: number;
  readonly sequence: number;
  readonly startedAtUtc: string;
}

/** One zero-tolerance production correctness violation. */
export interface CorrectnessViolation {
  readonly code:
    | "duplicateAuthority"
    | "duplicateEffect"
    | "ghostWork"
    | "irreconcilableOutcome"
    | "lostAcceptedWork"
    | "orderingGap"
    | "staleCommit"
    | "strandedAcceptedWork"
    | "unboundedAmplification";
  readonly rootId: string;
}

/** Exact retained-data dimensions reproduced by one growth characterization. */
export interface GrowthCorpusRunEvidence {
  readonly allowancePeriods: number | null;
  readonly characterizationArtifactId: string;
  readonly corpusArtifact: EvidenceArtifact<{
    readonly allowancePeriods: number | null;
    readonly measuredAtUtc: string;
    readonly queryVersion: string;
    readonly registeredUsers: number;
    readonly retainedRegisteredMessages: number;
    readonly sourceSnapshots: ReadonlyArray<CorpusAuthoritySnapshot>;
    readonly sourceSnapshotChecksum: string;
    readonly sourceVersion: string;
  }>;
  readonly corpusChecksum: string;
  readonly characterizationResultArtifact: EvidenceArtifact<{
    readonly correctnessViolations: ReadonlyArray<CorrectnessViolation["code"]>;
    readonly corpusChecksum: string;
    readonly failedQueries: number;
    readonly maximumQueueDepth: number;
    readonly queryP95Ms: number;
    readonly successfulQueries: number;
  }>;
  readonly kind: "depth" | "width";
  readonly registeredUsers: number;
  readonly retainedRegisteredMessages: number;
}

/** One retained historical high-rate characterization, without a pass threshold. */
export interface CharacterizationRunEvidence {
  readonly arrivals: EvidenceArtifact<{
    readonly offeredAtEpochMs: number;
    readonly rootId: string;
  }>;
  readonly kind: "historical232" | "historical464";
  readonly region: ProductionQualificationManifest["regions"][number];
}

/** Exact retained corpus loaded before production qualification begins. */
export interface AcceptanceCorpusEvidence {
  readonly artifactId: string;
  readonly checksum: string;
  readonly measuredAtUtc: string;
  readonly queryVersion: string;
  readonly registeredUsers: number;
  readonly retainedRegisteredMessages: number;
  readonly sourceSnapshots: ReadonlyArray<CorpusAuthoritySnapshot>;
  readonly sourceVersion: string;
}

/** Retained authority query receipt for one acceptance/growth corpus dimension. */
export interface CorpusAuthoritySnapshot {
  readonly artifactChecksum: string;
  readonly artifactId: string;
  readonly count: number;
  readonly identityDigest: string;
  readonly kind: "registeredUsers" | "retainedRegisteredMessages";
  readonly store: "AgentSQLite" | "PostgreSQL";
}

/** Minimum successful beta history needed before public qualification. */
export interface PublicPromotionEvidence {
  readonly acceptedRegisteredMessages: number;
  readonly consecutiveBetaDays: number;
}

/** Rolling beta reliability and observed-trace replacement evidence. */
export interface ContinuedBetaEvidence {
  readonly acceptedRegisteredMessages: number;
  readonly burnWindows: ReadonlyArray<{
    readonly artifactId: string;
    readonly badRoots: number;
    readonly eligibleRoots: number;
    readonly errorBudgetFraction: number;
    readonly maximumBurnRate: number;
    readonly measuredBurnRate: number;
    readonly verdict: "FAIL" | "PASS";
    readonly window: "1h" | "28d" | "3d" | "6h";
  }>;
  readonly errorBudget28DayArtifactId: string;
  readonly errorBudget28DayArtifactChecksum: string;
  readonly dailyEvidence: EvidenceArtifact<{
    readonly acceptedRegisteredMessages: number;
    readonly acceptedRootIds: ReadonlyArray<string>;
    readonly authorityArtifactChecksum: string;
    readonly authorityArtifactId: string;
    readonly correctnessViolations: ReadonlyArray<CorrectnessViolation["code"]>;
    readonly dayStartedAtUtc: string;
    readonly errorBudgetRemaining: number;
    readonly goodRootOutcomes: number;
    readonly goodRootIds: ReadonlyArray<string>;
    readonly rollingSevenDayRatio: number;
    readonly sourceVersion: string;
  }>;
  readonly observedTraceReplacement: {
    readonly acceptedRegisteredMessages: number;
    readonly artifactId: string;
    readonly checksum: string;
    readonly productionDays: number;
    readonly traceArtifact: EvidenceArtifact<{
      readonly acceptedRegisteredMessages: number;
      readonly amplificationDistribution: Readonly<
        Record<
          string,
          {
            readonly maximum: number;
            readonly p50: number;
            readonly p95: number;
            readonly p99: number;
          }
        >
      >;
      readonly coldCauseBasisPoints: Readonly<
        Record<"deployment" | "faultRecovery" | "firstUse" | "idleEviction" | "warm", number>
      >;
      readonly costUsdMicros: { readonly p50: number; readonly p95: number; readonly p99: number };
      readonly geographyBasisPoints: Readonly<
        Record<"americas" | "asiaPacific" | "europe", number>
      >;
      readonly historyDepth: { readonly p50: number; readonly p95: number; readonly p99: number };
      readonly journeyMix: Readonly<Record<ReferenceJourney, number>>;
      readonly planMixBasisPoints: { readonly adventurer: number; readonly free: number };
      readonly productionDays: number;
    }>;
  } | null;
  readonly productionDays: number;
  readonly rollingSevenDaySloArtifactId: string;
  readonly sloSplits: EvidenceArtifact<{
    readonly dayStartedAtUtc: string;
    readonly eligibleRoots: number;
    readonly eligibleRootIds: ReadonlyArray<string>;
    readonly goodRootOutcomes: number;
    readonly goodRootIds: ReadonlyArray<string>;
    readonly rollingSevenDayRatio: number;
    readonly sourceArtifactId: string;
    readonly sourceAuthorityFactIds: ReadonlyArray<string>;
    readonly sourceVersion: string;
    readonly split: string;
  }>;
}

/** Complete run, challenge, correctness, and teardown evidence for one manifest. */
export interface QualificationRunEvidence {
  readonly characterizationRuns: ReadonlyArray<CharacterizationRunEvidence>;
  readonly challengeRuns: ReadonlyArray<ChallengeRunEvidence>;
  readonly corpus: AcceptanceCorpusEvidence;
  readonly correctnessViolations: ReadonlyArray<CorrectnessViolation>;
  readonly continuedBeta: ContinuedBetaEvidence | null;
  readonly dependencyVersions: Readonly<Record<string, string>>;
  readonly growthCorpusRuns: ReadonlyArray<GrowthCorpusRunEvidence>;
  readonly journeyOutcomes: ReadonlyArray<JourneyOutcomeEvidence>;
  readonly laneRuns: ReadonlyArray<LaneRunEvidence>;
  readonly manifestChecksum: string;
  readonly publicPromotion: PublicPromotionEvidence | null;
  readonly sourceVersion: string;
  readonly teardownInventory: ReadonlyArray<string>;
  readonly topologyVersion: string;
  readonly workloadSeed: number;
}

const finding = (
  code: string,
  detail: string,
  subject: string,
  verdict: QualificationFinding["verdict"],
): QualificationFinding => ({ code, detail, subject, verdict });

const validUtc = (value: string): boolean =>
  value.endsWith("Z") && value.length > 0 && Number.isFinite(Date.parse(value));

const authorityTriggeredFaults = new Set([
  "afterAcceptanceBeforeUpdate",
  "afterConfirmedProgress",
  "afterExternalEffectBeforeStepCommit",
  "afterFirstAcceptance",
  "afterProviderAcceptanceBeforeResponse",
  "beforeProviderContact",
  "simultaneousAdmission",
]);

const faultReceiptHonorsTrigger = (
  receipt: FaultControllerReceipt,
  dispositions: ReadonlyArray<ArrivalDisposition>,
  runStartedAtUtc: string,
  runEndedAtUtc: string,
): boolean => {
  const scheduledAt = Date.parse(receipt.scheduledTriggerAtUtc);
  const observedAt = Date.parse(receipt.triggerObservedAtUtc);
  const injectedAt = Date.parse(receipt.injectedAtUtc);
  const requiresAuthorityFact = authorityTriggeredFaults.has(receipt.trigger);
  const triggerDisposition =
    receipt.triggerAuthorityFactId === null
      ? undefined
      : dispositions.find(
          ({ authorityFactId }) => authorityFactId === receipt.triggerAuthorityFactId,
        );
  return (
    validUtc(receipt.scheduledTriggerAtUtc) &&
    validUtc(receipt.triggerObservedAtUtc) &&
    validUtc(receipt.injectedAtUtc) &&
    receipt.applicationAuthorityFactId.length > 0 &&
    receipt.restorationAuthorityFactId.length > 0 &&
    receipt.applicationAuthorityFactId !== receipt.restorationAuthorityFactId &&
    scheduledAt >= Date.parse(runStartedAtUtc) &&
    observedAt >= scheduledAt &&
    injectedAt >= observedAt &&
    injectedAt <= Date.parse(runEndedAtUtc) &&
    Date.parse(receipt.endedAtUtc) === injectedAt + receipt.durationSeconds * 1_000 &&
    (requiresAuthorityFact
      ? triggerDisposition !== undefined &&
        Date.parse(triggerDisposition.resolvedAtUtc) <= observedAt
      : receipt.triggerAuthorityFactId === null && injectedAt - scheduledAt <= 250)
  );
};

const parseArtifact = parseEvidenceArtifact;

const validPopulationCounts = (
  total: number,
  planCounts: PlanCounts,
  journeyCounts: JourneyCounts,
): boolean => {
  const counts = [planCounts.free, planCounts.adventurer, ...Object.values(journeyCounts)];
  return (
    counts.every((value) => Number.isInteger(value) && value >= 0) &&
    planCounts.free + planCounts.adventurer === total &&
    Object.values(journeyCounts).reduce((sum, value) => sum + value, 0) === total
  );
};

const matchesReferenceMix = (
  manifest: ProductionQualificationManifest,
  total: number,
  planCounts: PlanCounts,
  journeyCounts: JourneyCounts,
): boolean =>
  planCounts.free * 10_000 === total * manifest.planMixBasisPoints.free &&
  planCounts.adventurer * 10_000 === total * manifest.planMixBasisPoints.adventurer &&
  manifest.journeyMix.every(
    (journey) => journeyCounts[journey.journey] * 100 === total * journey.percentage,
  );

const sameVersions = (
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean => {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => actual[key] === expected[key])
  );
};

interface DerivedJourneyOutcome {
  eligibleRoots: number;
  goodRootOutcomes: number;
  milestoneEligibleRoots: number;
  timelyMilestoneOutcomes: number;
}

const validateRootBoundRun = (
  manifest: ProductionQualificationManifest,
  subject: string,
  intended: ReadonlyArray<OpenWorkloadArrival>,
  actual: ReadonlyArray<ActualArrivalRecord>,
  dispositions: ReadonlyArray<ArrivalDisposition>,
  acceptedRootIds: ReadonlyArray<string>,
  rootOutcomes: ReadonlyArray<RootOutcomeRecord>,
  resolutions: ResolutionCounts,
  planCounts: PlanCounts,
  journeyCounts: JourneyCounts,
  runStartedAtUtc: string,
  runEndedAtUtc: string,
  derivedOutcomes: Map<ReferenceJourney, DerivedJourneyOutcome>,
  findings: Array<QualificationFinding>,
): void => {
  const intendedByRoot = new Map(intended.map((arrival) => [arrival.rootId, arrival]));
  const actualByRoot = new Map(actual.map((arrival) => [arrival.rootId, arrival]));
  if (
    intendedByRoot.size !== intended.length ||
    actualByRoot.size !== actual.length ||
    intended.length !== actual.length ||
    intended.some((offered) => {
      const observed = actualByRoot.get(offered.rootId);
      return (
        observed === undefined ||
        observed.journey !== offered.journey ||
        observed.plan !== offered.plan ||
        observed.offeredAtEpochMs !== offered.offeredAtEpochMs ||
        !Number.isFinite(observed.observedAtEpochMs) ||
        observed.observedAtEpochMs < offered.offeredAtEpochMs
      );
    })
  ) {
    findings.push(
      finding(
        "actualArrivalIdentityConflict",
        `${subject} actual arrivals do not exactly match the unique intended identity set`,
        subject,
        "FAIL",
      ),
    );
  }
  const dispositionsByRoot = new Map(dispositions.map((record) => [record.rootId, record]));
  if (
    dispositionsByRoot.size !== dispositions.length ||
    new Set(dispositions.map(({ authorityFactId }) => authorityFactId)).size !==
      dispositions.length ||
    dispositions.length !== actual.length ||
    actual.some((arrival) => !dispositionsByRoot.has(arrival.rootId)) ||
    dispositions.some((record) => {
      const arrival = actualByRoot.get(record.rootId);
      const resolvedAt = Date.parse(record.resolvedAtUtc);
      return (
        arrival === undefined ||
        record.authorityFactId.length === 0 ||
        !validUtc(record.resolvedAtUtc) ||
        resolvedAt < arrival.observedAtEpochMs ||
        resolvedAt < Date.parse(runStartedAtUtc) ||
        resolvedAt > Date.parse(runEndedAtUtc)
      );
    })
  ) {
    findings.push(
      finding(
        "arrivalDispositionConflict",
        `${subject} does not retain one root-bound terminal disposition per actual arrival`,
        subject,
        "FAIL",
      ),
    );
  }
  const derivedResolution: ResolutionCounts = {
    accepted: dispositions.filter((record) => record.disposition === "accepted").length,
    capacityRejected: dispositions.filter((record) => record.disposition === "capacityRejected")
      .length,
    typedStressRejected: dispositions.filter(
      (record) => record.disposition === "typedStressRejected",
    ).length,
  };
  const derivedAcceptedRoots = dispositions
    .filter((record) => record.disposition === "accepted")
    .map((record) => record.rootId);
  const acceptedArrivals = derivedAcceptedRoots.flatMap((rootId) => {
    const arrival = actualByRoot.get(rootId);
    return arrival === undefined ? [] : [arrival];
  });
  const derivedPlanCounts: PlanCounts = {
    adventurer: acceptedArrivals.filter((arrival) => arrival.plan === "adventurer").length,
    free: acceptedArrivals.filter((arrival) => arrival.plan === "free").length,
  };
  const countJourney = (journey: ReferenceJourney): number =>
    acceptedArrivals.filter((arrival) => arrival.journey === journey).length;
  const derivedJourneyCounts = {
    accountBillingSafetyDataRights: countJourney("accountBillingSafetyDataRights"),
    documentBuild: countJourney("documentBuild"),
    fileAnalysis: countJourney("fileAnalysis"),
    gmail: countJourney("gmail"),
    ordinaryConversation: countJourney("ordinaryConversation"),
    registration: countJourney("registration"),
    reminder: countJourney("reminder"),
    researchReport: countJourney("researchReport"),
    scheduledEmail: countJourney("scheduledEmail"),
  } satisfies JourneyCounts;
  if (
    derivedResolution.accepted !== resolutions.accepted ||
    derivedResolution.capacityRejected !== resolutions.capacityRejected ||
    derivedResolution.typedStressRejected !== resolutions.typedStressRejected ||
    qualificationChecksum(derivedAcceptedRoots) !== qualificationChecksum(acceptedRootIds)
  ) {
    findings.push(
      finding(
        "arrivalResolutionMismatch",
        `${subject} aggregate resolutions do not match root-bound dispositions`,
        subject,
        "FAIL",
      ),
    );
  }
  if (
    derivedPlanCounts.adventurer !== planCounts.adventurer ||
    derivedPlanCounts.free !== planCounts.free ||
    manifest.journeyMix.some(
      (requirement) =>
        derivedJourneyCounts[requirement.journey] !== journeyCounts[requirement.journey],
    )
  ) {
    findings.push(
      finding(
        "runPopulationEvidenceConflict",
        `${subject} Plan or journey aggregates do not match accepted root dispositions`,
        subject,
        "FAIL",
      ),
    );
  }
  const outcomesByRoot = new Map(rootOutcomes.map((outcome) => [outcome.rootId, outcome]));
  if (
    outcomesByRoot.size !== rootOutcomes.length ||
    rootOutcomes.length !== derivedAcceptedRoots.length ||
    derivedAcceptedRoots.some((rootId) => !outcomesByRoot.has(rootId))
  ) {
    findings.push(
      finding(
        "rootOutcomeDenominatorConflict",
        `${subject} does not retain one outcome evaluation for every accepted root`,
        subject,
        "FAIL",
      ),
    );
  }
  for (const rootId of derivedAcceptedRoots) {
    const outcome = outcomesByRoot.get(rootId);
    const arrival = actualByRoot.get(rootId);
    if (outcome === undefined || arrival === undefined) continue;
    const requirement = manifest.journeyMix.find((entry) => entry.journey === arrival.journey);
    if (requirement === undefined) continue;
    const acceptedAt = Date.parse(outcome.acceptedAtUtc);
    const evaluatedAt = Date.parse(outcome.evaluatedAtUtc);
    const assertionValid = (assertion: RootOutcomeAssertion, expected: string): boolean =>
      assertion.assertion === expected &&
      assertion.authorityFactIds.length > 0 &&
      new Set(assertion.authorityFactIds).size === assertion.authorityFactIds.length &&
      assertion.productFactId.length > 0 &&
      assertion.productFactId === outcome.outcomeId &&
      validUtc(assertion.occurredAtUtc) &&
      assertion.productFactChecksum ===
        qualificationChecksum({
          assertion: assertion.assertion,
          authorityFactIds: assertion.authorityFactIds,
          occurredAtUtc: assertion.occurredAtUtc,
          passed: assertion.passed,
          productFactId: assertion.productFactId,
          rootId,
        });
    const assertionsValid =
      outcome.assertionVersion === requirement.assertionVersion &&
      outcome.assertions.length === requirement.assertions.length &&
      requirement.assertions.every((expected, index) => {
        const assertion = outcome.assertions[index];
        return assertion !== undefined && assertionValid(assertion, expected);
      });
    const good =
      outcome.journey === arrival.journey &&
      validUtc(outcome.acceptedAtUtc) &&
      validUtc(outcome.evaluatedAtUtc) &&
      evaluatedAt >= acceptedAt &&
      evaluatedAt - acceptedAt <= requirement.deadlineMs &&
      assertionsValid &&
      outcome.assertions.every((assertion) => assertion.passed);
    const milestoneRequired =
      requirement.milestoneDeadlineMs !== null &&
      evaluatedAt - acceptedAt > requirement.milestoneDeadlineMs;
    const milestoneAt = Date.parse(outcome.milestoneEvaluatedAtUtc ?? "");
    const milestoneGood =
      milestoneRequired &&
      outcome.milestoneEvaluatedAtUtc !== null &&
      validUtc(outcome.milestoneEvaluatedAtUtc) &&
      milestoneAt >= acceptedAt &&
      milestoneAt - acceptedAt <= requirement.milestoneDeadlineMs &&
      outcome.milestoneAssertions.length === requirement.milestoneAssertions.length &&
      requirement.milestoneAssertions.every((expected, index) => {
        const assertion = outcome.milestoneAssertions[index];
        return assertion !== undefined && assertionValid(assertion, expected);
      });
    if (
      outcome.journey !== arrival.journey ||
      !validUtc(outcome.acceptedAtUtc) ||
      !validUtc(outcome.evaluatedAtUtc) ||
      outcome.assertionVersion !== requirement.assertionVersion ||
      outcome.outcomeId.length === 0 ||
      !assertionsValid ||
      (!milestoneRequired &&
        (outcome.milestoneEvaluatedAtUtc !== null || outcome.milestoneAssertions.length > 0))
    ) {
      findings.push(
        finding(
          "rootOutcomeEvidenceInvalid",
          `${rootId} has malformed or mismatched versioned outcome evidence`,
          rootId,
          "FAIL",
        ),
      );
    }
    const aggregate = derivedOutcomes.get(arrival.journey) ?? {
      eligibleRoots: 0,
      goodRootOutcomes: 0,
      milestoneEligibleRoots: 0,
      timelyMilestoneOutcomes: 0,
    };
    aggregate.eligibleRoots += 1;
    if (good) aggregate.goodRootOutcomes += 1;
    if (milestoneRequired) aggregate.milestoneEligibleRoots += 1;
    if (milestoneGood) aggregate.timelyMilestoneOutcomes += 1;
    derivedOutcomes.set(arrival.journey, aggregate);
  }
};

/** Assess required run and challenge coverage for one frozen manifest. */
export const assessQualificationRuns = (
  manifest: ProductionQualificationManifest,
  evidence: QualificationRunEvidence,
): QualificationAssessment => {
  const findings: Array<QualificationFinding> = [];
  const derivedJourneyOutcomes = new Map<ReferenceJourney, DerivedJourneyOutcome>();
  if (
    evidence.manifestChecksum.length === 0 ||
    evidence.manifestChecksum !== manifest.manifestChecksum ||
    evidence.sourceVersion !== manifest.sourceVersion ||
    evidence.topologyVersion !== manifest.topologyVersion ||
    evidence.workloadSeed !== manifest.workloadSeed ||
    !sameVersions(evidence.dependencyVersions, manifest.dependencyVersions)
  ) {
    findings.push(
      finding(
        "evidenceBundleVersionMismatch",
        "The evidence bundle is not bound to the frozen manifest and exact deployed versions",
        manifest.acceptanceLevel,
        "FAIL",
      ),
    );
  }
  const corpusSnapshots = new Map(evidence.corpus.sourceSnapshots.map((item) => [item.kind, item]));
  const registeredUsersSnapshot = corpusSnapshots.get("registeredUsers");
  const retainedMessagesSnapshot = corpusSnapshots.get("retainedRegisteredMessages");
  if (
    evidence.corpus.artifactId.length === 0 ||
    evidence.corpus.queryVersion.length === 0 ||
    evidence.corpus.sourceVersion.length === 0 ||
    !validUtc(evidence.corpus.measuredAtUtc) ||
    registeredUsersSnapshot === undefined ||
    retainedMessagesSnapshot === undefined
  ) {
    findings.push(
      finding(
        "acceptanceCorpusAuthorityMissing",
        "Acceptance Corpus has no retained PostgreSQL and AgentSQLite authority snapshots",
        manifest.acceptanceLevel,
        "MISSING",
      ),
    );
  } else {
    const { checksum, ...corpusContent } = evidence.corpus;
    const snapshotInvalid = evidence.corpus.sourceSnapshots.some((snapshot) => {
      const { artifactChecksum, ...snapshotContent } = snapshot;
      return (
        artifactChecksum !== qualificationChecksum(snapshotContent) ||
        snapshot.artifactId.length === 0 ||
        snapshot.identityDigest.length === 0
      );
    });
    if (
      checksum !== qualificationChecksum(corpusContent) ||
      evidence.corpus.sourceSnapshots.length !== 2 ||
      snapshotInvalid ||
      evidence.corpus.sourceVersion !== manifest.sourceVersion ||
      registeredUsersSnapshot.store !== "PostgreSQL" ||
      retainedMessagesSnapshot.store !== "AgentSQLite" ||
      registeredUsersSnapshot.count !== evidence.corpus.registeredUsers ||
      retainedMessagesSnapshot.count !== evidence.corpus.retainedRegisteredMessages ||
      evidence.corpus.registeredUsers !== manifest.corpus.registeredUsers ||
      evidence.corpus.retainedRegisteredMessages !== manifest.corpus.retainedRegisteredMessages
    ) {
      findings.push(
        finding(
          "acceptanceCorpusAuthorityConflict",
          `Authority corpus ${evidence.corpus.registeredUsers}/${evidence.corpus.retainedRegisteredMessages} does not match the frozen acceptance corpus`,
          manifest.acceptanceLevel,
          "FAIL",
        ),
      );
    }
  }

  for (const characterization of manifest.characterizationLanes) {
    for (const region of manifest.regions) {
      const subject = `${characterization.kind}:${region}`;
      const runs = evidence.characterizationRuns.filter(
        (run) => run.kind === characterization.kind && run.region === region,
      );
      if (runs.length > 1) {
        findings.push(
          finding(
            "duplicateCharacterizationRun",
            `${subject} has ${runs.length} retained artifacts`,
            subject,
            "FAIL",
          ),
        );
      }
      const run = runs[0];
      if (run === undefined) {
        findings.push(
          finding(
            "characterizationRunMissing",
            `${subject} has no retained arrival artifact`,
            subject,
            "MISSING",
          ),
        );
        continue;
      }
      const arrivals = parseArtifact(
        run.arrivals,
        CharacterizationArrivalBoundary,
        subject,
        findings,
      );
      if (arrivals === undefined) continue;
      if (
        arrivals.count !==
          characterization.offeredRatePerSecond * characterization.durationSeconds ||
        arrivals.records.some(
          (arrival) => arrival.rootId.length === 0 || !Number.isFinite(arrival.offeredAtEpochMs),
        )
      ) {
        findings.push(
          finding(
            "characterizationArrivalConflict",
            `${subject} does not retain the exact historical offered-arrival population`,
            subject,
            "FAIL",
          ),
        );
      }
    }
  }

  const allAcceptedRootIds: Array<string> = [];
  const faultObservationIds = new Set<string>();
  for (const lane of manifest.lanes) {
    const expectedArrivals = intendedArrivalCount(lane);
    for (const region of manifest.regions) {
      for (let repetition = 1; repetition <= lane.repetitions; repetition += 1) {
        const subject = `${lane.kind}:${region}:${repetition}`;
        const matchingRuns = evidence.laneRuns.filter(
          (candidate) =>
            candidate.lane === lane.kind &&
            candidate.region === region &&
            candidate.repetition === repetition,
        );
        if (matchingRuns.length > 1)
          findings.push(
            finding(
              "duplicateLaneRepetition",
              `${subject} has ${matchingRuns.length} run records`,
              subject,
              "FAIL",
            ),
          );
        const run = matchingRuns[0];
        if (run === undefined) {
          findings.push(
            finding("laneRepetitionMissing", `${subject} was not run`, subject, "MISSING"),
          );
          continue;
        }
        const intendedArrivals = parseArtifact(
          run.intendedArrivals,
          OpenArrivalBoundary,
          `${subject}:intended`,
          findings,
        );
        const actualArrivals = parseArtifact(
          run.actualArrivals,
          ActualArrivalBoundary,
          `${subject}:actual`,
          findings,
        );
        if (intendedArrivals === undefined || actualArrivals === undefined) continue;
        if (run.windows.length !== lane.windows.length) {
          findings.push(
            finding(
              "workloadWindowSequenceMissing",
              `${subject} does not retain every frozen workload window`,
              subject,
              "MISSING",
            ),
          );
        }
        for (const [index, expectedWindow] of lane.windows.entries()) {
          const observedWindow = run.windows[index];
          const expectedStart =
            index === 0
              ? Date.parse(run.windows[0]?.startedAtUtc ?? "")
              : Date.parse(run.windows[index - 1]?.endedAtUtc ?? "");
          if (
            observedWindow === undefined ||
            observedWindow.index !== index ||
            observedWindow.kind !== expectedWindow.kind ||
            !validUtc(observedWindow.startedAtUtc) ||
            !validUtc(observedWindow.endedAtUtc) ||
            Date.parse(observedWindow.startedAtUtc) !== expectedStart ||
            Date.parse(observedWindow.endedAtUtc) - Date.parse(observedWindow.startedAtUtc) !==
              expectedWindow.durationSeconds * 1_000
          ) {
            findings.push(
              finding(
                "workloadWindowSequenceConflict",
                `${subject} window ${index} does not match the frozen kind, order, or duration`,
                subject,
                "FAIL",
              ),
            );
          }
        }
        const expectedIntendedArrivals = lane.windows.flatMap((windowValue, windowIndex) => {
          if (windowValue.kind !== "offer" && windowValue.kind !== "fault") return [];
          return generateOpenArrivals({
            identityPrefix: run.identityPrefix,
            journeyMix: manifest.journeyMix,
            planMixBasisPoints: manifest.planMixBasisPoints,
            seed: run.seed,
            startsAtEpochMs: Date.parse(run.windows[windowIndex]?.startedAtUtc ?? ""),
            window: windowValue,
          });
        });
        if (
          run.identityPrefix.length === 0 ||
          intendedArrivals.checksum !== qualificationChecksum(expectedIntendedArrivals)
        ) {
          findings.push(
            finding(
              "intendedArrivalScheduleConflict",
              `${subject} does not reproduce the manifest-derived open-arrival schedule`,
              subject,
              "FAIL",
            ),
          );
        }
        const intendedByRoot = new Map(
          intendedArrivals.records.map((arrival) => [arrival.rootId, arrival]),
        );
        if (
          actualArrivals.records.some((arrival) => {
            const intended = intendedByRoot.get(arrival.rootId);
            return (
              intended === undefined ||
              arrival.journey !== intended.journey ||
              arrival.plan !== intended.plan ||
              arrival.offeredAtEpochMs !== intended.offeredAtEpochMs ||
              !Number.isFinite(arrival.observedAtEpochMs)
            );
          })
        ) {
          findings.push(
            finding(
              "actualArrivalRecordConflict",
              `${subject} actual arrivals do not bind to the exact intended schedule`,
              subject,
              "FAIL",
            ),
          );
        }
        if (run.seed !== expectedRunSeed(manifest, lane.kind, region, repetition)) {
          findings.push(
            finding("workloadSeedMismatch", `${subject} used seed ${run.seed}`, subject, "FAIL"),
          );
        }
        const expectedLaneFault =
          lane.kind === "allCold"
            ? manifest.faults.find(({ kind }) => kind === "coldActivation")
            : lane.kind === "dependencyOutageRecovery"
              ? manifest.faults.find(({ kind }) => kind === "dependencyOutage")
              : undefined;
        const laneFaultReceipt = run.faultControllerReceipt;
        if (expectedLaneFault === undefined && laneFaultReceipt !== null) {
          findings.push(
            finding(
              "laneFaultControllerReceiptUnexpected",
              `${subject} retained a fault receipt for a non-fault lane`,
              subject,
              "FAIL",
            ),
          );
        } else if (expectedLaneFault !== undefined && laneFaultReceipt === null) {
          findings.push(
            finding(
              "laneFaultControllerReceiptMissing",
              `${subject} has no retained applied fault-controller receipt`,
              subject,
              "MISSING",
            ),
          );
        } else if (expectedLaneFault !== undefined && laneFaultReceipt !== null) {
          const { artifactChecksum, ...receiptContent } = laneFaultReceipt;
          if (
            artifactChecksum !== qualificationChecksum(receiptContent) ||
            laneFaultReceipt.applicationStatus !== "applied" ||
            laneFaultReceipt.executionId.length === 0 ||
            laneFaultReceipt.manifestChecksum !== manifest.manifestChecksum ||
            laneFaultReceipt.planChecksum.length === 0 ||
            laneFaultReceipt.runId.length === 0 ||
            laneFaultReceipt.kind !== expectedLaneFault.kind ||
            laneFaultReceipt.target !== expectedLaneFault.target ||
            laneFaultReceipt.trigger !== expectedLaneFault.trigger ||
            laneFaultReceipt.durationSeconds !== expectedLaneFault.durationSeconds ||
            !faultReceiptHonorsTrigger(
              laneFaultReceipt,
              run.dispositions,
              run.windows[0]?.startedAtUtc ?? "",
              run.windows.at(-1)?.endedAtUtc ?? "",
            )
          ) {
            findings.push(
              finding(
                "laneFaultControllerReceiptConflict",
                `${subject} fault controller did not apply the exact frozen lane fault`,
                subject,
                "FAIL",
              ),
            );
          }
        }
        if (intendedArrivals.count !== expectedArrivals) {
          findings.push(
            finding(
              "intendedArrivalCountMismatch",
              `${subject} intended ${intendedArrivals.count}, expected ${expectedArrivals}`,
              subject,
              "FAIL",
            ),
          );
        }
        if (actualArrivals.count !== intendedArrivals.count) {
          findings.push(
            finding(
              "actualArrivalCountMismatch",
              `${subject} observed ${actualArrivals.count} of ${intendedArrivals.count} intended arrivals`,
              subject,
              "FAIL",
            ),
          );
        }
        const resolved =
          run.resolutions.accepted +
          run.resolutions.capacityRejected +
          run.resolutions.typedStressRejected;
        if (
          Object.values(run.resolutions).some((value) => !Number.isInteger(value) || value < 0) ||
          resolved !== actualArrivals.count ||
          run.acceptedRootIds.length !== run.resolutions.accepted ||
          new Set(run.acceptedRootIds).size !== run.acceptedRootIds.length ||
          run.acceptedRootIds.some((rootId) => rootId.length === 0)
        ) {
          findings.push(
            finding(
              "arrivalResolutionMismatch",
              `${subject} does not resolve its complete actual arrival corpus`,
              subject,
              "FAIL",
            ),
          );
        }
        if (
          !validPopulationCounts(run.resolutions.accepted, run.planCounts, run.journeyCounts) ||
          !matchesReferenceMix(
            manifest,
            run.resolutions.accepted,
            run.planCounts,
            run.journeyCounts,
          )
        ) {
          findings.push(
            finding(
              "runPopulationMixMismatch",
              `${subject} does not reproduce the frozen Plan and journey mix`,
              subject,
              "FAIL",
            ),
          );
        }
        validateRootBoundRun(
          manifest,
          subject,
          intendedArrivals.records,
          actualArrivals.records,
          run.dispositions,
          run.acceptedRootIds,
          run.rootOutcomes,
          run.resolutions,
          run.planCounts,
          run.journeyCounts,
          intendedArrivals.windowStartedAtUtc,
          intendedArrivals.windowEndedAtUtc,
          derivedJourneyOutcomes,
          findings,
        );
        if (!run.clean)
          findings.push(
            finding(
              "laneRunNotClean",
              `${subject} did not complete as a clean repetition`,
              subject,
              "FAIL",
            ),
          );
        if (lane.kind === "target" && run.resolutions.accepted !== actualArrivals.count) {
          findings.push(
            finding(
              "targetAdmissionRejected",
              `${subject} rejected a valid offered identity`,
              subject,
              "FAIL",
            ),
          );
        }
        allAcceptedRootIds.push(...run.acceptedRootIds);
      }
    }
  }

  for (const challenge of manifest.challengeLanes) {
    for (const region of manifest.regions) {
      const subject = `${challenge.kind}:${region}`;
      const runs = evidence.challengeRuns.filter(
        (run) => run.challenge === challenge.kind && run.region === region,
      );
      if (runs.length > 1)
        findings.push(
          finding(
            "duplicateChallengeRun",
            `${subject} has ${runs.length} run records`,
            subject,
            "FAIL",
          ),
        );
      const run = runs[0];
      if (run === undefined) {
        findings.push(finding("challengeRunMissing", `${subject} was not run`, subject, "MISSING"));
        continue;
      }
      const identitySet = parseArtifact(run.identitySet, Schema.String, subject, findings);
      const intendedArrivals = parseArtifact(
        run.intendedArrivals,
        OpenArrivalBoundary,
        `${subject}:intended`,
        findings,
      );
      const actualArrivals = parseArtifact(
        run.actualArrivals,
        ActualArrivalBoundary,
        `${subject}:actual`,
        findings,
      );
      const faultObservations = parseArtifact(
        run.faultObservations,
        FaultObservationBoundary,
        `${subject}:fault`,
        findings,
      );
      if (
        identitySet === undefined ||
        intendedArrivals === undefined ||
        actualArrivals === undefined ||
        faultObservations === undefined
      )
        continue;
      const expectedFault = manifest.faults.find((fault) => fault.kind === challenge.kind);
      if (
        (expectedFault === undefined && run.faultInjection !== null) ||
        (expectedFault !== undefined &&
          (run.faultInjection === null ||
            run.faultInjection.kind !== expectedFault.kind ||
            run.faultInjection.target !== expectedFault.target ||
            run.faultInjection.trigger !== expectedFault.trigger ||
            run.faultInjection.durationSeconds !== expectedFault.durationSeconds ||
            run.faultInjection.expectedInvariant !== expectedFault.expectedInvariant))
      ) {
        findings.push(
          finding(
            "faultInjectionManifestConflict",
            `${subject} did not use the frozen fault target, trigger, duration, and invariant`,
            subject,
            "FAIL",
          ),
        );
      }
      const controllerReceipt = run.faultControllerReceipt;
      if (expectedFault === undefined) {
        if (controllerReceipt !== null) {
          findings.push(
            finding(
              "faultControllerReceiptUnexpected",
              `${subject} names a controller injection for a non-fault challenge`,
              subject,
              "FAIL",
            ),
          );
        }
      } else if (controllerReceipt === null) {
        findings.push(
          finding(
            "faultControllerReceiptMissing",
            `${subject} has no retained fault-controller injection receipt`,
            subject,
            "MISSING",
          ),
        );
      } else {
        const { artifactChecksum, ...receiptContent } = controllerReceipt;
        if (
          artifactChecksum !== qualificationChecksum(receiptContent) ||
          controllerReceipt.applicationStatus !== "applied" ||
          controllerReceipt.executionId.length === 0 ||
          controllerReceipt.manifestChecksum !== manifest.manifestChecksum ||
          controllerReceipt.planChecksum.length === 0 ||
          controllerReceipt.runId.length === 0 ||
          controllerReceipt.kind !== expectedFault.kind ||
          controllerReceipt.target !== expectedFault.target ||
          controllerReceipt.trigger !== expectedFault.trigger ||
          controllerReceipt.durationSeconds !== expectedFault.durationSeconds ||
          !faultReceiptHonorsTrigger(
            controllerReceipt,
            run.dispositions,
            run.startedAtUtc,
            run.completedAtUtc,
          ) ||
          Date.parse(controllerReceipt.endedAtUtc) !==
            Date.parse(controllerReceipt.injectedAtUtc) +
              controllerReceipt.durationSeconds * 1_000 ||
          Date.parse(controllerReceipt.endedAtUtc) > Date.parse(run.completedAtUtc)
        ) {
          findings.push(
            finding(
              "faultControllerReceiptConflict",
              `${subject} controller receipt is not bound to its manifest, run, window, and fault`,
              subject,
              "FAIL",
            ),
          );
        }
      }
      const faultRecords = faultObservations.records;
      const faultEvidencePasses =
        run.faultInjection === null
          ? faultRecords.length === 0
          : faultRecords.length > 0 &&
            faultRecords.every(
              (record) =>
                record.observationId.length > 0 &&
                record.authorityFactIds.length > 0 &&
                !faultObservationIds.has(record.observationId) &&
                record.runId === identitySet.artifactId &&
                record.arrivalChecksum === actualArrivals.checksum &&
                record.identityChecksum === identitySet.checksum &&
                validUtc(record.injectedAtUtc) &&
                validUtc(record.observedAtUtc) &&
                Date.parse(record.injectedAtUtc) >= Date.parse(run.startedAtUtc) &&
                Date.parse(record.injectedAtUtc) <= Date.parse(run.completedAtUtc) &&
                Date.parse(record.observedAtUtc) >= Date.parse(record.injectedAtUtc) &&
                Date.parse(record.observedAtUtc) <= Date.parse(run.completedAtUtc) &&
                record.target === run.faultInjection?.target &&
                record.trigger === run.faultInjection?.trigger &&
                record.invariant === run.faultInjection?.expectedInvariant &&
                record.invariantHeld === (record.observedState === "invariantHeld") &&
                record.observedState === "invariantHeld" &&
                controllerReceipt !== null &&
                record.injectedAtUtc === controllerReceipt.injectedAtUtc,
            );
      for (const record of faultRecords) faultObservationIds.add(record.observationId);
      if (!faultEvidencePasses) {
        findings.push(
          finding(
            "faultInvariantEvidenceMissing",
            `${subject} has no run-bound passing observation for its frozen invariant`,
            subject,
            faultRecords.some((record) => !record.invariantHeld) ? "FAIL" : "MISSING",
          ),
        );
      }
      const minimumEligibleRoots =
        challenge.minimumEligibleRoots === "targetWindow"
          ? (() => {
              const targetLane = manifest.lanes.find((laneValue) => laneValue.kind === "target");
              return targetLane === undefined
                ? Number.POSITIVE_INFINITY
                : intendedArrivalCount(targetLane);
            })()
          : challenge.minimumEligibleRoots;
      const targetOffer = manifest.lanes
        .find((laneValue) => laneValue.kind === "target")
        ?.windows.find((window) => window.kind === "offer" || window.kind === "fault");
      const offeredRatePerSecond =
        challenge.offeredRatePerSecond === "targetRate"
          ? (targetOffer?.startRatePerSecond ?? Number.NaN)
          : challenge.offeredRatePerSecond;
      const offerDurationSeconds =
        challenge.offerDurationSeconds === "targetDuration"
          ? (targetOffer?.durationSeconds ?? Number.NaN)
          : challenge.offerDurationSeconds;
      const expectedChallengeRoots = offeredRatePerSecond * offerDurationSeconds;
      const expectedChallengeSeed =
        manifest.workloadSeed + challenge.seedOffset + Array.from(manifest.regions).indexOf(region);
      const openScheduleMatches = intendedArrivals.records.every(
        (arrival, index) =>
          arrival.rootId === `${run.identityPrefix}-${index}` &&
          arrival.offeredAtEpochMs ===
            Date.parse(run.startedAtUtc) + Math.floor((index * 1_000) / offeredRatePerSecond),
      );
      if (
        !validUtc(run.startedAtUtc) ||
        !validUtc(run.completedAtUtc) ||
        Date.parse(run.completedAtUtc) <= Date.parse(run.startedAtUtc) ||
        !Number.isInteger(run.sequence) ||
        run.sequence < 1 ||
        !Number.isInteger(run.eligibleRoots) ||
        run.eligibleRoots !== minimumEligibleRoots ||
        run.eligibleRoots !== expectedChallengeRoots ||
        run.seed !== expectedChallengeSeed ||
        run.identityPrefix.length === 0 ||
        intendedArrivals.count !== expectedChallengeRoots ||
        !openScheduleMatches ||
        !Number.isInteger(run.goodRootOutcomes) ||
        run.goodRootOutcomes < 0 ||
        run.goodRootOutcomes > run.eligibleRoots ||
        identitySet.count !== run.eligibleRoots ||
        run.acceptedRootIds.length !== run.eligibleRoots ||
        new Set(run.acceptedRootIds).size !== run.acceptedRootIds.length
      ) {
        findings.push(
          finding(
            "challengeEvidenceInvalid",
            `${subject} has an invalid closed evaluation window or identity set`,
            subject,
            "FAIL",
          ),
        );
      }
      if (!validPopulationCounts(run.eligibleRoots, run.planCounts, run.journeyCounts)) {
        findings.push(
          finding(
            "challengePopulationInvalid",
            `${subject} has invalid Plan or journey population counts`,
            subject,
            "FAIL",
          ),
        );
      } else if (
        challenge.planPolicy === "allAdventurer" &&
        run.planCounts.adventurer !== run.eligibleRoots
      ) {
        findings.push(
          finding(
            "allAdventurerChallengeInvalid",
            `${subject} was not 100 percent Adventurer`,
            subject,
            "FAIL",
          ),
        );
      } else if (
        challenge.planPolicy === "referenceMix" &&
        !matchesReferenceMix(manifest, run.eligibleRoots, run.planCounts, run.journeyCounts)
      ) {
        findings.push(
          finding(
            "challengePopulationMixMismatch",
            `${subject} does not reproduce the frozen Plan and journey mix`,
            subject,
            "FAIL",
          ),
        );
      }
      validateRootBoundRun(
        manifest,
        subject,
        intendedArrivals.records,
        actualArrivals.records,
        run.dispositions,
        run.acceptedRootIds,
        run.rootOutcomes,
        { accepted: run.eligibleRoots, capacityRejected: 0, typedStressRejected: 0 },
        run.planCounts,
        run.journeyCounts,
        run.startedAtUtc,
        run.completedAtUtc,
        derivedJourneyOutcomes,
        findings,
      );
      if (challenge.requiredJourneys.some((journey) => run.journeyCounts[journey] < 1)) {
        findings.push(
          finding(
            "rareJourneyCoverageMissing",
            `${subject} omits a required rare journey`,
            subject,
            "MISSING",
          ),
        );
      }
      const derivedChallengeGoodRoots = run.rootOutcomes.filter((outcome) => {
        const requirement = manifest.journeyMix.find((entry) => entry.journey === outcome.journey);
        return (
          requirement !== undefined &&
          outcome.assertions.length > 0 &&
          outcome.assertions.every((assertion) => assertion.passed) &&
          Date.parse(outcome.evaluatedAtUtc) - Date.parse(outcome.acceptedAtUtc) <=
            requirement.deadlineMs
        );
      }).length;
      if (
        !faultEvidencePasses ||
        !run.passed ||
        run.goodRootOutcomes !== run.eligibleRoots ||
        run.goodRootOutcomes !== derivedChallengeGoodRoots
      ) {
        findings.push(
          finding(
            "challengeOutcomeFloorMissed",
            `${subject} achieved ${run.goodRootOutcomes}/${run.eligibleRoots} Good Root Outcomes`,
            subject,
            "FAIL",
          ),
        );
      }
      allAcceptedRootIds.push(...run.acceptedRootIds);
    }
  }
  for (const region of manifest.regions) {
    const isolated = evidence.challengeRuns.filter((run) =>
      manifest.challengeLanes.some(
        (laneValue) =>
          laneValue.mode === "isolated" &&
          laneValue.kind === run.challenge &&
          run.region === region,
      ),
    );
    const cascade = evidence.challengeRuns.find(
      (run) => run.challenge === "combinedTargetCascade" && run.region === region,
    );
    if (
      cascade !== undefined &&
      isolated.some(
        (run) =>
          !run.passed ||
          run.sequence >= cascade.sequence ||
          Date.parse(run.completedAtUtc) > Date.parse(cascade.startedAtUtc),
      )
    ) {
      findings.push(
        finding(
          "combinedCascadeStartedEarly",
          `combinedTargetCascade:${region} did not start after every isolated Challenge Lane passed`,
          `combinedTargetCascade:${region}`,
          "FAIL",
        ),
      );
    }
  }

  for (const requirement of manifest.journeyMix) {
    const outcomes = evidence.journeyOutcomes.filter(
      (candidate) => candidate.journey === requirement.journey,
    );
    if (outcomes.length > 1)
      findings.push(
        finding(
          "duplicateJourneyOutcome",
          `${requirement.journey} has ${outcomes.length} outcome records`,
          requirement.journey,
          "FAIL",
        ),
      );
    const outcome = outcomes[0];
    const derived = derivedJourneyOutcomes.get(requirement.journey) ?? {
      eligibleRoots: 0,
      goodRootOutcomes: 0,
      milestoneEligibleRoots: 0,
      timelyMilestoneOutcomes: 0,
    };
    if (outcome === undefined || outcome.eligibleRoots < 1) {
      findings.push(
        finding(
          "journeyOutcomeMissing",
          `${requirement.journey} has no closed evaluation-window evidence`,
          requirement.journey,
          "MISSING",
        ),
      );
    } else if (
      outcome.eligibleRoots !== derived.eligibleRoots ||
      outcome.goodRootOutcomes !== derived.goodRootOutcomes ||
      outcome.milestoneEligibleRoots !== derived.milestoneEligibleRoots ||
      outcome.timelyMilestoneOutcomes !== derived.timelyMilestoneOutcomes
    ) {
      findings.push(
        finding(
          "journeyOutcomeAggregateConflict",
          `${requirement.journey} aggregate does not match its complete root outcome corpus`,
          requirement.journey,
          "FAIL",
        ),
      );
    } else if (
      !Number.isInteger(outcome.eligibleRoots) ||
      !Number.isInteger(outcome.goodRootOutcomes) ||
      outcome.goodRootOutcomes < 0 ||
      outcome.goodRootOutcomes > outcome.eligibleRoots ||
      outcome.deadlineMs !== requirement.deadlineMs ||
      outcome.milestoneDeadlineMs !== requirement.milestoneDeadlineMs ||
      !Number.isInteger(outcome.milestoneEligibleRoots) ||
      !Number.isInteger(outcome.timelyMilestoneOutcomes) ||
      outcome.milestoneEligibleRoots < 0 ||
      outcome.timelyMilestoneOutcomes < 0 ||
      outcome.timelyMilestoneOutcomes > outcome.milestoneEligibleRoots
    ) {
      findings.push(
        finding(
          "journeyOutcomeInvalid",
          `${requirement.journey} has invalid counts or deadline evidence`,
          requirement.journey,
          "FAIL",
        ),
      );
    } else if (outcome.goodRootOutcomes / outcome.eligibleRoots < requirement.outcomeFloor) {
      findings.push(
        finding(
          "goodRootOutcomeFloorMissed",
          `${requirement.journey} achieved ${outcome.goodRootOutcomes}/${outcome.eligibleRoots} by ${outcome.deadlineMs}ms`,
          requirement.journey,
          "FAIL",
        ),
      );
    } else if (
      requirement.milestoneDeadlineMs !== null &&
      outcome.milestoneEligibleRoots > 0 &&
      outcome.timelyMilestoneOutcomes / outcome.milestoneEligibleRoots < requirement.outcomeFloor
    ) {
      findings.push(
        finding(
          "journeyMilestoneFloorMissed",
          `${requirement.journey} achieved ${outcome.timelyMilestoneOutcomes}/${outcome.milestoneEligibleRoots} milestones by ${requirement.milestoneDeadlineMs}ms`,
          requirement.journey,
          "FAIL",
        ),
      );
    }
  }

  if (new Set(allAcceptedRootIds).size !== allAcceptedRootIds.length) {
    findings.push(
      finding(
        "acceptedRootReusedAcrossRuns",
        "An accepted root identity appears in more than one workload or Challenge Lane",
        "acceptedRoots",
        "FAIL",
      ),
    );
  }

  findings.push(...assessPublicPromotionEvidence(manifest, evidence));
  for (const violation of evidence.correctnessViolations) {
    findings.push(
      finding(
        "correctnessViolation",
        `${violation.code} affected ${violation.rootId}`,
        violation.rootId,
        "FAIL",
      ),
    );
  }
  if (evidence.teardownInventory.length > 0) {
    findings.push(
      finding(
        "teardownIncomplete",
        `${evidence.teardownInventory.length} qualification resources remain`,
        "teardown",
        "FAIL",
      ),
    );
  }
  return assessmentFromFindings(findings);
};

/** Return the exact accepted identities that require unsampled semantic traces. */
export const acceptedRootIdsForRuns = (
  evidence: QualificationRunEvidence,
): ReadonlyArray<string> => [
  ...evidence.laneRuns.flatMap((run) => run.acceptedRootIds),
  ...evidence.challengeRuns.flatMap((run) => run.acceptedRootIds),
];

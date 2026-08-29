import {
  costCategoryAuthorities,
  requiredCostCategories,
  requiredPriceUnits,
} from "../../src/qualification/cost-evidence";
import { qualificationChecksum } from "../../src/qualification/qualification-checksum";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
  intendedArrivalCount,
  type ChallengeLane,
  type FaultInjection,
  type ProductionQualificationManifest,
  type ReferenceJourney,
  type WorkloadLane,
} from "../../src/qualification/qualification-manifest";
import {
  acceptedRootIdsForRuns,
  requiredContinuedBetaSplits,
  type ActualArrivalRecord,
  type ArrivalDisposition,
  type EvidenceArtifact,
  type JourneyCounts,
  type PlanCounts,
  type QualificationRunEvidence,
  type RootOutcomeRecord,
} from "../../src/qualification/qualification-runs";
import {
  qualificationRunArrivals,
  type QualificationExecutionPlan,
} from "../../src/qualification/execution";
import {
  qualificationExecutionEvidence,
  qualificationRunExecutionReceipt,
  type ProductionQualificationEvidence,
} from "../../src/qualification/production-qualification";
import type {
  ProductAuthorityExport,
  ProductStageBoundary,
  ProductStageOccurrence,
  SemanticComponent,
  SemanticEvidenceInput,
} from "../../src/qualification/semantic-evidence";
import { generateOpenArrivals } from "../../src/qualification/workload-generation";
import {
  isMeasuredStageLane,
  stageAuthorityComponents,
  stageApplicableJourneys,
  stageObjectives,
  type StageMeasurement,
} from "../../src/qualification/stage-evidence";
import { completeMemorySemanticEvidence } from "./memory-semantic-fixture";

/** Exact deployable versions shared by qualification fixtures. */
export const manifestVersions = {
  dependencyVersions: {
    agents: "0.20.1",
    cloudflareThink: "0.15.1",
    effect: "4.0.0-rc.111",
  },
  hardLimits: [{ maximum: 1_000, name: "sqlQueries", unit: "queries" }],
  sourceVersion: "45e5d17",
  topologyVersion: "cloudflare-v1",
  workloadSeed: 17,
} as const;

const componentAuthorityNames = {
  AgentActivation: "osfo_agent_activation_log",
  AgentSQLite: "osfo_committed_turns",
  Gmail: "gmail_provider_receipts",
  Memory: "memory_commit_receipts",
  ModelAccess: "model_access_receipts",
  PostgreSQL: "allowance_and_billing_ledger",
  Provider: "provider_delivery_receipts",
  R2: "r2_object_metadata",
  TaskCompute: "task_compute_receipts",
  Think: "think_submission_receipts",
  WhatsApp: "whatsapp_delivery_receipts",
  Worker: "worker_admission_receipts",
  Workflow: "workflow_instance_receipts",
} as const satisfies Readonly<Record<SemanticComponent, ProductAuthorityExport["authority"]>>;

const stageBoundaryOwners = {
  deliveryAttemptStarted: "Provider",
  durableAcceptanceCommitted: "Worker",
  followUpAccepted: "WhatsApp",
  meaningfulUpdateCommitted: "Worker",
  messageObserved: "AgentActivation",
  protectedSendStarted: "Gmail",
  scheduledEmailDue: "Workflow",
  scheduledEmailOutcomeCommitted: "Gmail",
  scheduledTaskDue: "Workflow",
  scheduledTaskHandlerStarted: "TaskCompute",
  scheduledTaskSubmissionAccepted: "TaskCompute",
  workflowMilestoneCommitted: "Workflow",
  workflowOutcomeCommitted: "Workflow",
  workflowStarted: "Workflow",
  workflowWakeDue: "Workflow",
} as const satisfies Readonly<Record<ProductStageBoundary, SemanticComponent>>;

const stageOccurrencesFor = (
  journey: ReferenceJourney,
  rootId: string,
  occurredAt: string,
): ReadonlyArray<ProductStageOccurrence> => {
  const boundaries = new Set<ProductStageBoundary>();
  for (const objective of stageObjectives) {
    const journeys = stageApplicableJourneys(objective.stage);
    if (journeys !== null && !journeys.includes(journey)) continue;
    const pair = stageAuthorityComponents(objective.stage);
    boundaries.add(pair.start);
    boundaries.add(pair.end);
  }
  return [...boundaries].map((boundary) => ({
    boundary,
    occurredAt,
    productFactId: `stage-${boundary}-${rootId}`,
  }));
};

const authorityRecord = (
  component: SemanticComponent,
  rootId: string,
  profile: {
    readonly cause: "deployment" | "faultRecovery" | "firstUse" | "idleEviction" | "warm";
    readonly classification: "cold" | "warm";
    readonly journey: ReferenceJourney;
    readonly occurredAt: string;
    readonly region: "americas" | "asiaPacific" | "europe";
  },
): ProductAuthorityExport["records"][number] | null => {
  const occurredAt = profile.occurredAt;
  const productFactId =
    component === "Provider" ? `outcome-${rootId}` : `signal-${component}-${rootId}`;
  const base = {
    effectReceipts:
      component === "Provider"
        ? [{ effectId: `provider-effect-${rootId}`, kind: "providerEffects" as const }]
        : component === "Think"
          ? [{ effectId: `think-submission-${rootId}`, kind: "thinkSubmissions" as const }]
          : component === "Workflow"
            ? [{ effectId: `workflow-start-${rootId}`, kind: "workflowStarts" as const }]
            : [],
    occurredAt,
    productFactId,
    rootId,
    stageOccurrences: stageOccurrencesFor(profile.journey, rootId, occurredAt).filter(
      (occurrence) => stageBoundaryOwners[occurrence.boundary] === component,
    ),
    usageFacts: requiredCostCategories.flatMap((category) =>
      costCategoryAuthorities[category] === component
        ? [
            {
              category,
              provider: componentAuthorityNames[component],
              quantity: 1n,
              unit: requiredPriceUnits[category],
              usageId: `usage-${rootId}-${category}`,
            },
          ]
        : [],
    ),
  };
  switch (component) {
    case "AgentActivation":
      return {
        ...base,
        activationId: `activation-${rootId}`,
        cause: profile.cause,
        classification: profile.classification,
        region: profile.region,
      };
    case "Worker":
      return {
        ...base,
        acceptanceReceiptId: `receipt-${rootId}`,
        admissionDecision: "accepted",
        userMessageId: rootId,
        userUpdateId: `update-${rootId}`,
      };
    case "Think":
      return {
        ...base,
        acceptanceReceiptId: `receipt-${rootId}`,
        submissionStatus: "accepted",
        thinkSubmissionId: `submission-${rootId}`,
      };
    case "WhatsApp":
      return {
        ...base,
        deliveryId: `delivery-${rootId}`,
        outcomeId: `outcome-${rootId}`,
        providerMessageId: `provider-message-${rootId}`,
        deliveryStatus: "succeeded",
        userMessageId: rootId,
        userUpdateId: `update-${rootId}`,
      };
    case "Provider":
      return {
        ...base,
        deliveryId: `delivery-${rootId}`,
        outcomeId: `outcome-${rootId}`,
        providerStatus: "succeeded",
      };
    case "Gmail":
      return {
        ...base,
        deliveryId: `delivery-${rootId}`,
        gmailMessageId: `gmail-${rootId}`,
        outcomeId: `outcome-${rootId}`,
        deliveryStatus: "succeeded",
      };
    case "Workflow":
      return {
        ...base,
        outcomeId: `outcome-${rootId}`,
        scheduledTaskId: `scheduled-task-${rootId}`,
        workflowId: `workflow-${rootId}`,
        workflowStatus: "completed",
      };
    case "ModelAccess":
      return {
        ...base,
        costReconciliationId: `cost-${rootId}`,
        modelRequestId: `model-${rootId}`,
        outcomeId: `outcome-${rootId}`,
        priceBookId: "price-book-v1",
        requestStatus: "completed",
      };
    case "Memory":
      return {
        ...base,
        memoryCommitId: `memory-${rootId}`,
        outcomeId: `outcome-${rootId}`,
        commitStatus: "committed",
        userMessageId: rootId,
      };
    case "TaskCompute":
      return {
        ...base,
        outcomeId: `outcome-${rootId}`,
        scheduledTaskId: `scheduled-task-${rootId}`,
        taskExecutionId: `task-execution-${rootId}`,
        executionStatus: "completed",
      };
    case "AgentSQLite":
    case "PostgreSQL":
    case "R2":
      return null;
  }
  return null;
};

const referenceJourneys: ReadonlyArray<ReferenceJourney> = [
  "registration",
  "ordinaryConversation",
  "fileAnalysis",
  "reminder",
  "gmail",
  "researchReport",
  "documentBuild",
  "scheduledEmail",
  "accountBillingSafetyDataRights",
];

const compactLane = (lane: WorkloadLane): WorkloadLane => ({
  ...lane,
  windows: lane.windows.map((window) =>
    window.kind === "offer" || window.kind === "fault"
      ? { ...window, durationSeconds: 1, endRatePerSecond: 100, startRatePerSecond: 100 }
      : window,
  ),
});

/** Build a short-duration manifest that preserves the full production contract. */
export const compactManifest = (): ProductionQualificationManifest => {
  const manifest = createBoundedBetaManifest(manifestVersions);
  const { manifestChecksum: _checksum, ...content } = manifest;
  const compact = { ...content, lanes: manifest.lanes.map(compactLane) };
  return { ...compact, manifestChecksum: qualificationChecksum(compact) };
};

/** Build a short-duration public manifest with all regional and growth contracts. */
export const compactPublicManifest = (): ProductionQualificationManifest => {
  const manifest = createScaleQualifiedPublicManifest(manifestVersions);
  const { manifestChecksum: _checksum, ...content } = manifest;
  const compact = { ...content, lanes: manifest.lanes.map(compactLane) };
  return { ...compact, manifestChecksum: qualificationChecksum(compact) };
};

const artifact = <RecordValue>(
  subject: string,
  records: ReadonlyArray<RecordValue>,
  windowStartedAtUtc = "2026-08-17T12:00:00.000Z",
  windowEndedAtUtc = "2026-08-17T12:01:00.000Z",
): EvidenceArtifact<RecordValue> => ({
  artifactId: `artifact-${subject}`,
  checksum: qualificationChecksum(records),
  count: records.length,
  records,
  windowEndedAtUtc,
  windowStartedAtUtc,
});

const minimumChallengeRoots = (
  manifest: ProductionQualificationManifest,
  challenge: ChallengeLane,
): number => {
  if (challenge.minimumEligibleRoots !== "targetWindow") return challenge.minimumEligibleRoots;
  const target = manifest.lanes.find((lane) => lane.kind === "target");
  return target === undefined ? 0 : intendedArrivalCount(target);
};

const referenceJourneyCounts = (total: number): JourneyCounts => ({
  accountBillingSafetyDataRights: (total * 5) / 100,
  documentBuild: (total * 2) / 100,
  fileAnalysis: (total * 8) / 100,
  gmail: (total * 4) / 100,
  ordinaryConversation: (total * 67) / 100,
  registration: (total * 5) / 100,
  reminder: (total * 5) / 100,
  researchReport: (total * 3) / 100,
  scheduledEmail: (total * 1) / 100,
});

const ordinaryJourneyCounts = (total: number): JourneyCounts => ({
  accountBillingSafetyDataRights: 0,
  documentBuild: 0,
  fileAnalysis: 0,
  gmail: 0,
  ordinaryConversation: total,
  registration: 0,
  reminder: 0,
  researchReport: 0,
  scheduledEmail: 0,
});

const referencePlanCounts = (total: number): PlanCounts => ({
  adventurer: total / 10,
  free: (total * 9) / 10,
});

interface ChallengePopulations {
  readonly journeyCounts: JourneyCounts;
  readonly planCounts: PlanCounts;
}

const challengePopulations = (challenge: ChallengeLane, total: number): ChallengePopulations => {
  if (challenge.planPolicy === "referenceMix") {
    return {
      journeyCounts: referenceJourneyCounts(total),
      planCounts: referencePlanCounts(total),
    };
  }
  const journeyCounts = { ...ordinaryJourneyCounts(total) };
  if (challenge.kind === "rareJourney") {
    for (const journey of challenge.requiredJourneys) {
      journeyCounts[journey] = 1;
      journeyCounts.ordinaryConversation -= 1;
    }
  }
  return {
    journeyCounts,
    planCounts:
      challenge.planPolicy === "allAdventurer"
        ? { adventurer: total, free: 0 }
        : { adventurer: 0, free: total },
  };
};

const dispositionsFor = (
  arrivals: ReadonlyArray<ActualArrivalRecord>,
): ReadonlyArray<ArrivalDisposition> =>
  arrivals.map((arrival) => ({
    authorityFactId: `signal-Worker-${arrival.rootId}`,
    disposition: "accepted",
    resolvedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(arrival.observedAtEpochMs + 1)),
    rootId: arrival.rootId,
  }));

const outcomesFor = (
  manifest: ProductionQualificationManifest,
  arrivals: ReadonlyArray<ActualArrivalRecord>,
): ReadonlyArray<RootOutcomeRecord> =>
  arrivals.map((arrival) => {
    const requirement = manifest.journeyMix.find(
      (candidate) => candidate.journey === arrival.journey,
    );
    const acceptedAtEpochMs = arrival.observedAtEpochMs + 1;
    const milestoneDeadlineMs = requirement?.milestoneDeadlineMs ?? null;
    const outcomeId = `outcome-${arrival.rootId}`;
    const productFactIdFor = (component: SemanticComponent): string =>
      component === "AgentSQLite"
        ? `assistant-${arrival.rootId}`
        : component === "PostgreSQL"
          ? `allowance-${arrival.rootId}`
          : component === "R2"
            ? `r2-${arrival.rootId}`
            : component === "Provider"
              ? outcomeId
              : `signal-${component}-${arrival.rootId}`;
    const assertionFor = (assertion: string, occurredAtUtc: string) => {
      const productFactId = outcomeId;
      const passed = true;
      const authorityFactIds = requirement?.assertionAuthorities.map(productFactIdFor) ?? [
        productFactId,
      ];
      return {
        assertion,
        authorityFactIds,
        occurredAtUtc,
        passed,
        productFactChecksum: qualificationChecksum({
          assertion,
          authorityFactIds,
          occurredAtUtc,
          passed,
          productFactId,
          rootId: arrival.rootId,
        }),
        productFactId,
      };
    };
    const evaluatedAtUtc = DateTime.formatIso(
      DateTime.makeUnsafe(acceptedAtEpochMs + (requirement?.deadlineMs ?? 1) - 1),
    );
    const milestoneEvaluatedAtUtc =
      milestoneDeadlineMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(acceptedAtEpochMs + milestoneDeadlineMs - 1));
    return {
      acceptedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(acceptedAtEpochMs)),
      assertionVersion: requirement?.assertionVersion ?? "good-root-outcome-v1",
      assertions:
        requirement?.assertions.map((assertion) => assertionFor(assertion, evaluatedAtUtc)) ?? [],
      evaluatedAtUtc,
      journey: arrival.journey,
      milestoneAssertions:
        milestoneEvaluatedAtUtc === null
          ? []
          : (requirement?.milestoneAssertions.map((assertion) =>
              assertionFor(assertion, milestoneEvaluatedAtUtc),
            ) ?? []),
      milestoneEvaluatedAtUtc,
      outcomeId,
      rootId: arrival.rootId,
    };
  });

const faultControllerReceipt = (
  manifest: ProductionQualificationManifest,
  executionPlanChecksum: string,
  executionId: string,
  runId: string,
  injectedAtUtc: string,
  fault: FaultInjection | null,
  triggerAuthorityFactId: string | null = null,
  triggerObservedAtUtc = injectedAtUtc,
) => {
  if (fault === null) return null;
  const content = {
    applicationStatus: "applied" as const,
    artifactId: `fault-controller-${runId}`,
    controllerOperationId: `fault-operation-${runId}`,
    controllerSource: "qualification-fault-controller",
    durationSeconds: fault.durationSeconds,
    endedAtUtc: DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(triggerObservedAtUtc) + fault.durationSeconds * 1_000),
    ),
    executionId,
    injectedAtUtc: triggerObservedAtUtc,
    kind: fault.kind,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: executionPlanChecksum,
    runId,
    scheduledTriggerAtUtc: injectedAtUtc,
    target: fault.target,
    trigger: fault.trigger,
    triggerAuthorityFactId,
    triggerObservedAtUtc,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

/** Build complete root-bound workload, challenge, and promotion evidence. */
export const completeRunEvidence = (
  manifest: ProductionQualificationManifest,
  executionPlanChecksum = qualificationChecksum({
    fixturePlanForManifest: manifest.manifestChecksum,
  }),
  executionPlan?: QualificationExecutionPlan,
): QualificationRunEvidence => {
  const laneRuns = manifest.lanes.flatMap((lane, laneIndex) =>
    manifest.regions.flatMap((region, regionIndex) =>
      Array.from({ length: lane.repetitions }, (_, repetitionIndex) => {
        const repetition = repetitionIndex + 1;
        const count = intendedArrivalCount(lane);
        const subject = `${lane.kind}-${region}-${repetition}`;
        const journeyCounts = referenceJourneyCounts(count);
        const planCounts = referencePlanCounts(count);
        const executionRun = executionPlan?.runs.find(
          (run) =>
            run.kind === "lane" &&
            run.lane === lane.kind &&
            run.region === region &&
            run.repetition === repetition,
        );
        const seed =
          executionRun?.seed ??
          manifest.workloadSeed + laneIndex * 100 + regionIndex * 10_000 + repetition;
        const identityPrefix = executionRun?.runId ?? `${subject}-root`;
        let nextWindowStart =
          Date.parse("2026-08-17T12:00:00.000Z") +
          laneIndex * 86_400_000 +
          regionIndex * 10_000_000 +
          repetition * 100_000;
        const windows = lane.windows.map((window, index) => {
          const executionWindow = executionRun?.windows[index];
          if (executionWindow !== undefined) {
            return {
              endedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(executionWindow.endsAtEpochMs)),
              index,
              kind: window.kind,
              startedAtUtc: DateTime.formatIso(
                DateTime.makeUnsafe(executionWindow.startsAtEpochMs),
              ),
            };
          }
          const startedAtUtc = DateTime.formatIso(DateTime.makeUnsafe(nextWindowStart));
          nextWindowStart += window.durationSeconds * 1_000;
          return {
            endedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(nextWindowStart)),
            index,
            kind: window.kind,
            startedAtUtc,
          };
        });
        const intendedArrivals =
          executionRun === undefined
            ? lane.windows.flatMap((window, index) =>
                window.kind === "offer" || window.kind === "fault"
                  ? generateOpenArrivals({
                      identityPrefix,
                      journeyMix: manifest.journeyMix,
                      planMixBasisPoints: manifest.planMixBasisPoints,
                      seed,
                      startsAtEpochMs: Date.parse(windows[index]?.startedAtUtc ?? ""),
                      window,
                    })
                  : [],
              )
            : Array.from(qualificationRunArrivals(manifest, executionRun)).flatMap((arrival) =>
                "journey" in arrival ? [arrival] : [],
              );
        const actualArrivals: ReadonlyArray<ActualArrivalRecord> = intendedArrivals.map(
          (arrival) => ({ ...arrival, observedAtEpochMs: arrival.offeredAtEpochMs }),
        );
        const startedAtUtc = windows[0]?.startedAtUtc ?? "";
        const endedAtUtc = windows.at(-1)?.endedAtUtc ?? "";
        const intendedArrivalArtifact = artifact(
          `${subject}-intended`,
          intendedArrivals,
          startedAtUtc,
          endedAtUtc,
        );
        const laneFault =
          lane.kind === "allCold"
            ? (manifest.faults.find(({ kind }) => kind === "coldActivation") ?? null)
            : lane.kind === "dependencyOutageRecovery"
              ? (manifest.faults.find(({ kind }) => kind === "dependencyOutage") ?? null)
              : null;
        return {
          acceptedRootIds: intendedArrivals.map((arrival) => arrival.rootId),
          actualArrivals: artifact(`${subject}-actual`, actualArrivals, startedAtUtc, endedAtUtc),
          clean: true,
          dispositions: dispositionsFor(actualArrivals),
          faultControllerReceipt: faultControllerReceipt(
            manifest,
            executionPlanChecksum,
            "qualification-execution-fixture",
            intendedArrivalArtifact.artifactId,
            startedAtUtc,
            laneFault,
          ),
          identityPrefix,
          intendedArrivals: intendedArrivalArtifact,
          journeyCounts,
          lane: lane.kind,
          planCounts,
          region,
          repetition,
          resolutions: { accepted: count, capacityRejected: 0, typedStressRejected: 0 },
          rootOutcomes: outcomesFor(manifest, actualArrivals),
          seed,
          windows,
        };
      }),
    ),
  );
  const challengeRuns = manifest.challengeLanes.flatMap((challenge, challengeIndex) =>
    manifest.regions.map((region) => {
      const subject = `${challenge.kind}-${region}`;
      const executionRun = executionPlan?.runs.find(
        (run) =>
          run.kind === "challenge" && run.challenge === challenge.kind && run.region === region,
      );
      const count = executionRun?.arrivalCount ?? minimumChallengeRoots(manifest, challenge);
      const isCombined = challenge.mode === "combined";
      const targetOffer = manifest.lanes
        .find((lane) => lane.kind === "target")
        ?.windows.find((window) => window.kind === "offer" || window.kind === "fault");
      const offeredRatePerSecond =
        challenge.offeredRatePerSecond === "targetRate"
          ? (targetOffer?.startRatePerSecond ?? 0)
          : challenge.offeredRatePerSecond;
      const seed =
        manifest.workloadSeed + challenge.seedOffset + Array.from(manifest.regions).indexOf(region);
      const identityPrefix = executionRun?.runId ?? `${subject}-root`;
      const populations = challengePopulations(challenge, count);
      const generatedRootIds = Array.from(
        { length: count },
        (_, index) => `${identityPrefix}-${index}`,
      );
      const journeys = referenceJourneys.flatMap((journey) =>
        Array.from({ length: populations.journeyCounts[journey] }, () => journey),
      );
      const plans = [
        ...Array.from({ length: populations.planCounts.free }, () => "free" as const),
        ...Array.from({ length: populations.planCounts.adventurer }, () => "adventurer" as const),
      ];
      const intendedArrivals =
        executionRun === undefined
          ? generatedRootIds.map((rootId, index) => ({
              journey: journeys[index] ?? "ordinaryConversation",
              offeredAtEpochMs:
                Date.parse(isCombined ? "2026-08-17T14:00:00.000Z" : "2026-08-17T12:00:00.000Z") +
                Math.floor((index * 1_000) / offeredRatePerSecond),
              plan: plans[index] ?? "free",
              rootId,
            }))
          : Array.from(qualificationRunArrivals(manifest, executionRun)).flatMap((arrival) =>
              "journey" in arrival ? [arrival] : [],
            );
      const acceptedRootIds = intendedArrivals.map(({ rootId }) => rootId);
      const actualArrivals = intendedArrivals.map((arrival) => ({
        ...arrival,
        observedAtEpochMs: arrival.offeredAtEpochMs,
      }));
      const windowStartedAtUtc =
        executionRun === undefined
          ? isCombined
            ? "2026-08-17T14:00:00.000Z"
            : "2026-08-17T12:00:00.000Z"
          : DateTime.formatIso(DateTime.makeUnsafe(executionRun.startsAtEpochMs));
      const windowEndedAtUtc =
        executionRun === undefined
          ? isCombined
            ? "2026-08-17T15:00:00.000Z"
            : "2026-08-17T13:00:00.000Z"
          : DateTime.formatIso(DateTime.makeUnsafe(executionRun.endsAtEpochMs));
      const actualArrivalArtifact = artifact(
        `${subject}-actual`,
        actualArrivals,
        windowStartedAtUtc,
        windowEndedAtUtc,
      );
      const identitySet = artifact(subject, acceptedRootIds, windowStartedAtUtc, windowEndedAtUtc);
      const intendedArrivalArtifact = artifact(
        `${subject}-intended`,
        intendedArrivals,
        windowStartedAtUtc,
        windowEndedAtUtc,
      );
      const faultInjection = manifest.faults.find((fault) => fault.kind === challenge.kind) ?? null;
      const triggerRootId = acceptedRootIds[0];
      const retainedFaultReceipt = faultControllerReceipt(
        manifest,
        executionPlanChecksum,
        "qualification-execution-fixture",
        identitySet.artifactId,
        windowStartedAtUtc,
        faultInjection,
        faultInjection !== null &&
          !["beforeOffer", "sharedDueTime", "startOfFaultWindow", "startOfOfferWindow"].includes(
            faultInjection.trigger,
          )
          ? triggerRootId === undefined
            ? null
            : `signal-Worker-${triggerRootId}`
          : null,
        faultInjection !== null &&
          !["beforeOffer", "sharedDueTime", "startOfFaultWindow", "startOfOfferWindow"].includes(
            faultInjection.trigger,
          )
          ? (dispositionsFor(actualArrivals)[0]?.resolvedAtUtc ?? windowStartedAtUtc)
          : windowStartedAtUtc,
      );
      const faultObservations =
        faultInjection === null
          ? []
          : [
              {
                authorityFactIds: [`fault-target-state-${subject}`],
                arrivalChecksum: actualArrivalArtifact.checksum,
                identityChecksum: identitySet.checksum,
                injectedAtUtc: retainedFaultReceipt?.injectedAtUtc ?? windowStartedAtUtc,
                invariant: faultInjection.expectedInvariant,
                invariantHeld: true,
                observationId: `fault-observation-${subject}`,
                observedAtUtc: DateTime.formatIso(
                  DateTime.makeUnsafe(Date.parse(windowStartedAtUtc) + 1_000),
                ),
                observedState: "invariantHeld" as const,
                runId: identitySet.artifactId,
                target: faultInjection.target,
                trigger: faultInjection.trigger,
              },
            ];
      return {
        acceptedRootIds,
        actualArrivals: actualArrivalArtifact,
        challenge: challenge.kind,
        completedAtUtc: windowEndedAtUtc,
        eligibleRoots: count,
        dispositions: dispositionsFor(actualArrivals),
        faultControllerReceipt: retainedFaultReceipt,
        faultInjection,
        faultObservations: artifact(`${subject}-fault`, faultObservations),
        goodRootOutcomes: count,
        identitySet,
        identityPrefix,
        intendedArrivals: intendedArrivalArtifact,
        journeyCounts: populations.journeyCounts,
        passed: true,
        planCounts: populations.planCounts,
        region,
        rootOutcomes: outcomesFor(manifest, actualArrivals),
        seed,
        sequence: challengeIndex + 1,
        startedAtUtc: windowStartedAtUtc,
      };
    }),
  );
  const allRootOutcomes = [
    ...laneRuns.flatMap((run) => run.rootOutcomes),
    ...challengeRuns.flatMap((run) => run.rootOutcomes),
  ];
  const dailyBetaRecords = Array.from({ length: 28 }, (_day, index) => {
    const acceptedRegisteredMessages = index < 24 ? 893 : 892;
    const acceptedRootIds = Array.from(
      { length: acceptedRegisteredMessages },
      (_, rootIndex) => `beta-day-${index}-root-${rootIndex}`,
    );
    const authorityArtifactId = `beta-day-${index}-product-authority`;
    return {
      acceptedRegisteredMessages,
      acceptedRootIds,
      authorityArtifactChecksum: qualificationChecksum({
        acceptedRootIds,
        artifactId: authorityArtifactId,
        goodRootIds: acceptedRootIds,
        sourceVersion: manifest.sourceVersion,
      }),
      authorityArtifactId,
      correctnessViolations: [],
      dayStartedAtUtc: DateTime.formatIso(
        DateTime.makeUnsafe(Date.parse("2026-07-20T00:00:00.000Z") + index * 86_400_000),
      ),
      errorBudgetRemaining: 1,
      goodRootOutcomes: acceptedRegisteredMessages,
      goodRootIds: acceptedRootIds,
      rollingSevenDayRatio: 1,
      sourceVersion: manifest.sourceVersion,
    };
  });
  const burnWindows = (["1h", "6h", "3d", "28d"] as const).map((window) => ({
    artifactId: `burn-${window}`,
    badRoots: 0,
    eligibleRoots: 1_000,
    errorBudgetFraction: 0.01,
    maximumBurnRate: 1,
    measuredBurnRate: 0,
    verdict: "PASS" as const,
    window,
  }));
  const dailyEvidence = artifact(
    "continued-beta-daily",
    dailyBetaRecords,
    "2026-07-20T00:00:00.000Z",
    "2026-08-17T00:00:00.000Z",
  );
  const sloSplits = artifact(
    "rolling-slo-7d",
    dailyBetaRecords.flatMap((day) =>
      requiredContinuedBetaSplits(manifest).map((split) => ({
        dayStartedAtUtc: day.dayStartedAtUtc,
        eligibleRootIds: [`${day.dayStartedAtUtc}:${split}:root`],
        eligibleRoots: 1,
        goodRootIds: [`${day.dayStartedAtUtc}:${split}:root`],
        goodRootOutcomes: 1,
        rollingSevenDayRatio: 1,
        sourceArtifactId: `${day.dayStartedAtUtc}:${split}:authority`,
        sourceAuthorityFactIds: [`${day.dayStartedAtUtc}:${split}:fact`],
        sourceVersion: manifest.sourceVersion,
        split,
      })),
    ),
    "2026-07-20T00:00:00.000Z",
    "2026-08-17T00:00:00.000Z",
  );
  const errorBudget28DayArtifactId = "error-budget-28d";
  const corpusSnapshots = [
    {
      artifactId: `corpus-users-${manifest.acceptanceLevel}`,
      count: manifest.corpus.registeredUsers,
      identityDigest: qualificationChecksum({
        corpus: manifest.acceptanceLevel,
        identities: "registered-user-primary-keys",
      }),
      kind: "registeredUsers" as const,
      store: "PostgreSQL" as const,
    },
    {
      artifactId: `corpus-messages-${manifest.acceptanceLevel}`,
      count: manifest.corpus.retainedRegisteredMessages,
      identityDigest: qualificationChecksum({
        corpus: manifest.acceptanceLevel,
        identities: "retained-message-primary-keys",
      }),
      kind: "retainedRegisteredMessages" as const,
      store: "AgentSQLite" as const,
    },
  ].map((snapshot) =>
    Object.assign({}, snapshot, { artifactChecksum: qualificationChecksum(snapshot) }),
  );
  const corpusContent = {
    artifactId: `acceptance-corpus-${manifest.acceptanceLevel}`,
    measuredAtUtc: "2026-08-17T11:59:00.000Z",
    queryVersion: "acceptance-corpus-query-v1",
    registeredUsers: manifest.corpus.registeredUsers,
    retainedRegisteredMessages: manifest.corpus.retainedRegisteredMessages,
    sourceSnapshots: corpusSnapshots,
    sourceVersion: manifest.sourceVersion,
  };
  return {
    characterizationRuns: manifest.characterizationLanes.flatMap((lane) =>
      manifest.regions.map((region) => {
        const executionRun = executionPlan?.runs.find(
          (run) =>
            run.kind === "characterization" &&
            run.characterization === lane.kind &&
            run.region === region,
        );
        const count =
          executionRun?.arrivalCount ?? lane.offeredRatePerSecond * lane.durationSeconds;
        const records =
          executionRun === undefined
            ? Array.from({ length: count }, (_, index) => ({
                offeredAtEpochMs:
                  Date.parse("2026-08-17T12:00:00.000Z") +
                  Math.floor((index * 1_000) / lane.offeredRatePerSecond),
                rootId: `${lane.kind}-${region}-${index}`,
              }))
            : Array.from(qualificationRunArrivals(manifest, executionRun)).map(
                ({ offeredAtEpochMs, rootId }) => ({ offeredAtEpochMs, rootId }),
              );
        return {
          arrivals: artifact(`${lane.kind}-${region}`, records),
          kind: lane.kind,
          region,
        };
      }),
    ),
    challengeRuns,
    corpus: { ...corpusContent, checksum: qualificationChecksum(corpusContent) },
    correctnessViolations: [],
    continuedBeta:
      manifest.acceptanceLevel === "ScaleQualifiedPublic"
        ? {
            acceptedRegisteredMessages: 25_000,
            burnWindows,
            dailyEvidence,
            errorBudget28DayArtifactChecksum: qualificationChecksum({
              artifactId: errorBudget28DayArtifactId,
              burnWindows,
              dailyEvidenceChecksum: dailyEvidence.checksum,
              sloSplitsChecksum: sloSplits.checksum,
            }),
            errorBudget28DayArtifactId,
            observedTraceReplacement: null,
            productionDays: 28,
            rollingSevenDaySloArtifactId: sloSplits.artifactId,
            sloSplits,
          }
        : null,
    dependencyVersions: manifest.dependencyVersions,
    growthCorpusRuns:
      "growthCorpora" in manifest
        ? manifest.growthCorpora.map((corpus) => {
            const sourceSnapshots = [
              {
                artifactId: `${corpus.kind}-growth-users`,
                count: corpus.registeredUsers,
                identityDigest: qualificationChecksum({
                  corpus: corpus.kind,
                  identities: "registered-user-primary-keys",
                }),
                kind: "registeredUsers" as const,
                store: "PostgreSQL" as const,
              },
              {
                artifactId: `${corpus.kind}-growth-messages`,
                count: corpus.retainedRegisteredMessages,
                identityDigest: qualificationChecksum({
                  corpus: corpus.kind,
                  identities: "retained-message-primary-keys",
                }),
                kind: "retainedRegisteredMessages" as const,
                store: "AgentSQLite" as const,
              },
            ].map((source) =>
              Object.assign({}, source, { artifactChecksum: qualificationChecksum(source) }),
            );
            const snapshot = {
              allowancePeriods: corpus.allowancePeriods ?? null,
              measuredAtUtc: "2026-08-17T12:00:00.000Z",
              queryVersion: "growth-corpus-query-v1",
              registeredUsers: corpus.registeredUsers,
              retainedRegisteredMessages: corpus.retainedRegisteredMessages,
              sourceSnapshots,
              sourceVersion: manifest.sourceVersion,
            };
            const corpusArtifact = artifact(`${corpus.kind}-growth-corpus`, [
              {
                ...snapshot,
                sourceSnapshotChecksum: qualificationChecksum({ ...snapshot, kind: corpus.kind }),
              },
            ]);
            const characterizationResultArtifact = artifact(
              `${corpus.kind}-growth-characterization`,
              [
                {
                  correctnessViolations: [],
                  corpusChecksum: corpusArtifact.checksum,
                  failedQueries: 0,
                  maximumQueueDepth: 1,
                  queryP95Ms: 100,
                  successfulQueries: 1_000,
                },
              ],
            );
            return {
              allowancePeriods: corpus.allowancePeriods ?? null,
              characterizationArtifactId: characterizationResultArtifact.artifactId,
              characterizationResultArtifact,
              corpusArtifact,
              corpusChecksum: corpusArtifact.checksum,
              kind: corpus.kind,
              registeredUsers: corpus.registeredUsers,
              retainedRegisteredMessages: corpus.retainedRegisteredMessages,
            };
          })
        : [],
    journeyOutcomes: manifest.journeyMix.map((journey) => {
      const outcomes = allRootOutcomes.filter((outcome) => outcome.journey === journey.journey);
      return {
        deadlineMs: journey.deadlineMs,
        eligibleRoots: outcomes.length,
        goodRootOutcomes: outcomes.length,
        journey: journey.journey,
        milestoneDeadlineMs: journey.milestoneDeadlineMs,
        milestoneEligibleRoots: journey.milestoneDeadlineMs === null ? 0 : outcomes.length,
        timelyMilestoneOutcomes: journey.milestoneDeadlineMs === null ? 0 : outcomes.length,
      };
    }),
    laneRuns,
    manifestChecksum: manifest.manifestChecksum,
    publicPromotion:
      manifest.acceptanceLevel === "ScaleQualifiedPublic"
        ? { acceptedRegisteredMessages: 25_000, consecutiveBetaDays: 28 }
        : null,
    sourceVersion: manifest.sourceVersion,
    teardownInventory: [],
    topologyVersion: manifest.topologyVersion,
    workloadSeed: manifest.workloadSeed,
  };
};

/** Build one authoritative unsampled semantic trace per accepted fixture root. */
export const completeSemanticEvidence = (
  manifest: ProductionQualificationManifest,
  runs: QualificationRunEvidence,
): SemanticEvidenceInput => {
  const acceptedRootIds = acceptedRootIdsForRuns(runs);
  const rootProfiles = new Map<
    string,
    {
      cause: "deployment" | "faultRecovery" | "firstUse" | "idleEviction" | "warm";
      classification: "cold" | "warm";
      journey: ReferenceJourney;
      occurredAt: string;
      plan: "adventurer" | "free";
      region: ProductionQualificationManifest["regions"][number];
    }
  >();
  for (const run of [...runs.laneRuns, ...runs.challengeRuns]) {
    const arrivalsByRoot = new Map(
      run.actualArrivals.records.map((arrival) => [arrival.rootId, arrival] as const),
    );
    run.acceptedRootIds.forEach((rootId, index) => {
      const arrival = arrivalsByRoot.get(rootId);
      const coldCauses = ["firstUse", "idleEviction", "deployment", "faultRecovery"] as const;
      const cause =
        "lane" in run && run.lane === "allCold"
          ? (coldCauses[index % 4] ?? "firstUse")
          : (coldCauses[index] ?? "warm");
      rootProfiles.set(rootId, {
        cause,
        classification: cause === "warm" ? "warm" : "cold",
        journey: arrival?.journey ?? "ordinaryConversation",
        occurredAt: DateTime.formatIso(
          DateTime.makeUnsafe(
            (arrival?.observedAtEpochMs ?? Date.parse("2026-08-17T12:00:00Z")) + 1,
          ),
        ),
        plan: arrival?.plan ?? "free",
        region: run.region,
      });
    });
  }
  return {
    acceptedRootIds,
    localEvidence: acceptedRootIds.flatMap((rootId) => {
      const profile = rootProfiles.get(rootId) ?? {
        cause: "warm" as const,
        classification: "warm" as const,
        journey: "ordinaryConversation" as const,
        occurredAt: "2026-08-17T12:00:00.001Z",
        plan: "free" as const,
        region: "americas" as const,
      };
      return manifest.semanticRequirements[profile.journey].requiredStores.map((store) =>
        store === "AgentSQLite"
          ? {
              acceptanceReceiptId: `receipt-${rootId}`,
              authority: "osfo_committed_turns" as const,
              evidenceId: `agent-sqlite:receipt-${rootId}`,
              occurredAt: profile.occurredAt,
              productFactId: `assistant-${rootId}`,
              rootId,
              store,
              thinkRequestId: `request-${rootId}`,
            }
          : {
              acceptanceReceiptId: `receipt-${rootId}`,
              allowanceConsumptionId: `allowance-${rootId}`,
              authority: "allowance_usage" as const,
              evidenceId: `postgres:allowance-${rootId}`,
              occurredAt: profile.occurredAt,
              productFactId: `allowance-${rootId}`,
              store,
            },
      );
    }),
    productAuthorityExports: (() => {
      const components = new Set(
        acceptedRootIds.flatMap((rootId) => {
          const journey = rootProfiles.get(rootId)?.journey ?? "ordinaryConversation";
          return manifest.semanticRequirements[journey].requiredComponents;
        }),
      );
      components.add("Workflow");
      return [...components].flatMap((component) => {
        const records = acceptedRootIds.flatMap((rootId) => {
          const journey = rootProfiles.get(rootId)?.journey ?? "ordinaryConversation";
          if (
            component !== "Workflow" &&
            !manifest.semanticRequirements[journey].requiredComponents.includes(component)
          )
            return [];
          const profile = rootProfiles.get(rootId) ?? {
            cause: "warm" as const,
            classification: "warm" as const,
            journey: "ordinaryConversation" as const,
            occurredAt: "2026-08-17T12:00:00.001Z",
            region: "americas" as const,
          };
          const record = authorityRecord(component, rootId, profile);
          return record === null ? [] : [record];
        });
        if (records.length === 0) return [];
        const artifactId = `${component}-committed-export`;
        const authority = componentAuthorityNames[component];
        const exportedAtUtc = "2026-08-24T00:00:00.000Z";
        const sourceVersion = manifest.sourceVersion;
        return [
          {
            artifactId,
            authority,
            checksum: qualificationChecksum({
              artifactId,
              authority,
              exportedAtUtc,
              records,
              sourceVersion,
            }),
            exportedAtUtc,
            records,
            sourceVersion,
          },
        ];
      });
    })(),
    r2Evidence: acceptedRootIds.flatMap((rootId) => {
      const profile = rootProfiles.get(rootId);
      return profile !== undefined &&
        manifest.semanticRequirements[profile.journey].requiredComponents.includes("R2")
        ? [
            {
              checksum: qualificationChecksum({ objectId: `r2-${rootId}`, rootId }),
              etag: `etag-${rootId}`,
              objectId: `r2-${rootId}`,
              objectKey: `qualification/${rootId}`,
              rootId,
              uploadedAt: profile.occurredAt,
              version: "r2-version-1",
            },
          ]
        : [];
    }),
    telemetry: [],
    traces: acceptedRootIds.map((rootId) => {
      const profile = rootProfiles.get(rootId) ?? {
        cause: "warm" as const,
        classification: "warm" as const,
        journey: "ordinaryConversation" as const,
        occurredAt: "2026-08-17T12:00:00.001Z",
        plan: "free" as const,
        region: "americas" as const,
      };
      const requirements = manifest.semanticRequirements[profile.journey];
      const signals = [...new Set(requirements.requiredComponents)].map((component) => ({
        component,
        occurredAt: profile.occurredAt,
        signalId:
          component === "AgentSQLite"
            ? `assistant-${rootId}`
            : component === "PostgreSQL"
              ? `allowance-${rootId}`
              : component === "R2"
                ? `r2-${rootId}`
                : component === "Provider"
                  ? `outcome-${rootId}`
                  : `signal-${component}-${rootId}`,
      }));
      const operationSource = signals[0]?.signalId ?? `receipt-${rootId}`;
      return {
        activation: {
          activationId: `activation-${rootId}`,
          cause: profile.cause,
          classification: profile.classification,
          region: profile.region,
        },
        ambiguity: "none" as const,
        amplification: Object.entries(requirements.amplificationLimits).map(([kind]) => ({
          count: 1,
          kind,
        })),
        correlations: {
          acceptanceReceiptId: `receipt-${rootId}`,
          allowanceConsumptionId: `allowance-${rootId}`,
          costReconciliationId: `cost-${rootId}`,
          deliveryId: `delivery-${rootId}`,
          outcomeId: `outcome-${rootId}`,
          priceBookId: "price-book-v1",
          r2ObjectId: requirements.requiredCorrelations.includes("r2ObjectId")
            ? `r2-${rootId}`
            : null,
          scheduledTaskId: requirements.requiredCorrelations.includes("scheduledTaskId")
            ? `scheduled-task-${rootId}`
            : null,
          thinkRequestId: `request-${rootId}`,
          thinkSubmissionId: `submission-${rootId}`,
          userMessageId: rootId,
          userUpdateId: `update-${rootId}`,
          workflowId: requirements.requiredCorrelations.includes("workflowId")
            ? `workflow-${rootId}`
            : null,
        },
        costReconciliationId: `cost-${rootId}`,
        journey: profile.journey,
        operations: (
          [
            "modelStep",
            "tool",
            "search",
            "memory",
            "file",
            "workflowStep",
            "retry",
            "delivery",
            "providerCall",
            "cost",
          ] as const
        ).map((kind) => ({
          kind,
          maximum: 1,
          p50: 1,
          p95: 1,
          p99: 1,
          sampleCount: 1,
          samples: [1],
          sourceProductFactIds: [operationSource],
        })),
        plan: profile.plan,
        resourceUse: [{ name: "cpuTime", quantity: 1, unit: "ms" }],
        retries: [],
        rootId,
        signals,
        stages: requirements.requiredStages.map((stage) => ({
          occurredAt: profile.occurredAt,
          stage,
        })),
        stageOccurrences: stageOccurrencesFor(profile.journey, rootId, profile.occurredAt),
        terminalState: "succeeded" as const,
        traceId: `trace-${rootId}`,
      };
    }),
  };
};

/** Build complete raw stage denominators for every measured run split. */
export const completeStageMeasurements = (
  runs: QualificationRunEvidence,
  semantic?: SemanticEvidenceInput,
): ReadonlyArray<StageMeasurement> =>
  runs.laneRuns.flatMap((run) => {
    const lane = run.lane;
    if (!isMeasuredStageLane(lane)) return [];
    const objectives =
      lane === "allCold"
        ? stageObjectives.filter(({ stage }) => stage === "coldDurableAcceptance")
        : stageObjectives;
    return objectives.flatMap<StageMeasurement>((objective) => {
      const journeysForStage =
        objective.stage === "scheduledEmailOutcome" ||
        objective.stage === "scheduledEmailProtectedSendStart"
          ? (["scheduledEmail"] as const)
          : objective.stage === "scheduledTaskHandlerStart" ||
              objective.stage === "scheduledTaskSubmissionAcceptance" ||
              objective.stage === "workflowOutcomeFollowUpAcceptance" ||
              objective.stage === "workflowStartAcceptance" ||
              objective.stage === "workflowWakeMilestoneCommit"
            ? (["reminder", "scheduledEmail"] as const)
            : null;
      const arrivalsByRoot = new Map(
        run.actualArrivals.records.map((arrival) => [arrival.rootId, arrival] as const),
      );
      const defaultEligibleRootIds =
        journeysForStage === null
          ? run.acceptedRootIds
          : run.acceptedRootIds.filter((rootId) => {
              const journey = arrivalsByRoot.get(rootId)?.journey;
              return (
                journey !== undefined &&
                journeysForStage.some((eligibleJourney) => eligibleJourney === journey)
              );
            });
      const sampleFor = (rootId: string) => {
        const authorities = stageAuthorityComponents(objective.stage);
        const trace = semantic?.traces.find((candidate) => candidate.rootId === rootId);
        const start = trace?.stageOccurrences.find(
          (occurrence) => occurrence.boundary === authorities.start,
        );
        const end = trace?.stageOccurrences.find(
          (occurrence) => occurrence.boundary === authorities.end,
        );
        const startedAtUtc = start?.occurredAt ?? "2026-08-17T12:00:00.000Z";
        const endedAtUtc =
          end?.occurredAt ??
          DateTime.formatIso(
            DateTime.makeUnsafe(Date.parse(startedAtUtc) + objective.maximumLatencyMs),
          );
        return {
          endedAtUtc,
          endProductFactId: end?.productFactId ?? `${authorities.end}-${rootId}`,
          latencyMs: Date.parse(endedAtUtc) - Date.parse(startedAtUtc),
          rootId,
          startedAtUtc,
          startProductFactId: start?.productFactId ?? `${authorities.start}-${rootId}`,
        };
      };
      const samples = defaultEligibleRootIds.map(sampleFor);
      const common = {
        artifactChecksum: qualificationChecksum(samples),
        eligibleRootIds: defaultEligibleRootIds,
        lane,
        region: run.region,
        repetition: run.repetition,
        runArtifactChecksum: run.actualArrivals.checksum,
        samples,
        stage: objective.stage,
      };
      return objective.stage === "coldDurableAcceptance"
        ? (["firstUse", "idleEviction", "deployment", "faultRecovery"] as const).map(
            (coldCause) => {
              const causeIndex = [
                "firstUse",
                "idleEviction",
                "deployment",
                "faultRecovery",
              ].indexOf(coldCause);
              const eligibleRootIds =
                semantic === undefined
                  ? run.acceptedRootIds.slice(causeIndex, causeIndex + 1)
                  : run.acceptedRootIds.filter((rootId) =>
                      semantic.traces.some(
                        (trace) => trace.rootId === rootId && trace.activation.cause === coldCause,
                      ),
                    );
              const coldSamples = eligibleRootIds.map(sampleFor);
              return Object.assign({}, common, {
                artifactChecksum: qualificationChecksum(coldSamples),
                coldCause,
                eligibleRootIds,
                samples: coldSamples,
              });
            },
          )
        : objective.stage === "warmDurableAcceptance"
          ? [
              (() => {
                const eligibleRootIds = run.acceptedRootIds.slice(4);
                const warmSamples = eligibleRootIds.map(sampleFor);
                return Object.assign({}, common, {
                  artifactChecksum: qualificationChecksum(warmSamples),
                  eligibleRootIds,
                  samples: warmSamples,
                });
              })(),
            ]
          : [common];
    });
  });

/** Build a complete fail-closed production qualification evidence bundle. */
export const completeProductionEvidence = (
  executionPlan?: QualificationExecutionPlan,
): ProductionQualificationEvidence => {
  const manifest = compactManifest();
  const fixturePlanChecksum =
    executionPlan?.planChecksum ??
    qualificationChecksum({
      fixture: true,
      manifestChecksum: manifest.manifestChecksum,
    });
  const runs = completeRunEvidence(manifest, fixturePlanChecksum, executionPlan);
  const semantic = completeSemanticEvidence(manifest, runs);
  const priceBookId = "price-book-v1";
  const rootCosts = semantic.traces.map((trace) => ({
    allowancePeriodId: `${trace.plan}-period-1`,
    costReconciliationId: trace.costReconciliationId,
    journey: trace.journey,
    plan: trace.plan,
    priceBookId,
    rootId: trace.rootId,
    usage: requiredCostCategories.flatMap((category) => {
      const signal = trace.signals.find(
        (candidate) => candidate.component === costCategoryAuthorities[category],
      );
      return signal === undefined
        ? []
        : [
            {
              category,
              quantity: 1n,
              sourceProductFactId: signal.signalId,
              unit: requiredPriceUnits[category],
              usdMicros: 1n,
              usageId: `usage-${trace.rootId}-${category}`,
            },
          ];
    }),
  }));
  const priceBook = requiredCostCategories.map((category) => ({
    category,
    priceUsdMicros: 1n,
    unit: requiredPriceUnits[category],
  }));
  const scenarios = (
    ["betaMonth", "publicMonth", "growthWidthMonth", "growthDepthMonth"] as const
  ).map((dimension) => ({
    denominator: 100,
    dimension,
    priceBookId,
    usage: requiredCostCategories.map((category) => ({
      category,
      quantity: 1n,
      sourceProductFactId:
        semantic.traces
          .flatMap((trace) => trace.signals)
          .find((signal) => signal.component === costCategoryAuthorities[category])?.signalId ?? "",
      unit: requiredPriceUnits[category],
      usdMicros: 1n,
      usageId: `scenario-${dimension}-${category}`,
    })),
  }));
  const usageAuthorityRecords = [
    ...rootCosts.flatMap((record) =>
      record.usage.map((line) => ({
        ...line,
        provider: componentAuthorityNames[costCategoryAuthorities[line.category]],
        scope: "root" as const,
        subject: record.rootId,
      })),
    ),
    ...scenarios.flatMap((record) =>
      record.usage.map((line) => ({
        ...line,
        provider: componentAuthorityNames[costCategoryAuthorities[line.category]],
        scope: "scenario" as const,
        subject: record.dimension,
      })),
    ),
  ];
  const usageAuthorityArtifactId = "provider-usage-authority-v1";
  const usageAuthoritySource = "provider-usage-export";
  const usageAuthoritySourceVersion = manifest.sourceVersion;
  const usageAuthorityWindowStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const usageAuthorityWindowEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const billedUsageUsdMicros = rootCosts.reduce(
    (total, record) => total + BigInt(record.usage.length),
    0n,
  );
  const billedUsageLines = rootCosts.flatMap((record) =>
    record.usage.map((line) => ({
      category: line.category,
      provider: componentAuthorityNames[costCategoryAuthorities[line.category]],
      quantity: line.quantity,
      unit: line.unit,
      usageId: line.usageId,
      usdMicros: line.usdMicros,
    })),
  );
  const billedUsageArtifactId = "provider-bill-v1";
  const billedUsageInvoiceId = "invoice-2026-08";
  const billedUsageProvider = "cloud-provider";
  const billingMonthStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const billingMonthEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const priceBookSource = "provider-published-price-book";
  const priceBookVersion = "2026-08-01";
  const pricesObservedAtEpochMs = Date.parse("2026-08-01T12:00:00.000Z");
  const cohortPeriods = [
    { allowancePeriodId: "free-period-1", plan: "free" as const, revenueUsdMicros: 0n },
    {
      allowancePeriodId: "adventurer-period-1",
      plan: "adventurer" as const,
      revenueUsdMicros: 1_000_000n,
    },
  ];
  const economicsArtifactId = "billing-economics-v1";
  const economicsSource = "postgres-billing-export";
  const economicsWindowStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const economicsWindowEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const usageLedgerArtifactId = "cost-ledger-v1";
  const usageLedgerSource = "provider-usage-export";
  const usageLedgerWindowStartedAtUtc = "2026-08-01T00:00:00.000Z";
  const usageLedgerWindowEndedAtUtc = "2026-09-01T00:00:00.000Z";
  const goodRootOutcomeIds = rootCosts.map((record) => record.rootId);
  const fixtureRunReceipt = qualificationRunExecutionReceipt({
    arrivalArtifactChecksum: qualificationChecksum({ fixtureArrivals: true }),
    arrivalCount: 1,
    artifactId: "qualification-execution-run-fixture",
    endedAtEpochMs: Date.parse("2026-08-17T12:00:01.000Z"),
    executionId: "qualification-execution-fixture",
    planChecksum: fixturePlanChecksum,
    runDescriptorChecksum: qualificationChecksum({ fixtureRun: true }),
    runId: "qualification-run-fixture",
    startedAtEpochMs: Date.parse("2026-08-17T12:00:00.000Z"),
    windowsChecksum: qualificationChecksum({ fixtureWindows: true }),
  });
  return {
    cost: {
      activeAdventurerPeriods: 1,
      activeFreePeriods: 1,
      adventurerRevenueUsdMicros: 1_000_000n,
      billedUsageArtifactChecksum: qualificationChecksum({
        artifactId: billedUsageArtifactId,
        invoiceId: billedUsageInvoiceId,
        lines: billedUsageLines,
        monthEndedAtUtc: billingMonthEndedAtUtc,
        monthStartedAtUtc: billingMonthStartedAtUtc,
        priceBookId,
        provider: billedUsageProvider,
      }),
      billedUsageArtifactId,
      billedUsageInvoiceId,
      billedUsageLines,
      billedUsageProvider,
      billedUsageUsdMicros,
      billingMonthEndedAtUtc,
      billingMonthStartedAtUtc,
      cohortPeriods,
      economicsArtifactChecksum: qualificationChecksum({
        activeAdventurerPeriods: 1,
        activeFreePeriods: 1,
        adventurerRevenueUsdMicros: 1_000_000n,
        artifactId: economicsArtifactId,
        cohortPeriods,
        foreignExchangeUsdMicros: 2_000n,
        goodRootOutcomeIds,
        source: economicsSource,
        taxesUsdMicros: 3_000n,
        windowEndedAtUtc: economicsWindowEndedAtUtc,
        windowStartedAtUtc: economicsWindowStartedAtUtc,
      }),
      economicsArtifactId,
      economicsSource,
      economicsWindowEndedAtUtc,
      economicsWindowStartedAtUtc,
      evaluatedAtEpochMs: Date.parse("2026-08-17T12:00:00.000Z"),
      foreignExchangeUsdMicros: 2_000n,
      goodRootOutcomeIds,
      priceBook,
      priceBookArtifactChecksum: qualificationChecksum({
        artifactId: "provider-price-book-v1",
        observedAtEpochMs: pricesObservedAtEpochMs,
        priceBook,
        priceBookId,
        source: priceBookSource,
        version: priceBookVersion,
      }),
      priceBookArtifactId: "provider-price-book-v1",
      priceBookId,
      priceBookSource,
      priceBookVersion,
      pricesObservedAtEpochMs,
      rootCosts,
      scenarios,
      taxesUsdMicros: 3_000n,
      usageLedgerArtifactChecksum: qualificationChecksum({
        artifactId: usageLedgerArtifactId,
        rootCosts,
        scenarios,
        source: usageLedgerSource,
        windowEndedAtUtc: usageLedgerWindowEndedAtUtc,
        windowStartedAtUtc: usageLedgerWindowStartedAtUtc,
      }),
      usageLedgerArtifactId,
      usageLedgerSource,
      usageLedgerWindowEndedAtUtc,
      usageLedgerWindowStartedAtUtc,
      usageAuthorityArtifactChecksum: qualificationChecksum({
        artifactId: usageAuthorityArtifactId,
        records: usageAuthorityRecords,
        source: usageAuthoritySource,
        sourceVersion: usageAuthoritySourceVersion,
        windowEndedAtUtc: usageAuthorityWindowEndedAtUtc,
        windowStartedAtUtc: usageAuthorityWindowStartedAtUtc,
      }),
      usageAuthorityArtifactId,
      usageAuthorityRecords,
      usageAuthoritySource,
      usageAuthoritySourceVersion,
      usageAuthorityWindowEndedAtUtc,
      usageAuthorityWindowStartedAtUtc,
    },
    externalGates: manifest.requiredExternalGates.map((gate) => ({
      checksum: qualificationChecksum(["PASS"]),
      evidenceId: `evidence-${gate}`,
      gate,
      records: ["PASS" as const],
      source: `${gate}-authority-export`,
      sourceVersion: manifest.sourceVersion,
      verdict: "PASS" as const,
      windowEndedAtUtc: "2026-08-24T00:00:00.000Z",
      windowStartedAtUtc: "2026-08-17T00:00:00.000Z",
    })),
    execution: qualificationExecutionEvidence(
      manifest,
      "qualification-execution-fixture",
      fixturePlanChecksum,
      "qualification-execution-fixture",
      [fixtureRunReceipt],
    ),
    manifest,
    memorySemantic: completeMemorySemanticEvidence(manifest.sourceVersion),
    recoveryRuns: manifest.regions.flatMap((region) =>
      Array.from({ length: 3 }, (_, repetition) => {
        const laneRun = runs.laneRuns.find(
          (run) =>
            run.lane === "dependencyOutageRecovery" &&
            run.region === region &&
            run.repetition === repetition + 1,
        );
        const acceptedRootIds = laneRun?.acceptedRootIds ?? [];
        const runArtifactChecksum = qualificationChecksum(acceptedRootIds);
        const faultWindow = laneRun?.windows.find(({ kind }) => kind === "fault");
        const outageStartedAtUtc = faultWindow?.startedAtUtc ?? "2026-08-17T11:59:59.000Z";
        const outageEndedAtUtc = faultWindow?.endedAtUtc ?? "2026-08-17T12:00:00.000Z";
        const outageSeconds = Math.max(
          1,
          (Date.parse(outageEndedAtUtc) - Date.parse(outageStartedAtUtc)) / 1_000,
        );
        const acceptedDemandPerSecond = acceptedRootIds.length / outageSeconds;
        const recoverySeconds = 5;
        const desiredCompletedRoots = Math.ceil((acceptedDemandPerSecond + 2) * recoverySeconds);
        const recoverableBacklogRootIds = Array.from(
          { length: Math.max(1, desiredCompletedRoots - acceptedRootIds.length) },
          (_entry, index) => `pre-outage-backlog-${region}-${repetition + 1}-${index}`,
        );
        const recoverableRootIds = [...acceptedRootIds, ...recoverableBacklogRootIds];
        const settledAtUtc = DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse(outageEndedAtUtc) + recoverySeconds * 1_000),
        );
        const dispositionByRoot = new Map(
          laneRun?.dispositions.map((disposition) => [disposition.rootId, disposition] as const) ??
            [],
        );
        const rootTransitions = recoverableRootIds.map((rootId, index) => {
          const disposition = dispositionByRoot.get(rootId);
          return {
            admissionAuthorityFactId:
              disposition?.authorityFactId ?? `recovery-admission-${rootId}`,
            admittedAtUtc:
              disposition?.resolvedAtUtc ??
              DateTime.formatIso(DateTime.makeUnsafe(Date.parse(outageStartedAtUtc) - 1_000)),
            rootId,
            terminalAtUtc:
              index === recoverableRootIds.length - 1
                ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(outageEndedAtUtc) + 1_000))
                : settledAtUtc,
            terminalAuthorityFactId: `recovery-terminal-${rootId}`,
            terminalState: "completed" as const,
          };
        });
        const authorityContent = {
          artifactId: `recovery-authority-${region}-${repetition + 1}`,
          outageEndedAtUtc,
          rootTransitions,
          runArtifactChecksum,
          source: "workflow-and-agent-recovery-authority",
          sourceVersion: manifest.sourceVersion,
          stateObservations: [
            {
              authorityFactIds: [`recovery-state-${region}-${repetition + 1}-0`],
              backlogRootIds: recoverableRootIds,
              durablyWaitingRootIds: recoverableRootIds,
              interruptedAgentIds: ["recovery-interrupted-agent-1"],
              lostAcceptedRootIds: [],
              observedAtUtc: outageEndedAtUtc,
            },
            {
              authorityFactIds: [`recovery-state-${region}-${repetition + 1}-1`],
              backlogRootIds: recoverableRootIds.slice(0, -1),
              durablyWaitingRootIds: recoverableRootIds.slice(0, -1),
              interruptedAgentIds: [],
              lostAcceptedRootIds: [],
              observedAtUtc: DateTime.formatIso(
                DateTime.makeUnsafe(Date.parse(outageEndedAtUtc) + 1_000),
              ),
            },
            {
              authorityFactIds: [`recovery-state-${region}-${repetition + 1}-settled`],
              backlogRootIds: [],
              durablyWaitingRootIds: [],
              interruptedAgentIds: [],
              lostAcceptedRootIds: [],
              observedAtUtc: settledAtUtc,
            },
          ],
          throughputWindows: [
            {
              acceptedRootIds,
              authorityFactIds: [`recovery-throughput-${region}-${repetition + 1}`],
              completedRootIds: recoverableRootIds,
              windowEndedAtUtc: outageEndedAtUtc,
              windowStartedAtUtc: outageStartedAtUtc,
            },
          ],
        };
        const recoveryGoodputPerSecond = recoverableRootIds.length / recoverySeconds;
        return {
          evidence: {
            acceptedDemandPerSecond,
            authorityArtifact: {
              ...authorityContent,
              artifactChecksum: qualificationChecksum(authorityContent),
            },
            backlogSlopeBecameNegativeAfterSeconds: 1,
            interruptedAgentSettledAfterSeconds: 1,
            lostAcceptedRoots: 0,
            recoverableBacklogSettledAfterSeconds: recoverySeconds,
            recoveryGoodputPerSecond,
          },
          region,
          repetition: repetition + 1,
          runArtifactChecksum,
        };
      }),
    ),
    resourceUse: Array.from({ length: 3 }, (_, repetition) => {
      const run = runs.laneRuns.find(
        (candidate) => candidate.lane === "target" && candidate.repetition === repetition + 1,
      );
      const runArtifactChecksum = qualificationChecksum(run?.acceptedRootIds ?? []);
      const records = (run?.acceptedRootIds ?? []).map((rootId, index) => ({
        authorityFactId: `resource-sqlQueries-${repetition + 1}-${index}`,
        observedAtUtc: run?.actualArrivals.windowStartedAtUtc ?? "2026-08-17T12:00:00.000Z",
        rootId,
        value: index === 0 ? 700 : 1,
      }));
      const authorityContent = {
        artifactId: `resource-authority-sqlQueries-americas-${repetition + 1}`,
        limitName: "sqlQueries",
        records,
        runArtifactChecksum,
        source: "cloudflare-worker-resource-authority",
        sourceVersion: manifest.sourceVersion,
        unit: "queries",
      };
      return {
        authorityArtifact: {
          artifactChecksum: qualificationChecksum(authorityContent),
          artifactId: authorityContent.artifactId,
          records,
          runArtifactChecksum,
          source: authorityContent.source,
          sourceVersion: authorityContent.sourceVersion,
        },
        limitName: "sqlQueries",
        maximumObserved: 700,
        region: "americas" as const,
        repetition: repetition + 1,
        runArtifactChecksum,
        unit: "queries",
      };
    }),
    runs,
    semantic,
    stages: completeStageMeasurements(runs, semantic),
  };
};
import { DateTime } from "effect";

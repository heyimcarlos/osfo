import { Array, Order } from "effect";

import {
  assessCostEvidence,
  costCategoryAuthorities,
  type CostEvidence,
  type CostSummaryEvidence,
} from "./cost-evidence";
import { qualificationChecksum } from "./qualification-checksum";
import {
  assessMemorySemanticEvidence,
  type MemorySemanticEvidence,
} from "./memory-semantic-evidence";
import type { ExternalGate, ProductionQualificationManifest } from "./qualification-manifest";
import {
  acceptedRootIdsForRuns,
  assessQualificationRuns,
  type QualificationRunEvidence,
} from "./qualification-runs";
import { assessRecovery, type RecoveryEvidence } from "./recovery-evidence";
import { assessResourceHeadroom, type ResourceUseMeasurement } from "./resource-headroom";
import { assessSemanticEvidence, type SemanticEvidenceInput } from "./semantic-evidence";
import {
  assessStageEvidence,
  stageAuthorityComponents,
  type StageMeasurement,
  type StageSummary,
} from "./stage-evidence";
import {
  assessmentFromFindings,
  type QualificationFinding,
  type QualificationVerdict,
} from "./verdict";

/** Independent non-harness authority result required for production promotion. */
export interface ExternalGateEvidence {
  readonly checksum: string;
  readonly evidenceId: string;
  readonly gate: ExternalGate;
  readonly records: ReadonlyArray<QualificationVerdict>;
  readonly source: string;
  readonly sourceVersion: string;
  readonly verdict: QualificationVerdict;
  readonly windowEndedAtUtc: string;
  readonly windowStartedAtUtc: string;
}

/** Recovery evidence for one exact required outage repetition and region. */
export interface RecoveryRunEvidence {
  readonly evidence: RecoveryEvidence;
  readonly region: ProductionQualificationManifest["regions"][number];
  readonly repetition: number;
  readonly runArtifactChecksum: string;
}

/** Retained authority artifact binding collected evidence to one exact executed plan. */
export interface QualificationExecutionEvidence {
  readonly artifactChecksum: string;
  readonly artifactId: string;
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly runReceipts: ReadonlyArray<QualificationRunExecutionReceipt>;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
}

/** Persisted authority receipt for one exact planned run and its offered-arrival artifact. */
export interface QualificationRunExecutionReceipt {
  readonly arrivalArtifactChecksum: string;
  readonly arrivalCount: number;
  readonly artifactChecksum: string;
  readonly artifactId: string;
  readonly endedAtEpochMs: number;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly runDescriptorChecksum: string;
  readonly runId: string;
  readonly startedAtEpochMs: number;
  readonly windowsChecksum: string;
}

/** Freeze one driver-produced run receipt after its authority artifact is retained. */
export const qualificationRunExecutionReceipt = (
  content: Omit<QualificationRunExecutionReceipt, "artifactChecksum">,
): QualificationRunExecutionReceipt => ({
  ...content,
  artifactChecksum: qualificationChecksum(content),
});

/** Bind a collector's retained evidence to the exact manifest and execution plan it observed. */
export const qualificationExecutionEvidence = (
  manifest: ProductionQualificationManifest,
  executionId: string,
  planChecksum: string,
  artifactId: string,
  runReceipts: ReadonlyArray<QualificationRunExecutionReceipt>,
): QualificationExecutionEvidence => {
  const content = {
    artifactId,
    executionId,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum,
    runReceipts,
    sourceVersion: manifest.sourceVersion,
    topologyVersion: manifest.topologyVersion,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

/** Complete evidence bundle evaluated against one exact frozen manifest. */
export interface ProductionQualificationEvidence {
  readonly cost: CostEvidence;
  readonly execution: QualificationExecutionEvidence;
  readonly externalGates: ReadonlyArray<ExternalGateEvidence>;
  readonly manifest: ProductionQualificationManifest;
  readonly memorySemantic: MemorySemanticEvidence;
  readonly recoveryRuns: ReadonlyArray<RecoveryRunEvidence>;
  readonly resourceUse: ReadonlyArray<ResourceUseMeasurement>;
  readonly runs: QualificationRunEvidence;
  readonly semantic: SemanticEvidenceInput;
  readonly stages: ReadonlyArray<StageMeasurement>;
}

/** Fail-closed qualification result with every reproduced summary and finding. */
export interface ProductionQualificationReport {
  readonly adventurerContributionMargin: number | null;
  readonly costSummaries: ReadonlyArray<CostSummaryEvidence>;
  readonly findings: ReadonlyArray<QualificationFinding>;
  readonly foreignExchangeUsdMicros: bigint;
  readonly freeCostPerActivePeriodUsdMicros: bigint | null;
  readonly recoveryReservePerSecond: number | null;
  readonly stageSummaries: ReadonlyArray<StageSummary>;
  readonly taxesUsdMicros: bigint;
  readonly verdict: QualificationVerdict;
}

const finding = (
  code: string,
  detail: string,
  subject: string,
  verdict: QualificationFinding["verdict"],
): QualificationFinding => ({ code, detail, subject, verdict });

const assessManifest = (
  manifest: ProductionQualificationManifest,
): ReadonlyArray<QualificationFinding> => {
  const findings: Array<QualificationFinding> = [];
  const { manifestChecksum, ...manifestContent } = manifest;
  if (manifestChecksum !== qualificationChecksum(manifestContent)) {
    findings.push(
      finding(
        "manifestChecksumMismatch",
        "The manifest content does not match its derived checksum",
        manifest.acceptanceLevel,
        "FAIL",
      ),
    );
  }
  if (
    manifest.manifestChecksum.length === 0 ||
    manifest.sourceVersion.length === 0 ||
    manifest.topologyVersion.length === 0 ||
    Object.keys(manifest.dependencyVersions).length === 0 ||
    Object.entries(manifest.dependencyVersions).some(
      ([name, version]) => name.length === 0 || version.length === 0,
    ) ||
    manifest.hardLimits.length === 0
  ) {
    findings.push(
      finding(
        "frozenManifestIncomplete",
        "The manifest omits a checksum, exact version, dependency, or hard limit",
        manifest.acceptanceLevel,
        "MISSING",
      ),
    );
  }
  if (!Number.isInteger(manifest.workloadSeed) || manifest.workloadSeed < 0) {
    findings.push(
      finding(
        "invalidWorkloadSeed",
        "The frozen workload seed is not a non-negative integer",
        manifest.acceptanceLevel,
        "FAIL",
      ),
    );
  }
  if (
    new Set(manifest.hardLimits.map((limit) => limit.name)).size !== manifest.hardLimits.length ||
    manifest.hardLimits.some(
      (limit) =>
        limit.name.length === 0 ||
        limit.unit.length === 0 ||
        !Number.isFinite(limit.maximum) ||
        limit.maximum <= 0,
    )
  ) {
    findings.push(
      finding(
        "invalidFrozenHardLimits",
        "Frozen hard limits contain a duplicate or invalid value",
        manifest.acceptanceLevel,
        "FAIL",
      ),
    );
  }
  if (
    manifest.journeyMix.reduce((total, journey) => total + journey.percentage, 0) !== 100 ||
    manifest.planMixBasisPoints.free + manifest.planMixBasisPoints.adventurer !== 10_000
  ) {
    findings.push(
      finding(
        "invalidWorkloadMix",
        "The frozen journey or plan mix does not total its full population",
        manifest.acceptanceLevel,
        "FAIL",
      ),
    );
  }
  return findings;
};

/** Evaluate every v1 system and external production gate without filling evidence gaps. */
export const qualifyProduction = (
  evidence: ProductionQualificationEvidence,
): ProductionQualificationReport => {
  const runs = assessQualificationRuns(evidence.manifest, evidence.runs);
  const rootWindows = Object.fromEntries(
    [...evidence.runs.laneRuns, ...evidence.runs.challengeRuns].flatMap((run) =>
      run.acceptedRootIds.map((rootId) => [
        rootId,
        {
          endedAtUtc: run.actualArrivals.windowEndedAtUtc,
          startedAtUtc: run.actualArrivals.windowStartedAtUtc,
        },
      ]),
    ),
  );
  const semantic = assessSemanticEvidence(
    evidence.semantic,
    evidence.manifest.semanticRequirements,
    {
      rootWindows,
      sourceVersion: evidence.manifest.sourceVersion,
    },
  );
  const stages = assessStageEvidence(evidence.manifest, evidence.stages);
  const resources = assessResourceHeadroom(evidence.manifest, evidence.resourceUse);
  const cost = assessCostEvidence(evidence.cost);
  const memorySemantic = assessMemorySemanticEvidence(evidence.memorySemantic);
  const findings: Array<QualificationFinding> = [
    ...assessManifest(evidence.manifest),
    ...runs.findings,
    ...semantic.findings,
    ...stages.findings,
    ...resources.findings,
    ...cost.findings,
    ...memorySemantic.findings,
  ];
  const { artifactChecksum: executionChecksum, ...executionContent } = evidence.execution;
  if (
    evidence.execution.artifactId.length === 0 ||
    evidence.execution.executionId.length === 0 ||
    evidence.execution.planChecksum.length === 0 ||
    evidence.execution.runReceipts.length === 0
  ) {
    findings.push(
      finding(
        "executionEvidenceMissing",
        "Qualification evidence omits its retained execution-plan binding",
        evidence.manifest.acceptanceLevel,
        "MISSING",
      ),
    );
  } else if (
    executionChecksum !== qualificationChecksum(executionContent) ||
    evidence.execution.manifestChecksum !== evidence.manifest.manifestChecksum ||
    evidence.execution.sourceVersion !== evidence.manifest.sourceVersion ||
    evidence.execution.topologyVersion !== evidence.manifest.topologyVersion
  ) {
    findings.push(
      finding(
        "executionEvidenceConflict",
        "Qualification evidence is not bound to its manifest, source, topology, and plan",
        evidence.execution.artifactId,
        "FAIL",
      ),
    );
  } else {
    const runIds = new Set<string>();
    for (const receipt of evidence.execution.runReceipts) {
      const { artifactChecksum, ...receiptContent } = receipt;
      if (
        artifactChecksum !== qualificationChecksum(receiptContent) ||
        receipt.planChecksum !== evidence.execution.planChecksum ||
        receipt.executionId !== evidence.execution.executionId ||
        receipt.artifactId.length === 0 ||
        receipt.arrivalArtifactChecksum.length === 0 ||
        receipt.runDescriptorChecksum.length === 0 ||
        receipt.windowsChecksum.length === 0 ||
        receipt.arrivalCount <= 0 ||
        receipt.endedAtEpochMs <= receipt.startedAtEpochMs
      ) {
        findings.push(
          finding(
            "executionRunReceiptInvalid",
            `${receipt.runId} has an invalid or conflicting retained execution receipt`,
            receipt.artifactId,
            "FAIL",
          ),
        );
      }
      if (runIds.has(receipt.runId)) {
        findings.push(
          finding(
            "executionRunReceiptDuplicate",
            `${receipt.runId} has more than one retained execution receipt`,
            receipt.runId,
            "FAIL",
          ),
        );
      }
      runIds.add(receipt.runId);
    }
  }
  for (const run of evidence.runs.challengeRuns) {
    const receipt = run.faultControllerReceipt;
    if (
      evidence.execution.planChecksum.length > 0 &&
      receipt !== null &&
      receipt.planChecksum !== evidence.execution.planChecksum
    ) {
      findings.push(
        finding(
          "faultControllerPlanConflict",
          `${run.challenge}:${run.region} fault injection is not bound to the executed plan`,
          receipt.artifactId,
          "FAIL",
        ),
      );
    }
  }
  if (evidence.memorySemantic.sourceVersion !== evidence.manifest.sourceVersion) {
    findings.push(
      finding(
        "memorySemanticVersionMismatch",
        "Memory semantic evidence is not bound to the frozen source version",
        evidence.memorySemantic.artifactId,
        "FAIL",
      ),
    );
  }

  const requiredAcceptedRoots = acceptedRootIdsForRuns(evidence.runs);
  const requiredRootSet = new Set(requiredAcceptedRoots);
  const semanticRootSet = new Set(evidence.semantic.acceptedRootIds);
  for (const rootId of requiredRootSet) {
    if (!semanticRootSet.has(rootId)) {
      findings.push(
        finding(
          "acceptedRootSemanticEvidenceMissing",
          `${rootId} has no unsampled semantic evidence`,
          rootId,
          "MISSING",
        ),
      );
    }
  }
  for (const rootId of semanticRootSet) {
    if (!requiredRootSet.has(rootId)) {
      findings.push(
        finding(
          "semanticRootOutsideRunCorpus",
          `${rootId} is not in a qualified run identity set`,
          rootId,
          "FAIL",
        ),
      );
    }
  }
  const tracesByRoot = new Map(evidence.semantic.traces.map((trace) => [trace.rootId, trace]));
  for (const run of [...evidence.runs.laneRuns, ...evidence.runs.challengeRuns]) {
    const traces = run.acceptedRootIds.flatMap((rootId) => {
      const trace = tracesByRoot.get(rootId);
      return trace === undefined ? [] : [trace];
    });
    const free = traces.filter((trace) => trace.plan === "free").length;
    const adventurer = traces.filter((trace) => trace.plan === "adventurer").length;
    const journeysMatch = evidence.manifest.journeyMix.every(
      ({ journey }) =>
        traces.filter((trace) => trace.journey === journey).length === run.journeyCounts[journey],
    );
    const regionsMatch = traces.every((trace) => trace.activation.region === run.region);
    const allColdMatches =
      !("lane" in run) ||
      run.lane !== "allCold" ||
      traces.every(
        (trace) => trace.activation.classification === "cold" && trace.activation.cause !== "warm",
      );
    if (
      traces.length === run.acceptedRootIds.length &&
      (free !== run.planCounts.free ||
        adventurer !== run.planCounts.adventurer ||
        !journeysMatch ||
        !regionsMatch ||
        !allColdMatches)
    ) {
      const subject =
        "lane" in run
          ? `${run.lane}:${run.region}:${run.repetition}`
          : `${run.challenge}:${run.region}`;
      findings.push(
        finding(
          "semanticPopulationConflict",
          `${subject} semantic traces do not match its Plan, journey, region, or activation population`,
          subject,
          "FAIL",
        ),
      );
    }
  }
  const qualificationRuns = [...evidence.runs.laneRuns, ...evidence.runs.challengeRuns];
  const actualArrivalByRoot = new Map(
    qualificationRuns.flatMap((run) =>
      run.actualArrivals.records.map((arrival) => [arrival.rootId, arrival] as const),
    ),
  );
  const authoritativeGoodRootIds: Array<string> = [];
  for (const outcome of qualificationRuns.flatMap((run) => run.rootOutcomes)) {
    const trace = tracesByRoot.get(outcome.rootId);
    const arrival = actualArrivalByRoot.get(outcome.rootId);
    const requirement = evidence.manifest.journeyMix.find(
      (candidate) => candidate.journey === outcome.journey,
    );
    if (trace === undefined || arrival === undefined || requirement === undefined) {
      findings.push(
        finding(
          "rootOutcomeAuthorityMissing",
          `${outcome.rootId} has no semantic trace, arrival, or frozen journey assertion`,
          outcome.rootId,
          "MISSING",
        ),
      );
      continue;
    }
    const authorityFactIds = requirement.assertionAuthorities.flatMap((component) =>
      trace.signals
        .filter((signal) => signal.component === component)
        .map((signal) => signal.signalId),
    );
    const authorityFactsMatch =
      authorityFactIds.length === requirement.assertionAuthorities.length &&
      [...outcome.assertions, ...outcome.milestoneAssertions].every(
        (assertion) =>
          qualificationChecksum(
            Array.sortWith(assertion.authorityFactIds, (id) => id, Order.String),
          ) === qualificationChecksum(Array.sortWith(authorityFactIds, (id) => id, Order.String)),
      );
    if (
      outcome.outcomeId !== trace.correlations.outcomeId ||
      outcome.journey !== arrival.journey ||
      !authorityFactsMatch
    ) {
      findings.push(
        finding(
          "rootOutcomeAuthorityConflict",
          `${outcome.rootId} Good Root assertions do not bind to every required committed authority fact`,
          outcome.rootId,
          "FAIL",
        ),
      );
      continue;
    }
    const acceptedAt = Date.parse(outcome.acceptedAtUtc);
    const evaluatedAt = Date.parse(outcome.evaluatedAtUtc);
    const assertionsMatch = (
      assertions: typeof outcome.assertions,
      expectedAssertions: ReadonlyArray<string>,
    ): boolean =>
      assertions.length === expectedAssertions.length &&
      assertions.every((assertion, index) => {
        const expected = expectedAssertions[index];
        return (
          assertion.assertion === expected &&
          assertion.passed &&
          assertion.productFactId === outcome.outcomeId &&
          assertion.productFactChecksum ===
            qualificationChecksum({
              assertion: assertion.assertion,
              authorityFactIds: assertion.authorityFactIds,
              occurredAtUtc: assertion.occurredAtUtc,
              passed: assertion.passed,
              productFactId: assertion.productFactId,
              rootId: outcome.rootId,
            })
        );
      });
    const assertionsValid =
      outcome.assertionVersion === requirement.assertionVersion &&
      assertionsMatch(outcome.assertions, requirement.assertions);
    const milestoneRequired =
      requirement.milestoneDeadlineMs !== null &&
      evaluatedAt - acceptedAt > requirement.milestoneDeadlineMs;
    const milestoneValid =
      !milestoneRequired ||
      (outcome.milestoneEvaluatedAtUtc !== null &&
        Date.parse(outcome.milestoneEvaluatedAtUtc) - acceptedAt <=
          requirement.milestoneDeadlineMs &&
        Date.parse(outcome.milestoneEvaluatedAtUtc) >= acceptedAt &&
        assertionsMatch(outcome.milestoneAssertions, requirement.milestoneAssertions));
    if (
      Number.isFinite(acceptedAt) &&
      Number.isFinite(evaluatedAt) &&
      evaluatedAt >= acceptedAt &&
      evaluatedAt - acceptedAt <= requirement.deadlineMs &&
      assertionsValid &&
      milestoneValid
    )
      authoritativeGoodRootIds.push(outcome.rootId);
  }
  const derivedGoodRootIds = Array.sortWith(
    authoritativeGoodRootIds,
    (rootId) => rootId,
    Order.String,
  );
  if (
    qualificationChecksum(derivedGoodRootIds) !==
    qualificationChecksum(
      Array.sortWith(evidence.cost.goodRootOutcomeIds, (rootId) => rootId, Order.String),
    )
  ) {
    findings.push(
      finding(
        "goodRootCostCorpusConflict",
        "Cost-per-Good-Root-Outcome identities do not match the qualified outcome corpus",
        "goodRootOutcomes",
        "FAIL",
      ),
    );
  }
  const reconciledRootCosts = new Set(cost.reconciledRootCostIds);
  const costRecordsByRoot = new Map(
    evidence.cost.rootCosts.map((record) => [record.rootId, record]),
  );
  const authorityUsageFacts = evidence.semantic.productAuthorityExports.flatMap((artifact) =>
    artifact.records.flatMap((record) =>
      record.usageFacts.map((usage) => ({
        ...usage,
        productFactId: record.productFactId,
        rootId: record.rootId,
      })),
    ),
  );
  const authorityUsageBySource = new Map<
    string,
    ReadonlyArray<(typeof authorityUsageFacts)[number]>
  >();
  for (const fact of authorityUsageFacts) {
    const key = `${fact.rootId}:${fact.category}:${fact.productFactId}`;
    authorityUsageBySource.set(key, [...(authorityUsageBySource.get(key) ?? []), fact]);
  }
  for (const trace of evidence.semantic.traces) {
    const record = costRecordsByRoot.get(trace.rootId);
    if (record === undefined) {
      findings.push(
        finding(
          "rootCostReconciliationMissing",
          `${trace.rootId} has no matching all-in cost reconciliation record`,
          trace.rootId,
          "MISSING",
        ),
      );
    } else if (
      record.costReconciliationId !== trace.costReconciliationId ||
      record.priceBookId !== trace.correlations.priceBookId ||
      record.plan !== trace.plan ||
      record.journey !== trace.journey
    ) {
      findings.push(
        finding(
          "rootCostReconciliationConflict",
          `${trace.rootId} cost usage does not match its semantic root, Plan, journey, or price book`,
          trace.rootId,
          "FAIL",
        ),
      );
    } else {
      for (const line of record.usage) {
        const component = costCategoryAuthorities[line.category];
        const hasSemanticSignal = trace.signals.some(
          (signal) =>
            signal.component === component && signal.signalId === line.sourceProductFactId,
        );
        const authorityCandidates =
          authorityUsageBySource.get(
            `${trace.rootId}:${line.category}:${line.sourceProductFactId}`,
          ) ?? [];
        const hasExactAuthorityFact = authorityCandidates.some(
          (fact) =>
            fact.quantity === line.quantity &&
            fact.unit === line.unit &&
            fact.usageId === line.usageId,
        );
        if (
          !hasSemanticSignal ||
          (authorityCandidates.length === 0 && component !== "PostgreSQL" && component !== "R2")
        ) {
          findings.push(
            finding(
              "rootCostAuthorityMissing",
              `${trace.rootId} ${line.category} usage has no owning retained product fact`,
              line.usageId,
              "MISSING",
            ),
          );
        } else if (component !== "PostgreSQL" && component !== "R2" && !hasExactAuthorityFact) {
          findings.push(
            finding(
              "rootCostReconciliationConflict",
              `${trace.rootId} ${line.category} usage conflicts with its retained authority fact`,
              line.usageId,
              "FAIL",
            ),
          );
        }
      }
    }
  }
  const productSignalIds = new Set(
    evidence.semantic.traces.flatMap((trace) =>
      trace.signals.map((signal) => `${signal.component}:${signal.signalId}`),
    ),
  );
  for (const scenario of evidence.cost.scenarios) {
    for (const line of scenario.usage) {
      const authority = costCategoryAuthorities[line.category];
      if (!productSignalIds.has(`${authority}:${line.sourceProductFactId}`)) {
        findings.push(
          finding(
            "scenarioCostAuthorityMissing",
            `${scenario.dimension} ${line.category} usage has no owning retained product fact`,
            line.usageId,
            "MISSING",
          ),
        );
      }
      if (
        !["PostgreSQL", "R2"].includes(authority) &&
        !authorityUsageFacts.some(
          (fact) =>
            fact.category === line.category &&
            fact.quantity === line.quantity &&
            fact.productFactId === line.sourceProductFactId &&
            fact.unit === line.unit,
        )
      ) {
        findings.push(
          finding(
            "scenarioCostQuantityMissing",
            `${scenario.dimension} ${line.category} has no retained authority quantity`,
            line.usageId,
            "MISSING",
          ),
        );
      }
    }
  }
  const traceCostIds = new Set(evidence.semantic.traces.map((trace) => trace.costReconciliationId));
  for (const costId of reconciledRootCosts) {
    if (!traceCostIds.has(costId)) {
      findings.push(
        finding(
          "costReconciliationOutsideTraceCorpus",
          `${costId} does not bind to a retained root semantic trace`,
          costId,
          "FAIL",
        ),
      );
    }
  }
  const traceRoots = new Set(evidence.semantic.traces.map((trace) => trace.rootId));
  for (const rootId of costRecordsByRoot.keys()) {
    if (!traceRoots.has(rootId)) {
      findings.push(
        finding(
          "costReconciliationOutsideTraceCorpus",
          `${rootId} cost record does not bind to a retained semantic root`,
          rootId,
          "FAIL",
        ),
      );
    }
  }

  const recoveryLane = evidence.manifest.lanes.find(
    (lane) => lane.kind === "dependencyOutageRecovery",
  );
  const recoveryReserves: Array<number> = [];
  if (recoveryLane === undefined) {
    findings.push(
      finding(
        "recoveryLaneMissing",
        "The frozen manifest has no dependency-outage recovery lane",
        evidence.manifest.acceptanceLevel,
        "MISSING",
      ),
    );
  } else {
    for (const region of evidence.manifest.regions) {
      for (let repetition = 1; repetition <= recoveryLane.repetitions; repetition += 1) {
        const subject = `dependencyOutageRecovery:${region}:${repetition}`;
        const matches = evidence.recoveryRuns.filter(
          (run) => run.region === region && run.repetition === repetition,
        );
        if (matches.length > 1)
          findings.push(
            finding(
              "duplicateRecoveryEvidence",
              `${subject} has ${matches.length} recovery records`,
              subject,
              "FAIL",
            ),
          );
        const run = matches[0];
        if (run === undefined) {
          findings.push(
            finding(
              "recoveryEvidenceMissing",
              `${subject} has no recovery evidence`,
              subject,
              "MISSING",
            ),
          );
          continue;
        }
        const laneRun = evidence.runs.laneRuns.find(
          (candidate) =>
            candidate.lane === "dependencyOutageRecovery" &&
            candidate.region === region &&
            candidate.repetition === repetition,
        );
        if (
          laneRun === undefined ||
          run.runArtifactChecksum !== qualificationChecksum(laneRun.acceptedRootIds) ||
          run.evidence.authorityArtifact?.runArtifactChecksum !== run.runArtifactChecksum
        ) {
          findings.push(
            finding(
              "recoveryRunCorrelationMissing",
              `${subject} is not bound to its retained run identity set`,
              subject,
              "MISSING",
            ),
          );
        }
        const recoveryAuthority = run.evidence.authorityArtifact;
        if (laneRun !== undefined && recoveryAuthority !== undefined) {
          const acceptedRoots = new Set(laneRun.acceptedRootIds);
          const backlogRoots = new Set(
            recoveryAuthority.stateObservations[0]?.backlogRootIds ?? [],
          );
          const recoverableRoots = new Set([...acceptedRoots, ...backlogRoots]);
          const acceptedAuthorityRoots = recoveryAuthority.throughputWindows.flatMap(
            ({ acceptedRootIds }) => acceptedRootIds,
          );
          const acceptedAuthoritySet = new Set(acceptedAuthorityRoots);
          const completedAuthorityRoots = recoveryAuthority.throughputWindows.flatMap(
            ({ completedRootIds }) => completedRootIds,
          );
          const completedRoots = new Set(completedAuthorityRoots);
          const finalObservation = recoveryAuthority.stateObservations.reduce<
            (typeof recoveryAuthority.stateObservations)[number] | undefined
          >(
            (latest, observation) =>
              latest === undefined ||
              Date.parse(observation.observedAtUtc) > Date.parse(latest.observedAtUtc)
                ? observation
                : latest,
            undefined,
          );
          const statePartitionInvalid = recoveryAuthority.stateObservations.some((observation) => {
            const backlog = new Set(observation.backlogRootIds);
            const lost = new Set(observation.lostAcceptedRootIds);
            return (
              observation.durablyWaitingRootIds.some((rootId) => !backlog.has(rootId)) ||
              [...lost].some((rootId) => backlog.has(rootId)) ||
              [...backlog, ...lost].some((rootId) => !recoverableRoots.has(rootId))
            );
          });
          const terminalAuthorityRoots = [
            ...recoveryAuthority.throughputWindows.flatMap(
              ({ completedRootIds }) => completedRootIds,
            ),
            ...recoveryAuthority.stateObservations.flatMap(
              ({ backlogRootIds, durablyWaitingRootIds, lostAcceptedRootIds }) => [
                ...backlogRootIds,
                ...durablyWaitingRootIds,
                ...lostAcceptedRootIds,
              ],
            ),
          ];
          if (
            acceptedAuthorityRoots.some((rootId) => !acceptedRoots.has(rootId)) ||
            acceptedAuthorityRoots.length !== acceptedAuthoritySet.size ||
            acceptedAuthoritySet.size !== acceptedRoots.size ||
            [...acceptedRoots].some((rootId) => !acceptedAuthoritySet.has(rootId)) ||
            (recoveryAuthority.stateObservations[0]?.backlogRootIds.length ?? 0) !==
              backlogRoots.size ||
            [...backlogRoots].some((rootId) => acceptedRoots.has(rootId)) ||
            terminalAuthorityRoots.some((rootId) => !recoverableRoots.has(rootId))
          ) {
            findings.push(
              finding(
                "recoveryAuthorityRunConflict",
                `${subject} raw recovery facts name roots outside the accepted run`,
                recoveryAuthority.artifactId,
                "FAIL",
              ),
            );
          }
          if (
            statePartitionInvalid ||
            completedAuthorityRoots.length !== completedRoots.size ||
            completedRoots.size !== recoverableRoots.size ||
            [...recoverableRoots].some((rootId) => !completedRoots.has(rootId)) ||
            finalObservation === undefined ||
            finalObservation.backlogRootIds.length > 0 ||
            finalObservation.durablyWaitingRootIds.length > 0 ||
            finalObservation.lostAcceptedRootIds.length > 0
          ) {
            findings.push(
              finding(
                "recoveryAuthorityCoverageConflict",
                `${subject} does not partition every accepted and recoverable root through terminal state`,
                recoveryAuthority.artifactId,
                "FAIL",
              ),
            );
          }
        }
        if (
          run.evidence.authorityArtifact !== undefined &&
          run.evidence.authorityArtifact.sourceVersion !== evidence.manifest.sourceVersion
        ) {
          findings.push(
            finding(
              "recoveryAuthorityVersionConflict",
              `${subject} recovery authority is not bound to the frozen source version`,
              run.evidence.authorityArtifact.artifactId,
              "FAIL",
            ),
          );
        }
        const assessment = assessRecovery(run.evidence);
        findings.push(
          ...assessment.findings.map((entry) => ({
            ...entry,
            detail: `${subject}: ${entry.detail}`,
            subject,
          })),
        );
        if (assessment.recoveryReservePerSecond !== null)
          recoveryReserves.push(assessment.recoveryReservePerSecond);
      }
    }
  }

  for (const measurement of evidence.resourceUse) {
    const laneRun = evidence.runs.laneRuns.find(
      (run) =>
        run.lane === "target" &&
        run.region === measurement.region &&
        run.repetition === measurement.repetition,
    );
    const subject = `${measurement.limitName}:${measurement.region}:${measurement.repetition}`;
    if (
      laneRun === undefined ||
      measurement.runArtifactChecksum !== qualificationChecksum(laneRun.acceptedRootIds)
    ) {
      findings.push(
        finding(
          "resourceRunCorrelationMissing",
          `${subject} is not bound to its retained run identity set`,
          subject,
          "MISSING",
        ),
      );
      continue;
    }
    const authority = measurement.authorityArtifact;
    if (authority !== undefined) {
      const acceptedRoots = new Set(laneRun.acceptedRootIds);
      const observedRoots = new Set(authority.records.map(({ rootId }) => rootId));
      const startedAt = Date.parse(laneRun.actualArrivals.windowStartedAtUtc);
      const endedAt = Date.parse(laneRun.actualArrivals.windowEndedAtUtc);
      if (
        authority.runArtifactChecksum !== measurement.runArtifactChecksum ||
        observedRoots.size !== acceptedRoots.size ||
        [...acceptedRoots].some((rootId) => !observedRoots.has(rootId)) ||
        authority.records.some(
          (record) =>
            !acceptedRoots.has(record.rootId) ||
            Date.parse(record.observedAtUtc) < startedAt ||
            Date.parse(record.observedAtUtc) > endedAt,
        )
      ) {
        findings.push(
          finding(
            "resourceAuthorityRunConflict",
            `${subject} raw resource facts fall outside the accepted roots or run window`,
            authority.artifactId,
            "FAIL",
          ),
        );
      }
    }
  }

  for (const measurement of evidence.stages) {
    const laneRun = evidence.runs.laneRuns.find(
      (run) =>
        run.lane === measurement.lane &&
        run.region === measurement.region &&
        run.repetition === measurement.repetition,
    );
    const subject = `${measurement.lane}:${measurement.region}:${measurement.repetition}:${measurement.stage}`;
    if (
      laneRun === undefined ||
      measurement.runArtifactChecksum !== laneRun.actualArrivals.checksum
    ) {
      findings.push(
        finding(
          "stageRunCorrelationMissing",
          `${subject} is not bound to its retained run artifact`,
          subject,
          "MISSING",
        ),
      );
      continue;
    }
    const acceptedRoots = new Set(laneRun.acceptedRootIds);
    const expectedEligibleRoots = laneRun.acceptedRootIds.filter((rootId) => {
      const trace = tracesByRoot.get(rootId);
      if (trace === undefined) return false;
      if (measurement.stage === "coldDurableAcceptance") {
        return (
          trace.activation.classification === "cold" &&
          trace.activation.cause === measurement.coldCause
        );
      }
      if (measurement.stage === "warmDurableAcceptance") {
        return trace.activation.classification === "warm";
      }
      if (
        measurement.stage === "scheduledEmailOutcome" ||
        measurement.stage === "scheduledEmailProtectedSendStart"
      ) {
        return trace.journey === "scheduledEmail";
      }
      if (
        measurement.stage === "scheduledTaskHandlerStart" ||
        measurement.stage === "scheduledTaskSubmissionAcceptance" ||
        measurement.stage === "workflowOutcomeFollowUpAcceptance" ||
        measurement.stage === "workflowStartAcceptance" ||
        measurement.stage === "workflowWakeMilestoneCommit"
      ) {
        return trace.journey === "reminder" || trace.journey === "scheduledEmail";
      }
      return true;
    });
    const declaredEligibleRoots = new Set(measurement.eligibleRootIds);
    if (expectedEligibleRoots.some((rootId) => !declaredEligibleRoots.has(rootId))) {
      findings.push(
        finding(
          "stageDenominatorMissing",
          `${subject} omits at least one manifest-derived eligible root`,
          subject,
          "MISSING",
        ),
      );
    }
    if (measurement.eligibleRootIds.some((rootId) => !expectedEligibleRoots.includes(rootId))) {
      findings.push(
        finding(
          "stageDenominatorConflict",
          `${subject} declares a root that is not eligible for that stage`,
          subject,
          "FAIL",
        ),
      );
    }
    for (const sample of measurement.samples) {
      if (!acceptedRoots.has(sample.rootId)) {
        findings.push(
          finding(
            "stageRootCorrelationMissing",
            `${subject} sample ${sample.rootId} is not an accepted root in that run`,
            sample.rootId,
            "MISSING",
          ),
        );
      }
      const trace = tracesByRoot.get(sample.rootId);
      const authorities = stageAuthorityComponents(measurement.stage);
      const start = trace?.stageOccurrences.find(
        (occurrence) => occurrence.boundary === authorities.start,
      );
      const end = trace?.stageOccurrences.find(
        (occurrence) => occurrence.boundary === authorities.end,
      );
      if (
        start === undefined ||
        end === undefined ||
        sample.startProductFactId !== start.productFactId ||
        sample.startedAtUtc !== start.occurredAt ||
        sample.endProductFactId !== end.productFactId ||
        sample.endedAtUtc !== end.occurredAt
      ) {
        findings.push(
          finding(
            "stageProductAuthorityConflict",
            `${subject} sample ${sample.rootId} does not derive from its committed stage timestamps`,
            sample.rootId,
            start === undefined || end === undefined ? "MISSING" : "FAIL",
          ),
        );
      }
    }
  }

  for (const requiredGate of evidence.manifest.requiredExternalGates) {
    const gates = evidence.externalGates.filter((candidate) => candidate.gate === requiredGate);
    if (gates.length > 1)
      findings.push(
        finding(
          "duplicateExternalGateEvidence",
          `${requiredGate} has ${gates.length} authority records`,
          requiredGate,
          "FAIL",
        ),
      );
    if (
      gates.length === 0 ||
      gates.some(
        (gate) =>
          gate.evidenceId.length === 0 ||
          gate.source.length === 0 ||
          gate.sourceVersion !== evidence.manifest.sourceVersion ||
          gate.records.length === 0 ||
          gate.checksum !== qualificationChecksum(gate.records) ||
          Date.parse(gate.windowEndedAtUtc) <= Date.parse(gate.windowStartedAtUtc) ||
          gate.verdict === "MISSING",
      )
    ) {
      findings.push(
        finding(
          "externalGateMissing",
          `${requiredGate} has no complete authoritative evidence`,
          requiredGate,
          "MISSING",
        ),
      );
    }
    if (
      gates.some(
        (gate) =>
          gate.verdict !==
          (gate.records.some((record) => record === "FAIL")
            ? "FAIL"
            : gate.records.some((record) => record === "MISSING")
              ? "MISSING"
              : "PASS"),
      )
    ) {
      findings.push(
        finding(
          "externalGateArtifactConflict",
          `${requiredGate} verdict does not match its retained authority records`,
          requiredGate,
          "FAIL",
        ),
      );
    }
    if (gates.some((gate) => gate.verdict === "FAIL")) {
      findings.push(
        finding("externalGateFailed", `${requiredGate} returned FAIL`, requiredGate, "FAIL"),
      );
    }
  }

  return {
    ...assessmentFromFindings(findings),
    adventurerContributionMargin: cost.adventurerContributionMargin,
    costSummaries: cost.summaries,
    foreignExchangeUsdMicros: cost.foreignExchangeUsdMicros,
    freeCostPerActivePeriodUsdMicros: cost.freeCostPerActivePeriodUsdMicros,
    recoveryReservePerSecond: recoveryReserves.length === 0 ? null : Math.min(...recoveryReserves),
    stageSummaries: stages.summaries,
    taxesUsdMicros: cost.taxesUsdMicros,
  };
};

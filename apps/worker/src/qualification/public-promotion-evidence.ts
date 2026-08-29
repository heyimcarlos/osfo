import { Array, Order, Schema } from "effect";

import { qualificationChecksum } from "./qualification-checksum";
import type { ProductionQualificationManifest } from "./qualification-manifest";
import { parseEvidenceArtifact } from "./evidence-artifact";
import {
  ArtifactChecksum,
  EvidenceCount,
  QualificationId,
  QualificationUtcInstant,
} from "./evidence-primitives";
import type { QualificationRunEvidence } from "./qualification-runs";
import type { QualificationFinding } from "./verdict";
import { stageApplicableJourneys, stageObjectives } from "./stage-evidence";

const GrowthCorpusRecordBoundary = Schema.Struct({
  allowancePeriods: Schema.NullOr(Schema.Finite),
  measuredAtUtc: QualificationUtcInstant,
  queryVersion: QualificationId,
  registeredUsers: EvidenceCount,
  retainedRegisteredMessages: EvidenceCount,
  sourceSnapshotChecksum: ArtifactChecksum,
});
const GrowthCharacterizationResultBoundary = Schema.Struct({
  correctnessViolations: Schema.Array(
    Schema.Literals([
      "duplicateAuthority",
      "duplicateEffect",
      "ghostWork",
      "irreconcilableOutcome",
      "lostAcceptedWork",
      "orderingGap",
      "staleCommit",
      "strandedAcceptedWork",
      "unboundedAmplification",
    ]),
  ),
  corpusChecksum: ArtifactChecksum,
  failedQueries: EvidenceCount,
  maximumQueueDepth: EvidenceCount,
  queryP95Ms: Schema.Finite,
  successfulQueries: EvidenceCount,
});
const DailyBetaRecordBoundary = Schema.Struct({
  acceptedRegisteredMessages: EvidenceCount,
  acceptedRootIds: Schema.Array(QualificationId),
  authorityArtifactId: QualificationId,
  correctnessViolations: Schema.Array(QualificationId),
  dayStartedAtUtc: QualificationUtcInstant,
  errorBudgetRemaining: Schema.Finite,
  goodRootOutcomes: EvidenceCount,
  goodRootIds: Schema.Array(QualificationId),
  rollingSevenDayRatio: Schema.Finite,
  sourceVersion: QualificationId,
});
const BetaSloSplitBoundary = Schema.Struct({
  dayStartedAtUtc: QualificationUtcInstant,
  eligibleRoots: EvidenceCount,
  eligibleRootIds: Schema.Array(QualificationId),
  goodRootOutcomes: EvidenceCount,
  goodRootIds: Schema.Array(QualificationId),
  rollingSevenDayRatio: Schema.Finite,
  sourceArtifactId: QualificationId,
  sourceAuthorityFactIds: Schema.Array(QualificationId),
  sourceVersion: QualificationId,
  split: QualificationId,
});
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
const TraceReplacementRecordBoundary = Schema.Struct({
  acceptedRegisteredMessages: EvidenceCount,
  amplificationDistribution: Schema.Record(
    QualificationId,
    Schema.Struct({
      maximum: Schema.Finite,
      p50: Schema.Finite,
      p95: Schema.Finite,
      p99: Schema.Finite,
    }),
  ),
  coldCauseBasisPoints: Schema.Struct({
    deployment: Schema.Finite,
    faultRecovery: Schema.Finite,
    firstUse: Schema.Finite,
    idleEviction: Schema.Finite,
    warm: Schema.Finite,
  }),
  costUsdMicros: Schema.Struct({ p50: Schema.Finite, p95: Schema.Finite, p99: Schema.Finite }),
  geographyBasisPoints: Schema.Struct({
    americas: Schema.Finite,
    asiaPacific: Schema.Finite,
    europe: Schema.Finite,
  }),
  historyDepth: Schema.Struct({ p50: Schema.Finite, p95: Schema.Finite, p99: Schema.Finite }),
  journeyMix: Schema.Record(ReferenceJourneyBoundary, Schema.Finite),
  planMixBasisPoints: Schema.Struct({ adventurer: Schema.Finite, free: Schema.Finite }),
  productionDays: EvidenceCount,
});

const finding = (
  code: string,
  detail: string,
  subject: string,
  verdict: QualificationFinding["verdict"],
): QualificationFinding => ({ code, detail, subject, verdict });

const validUtc = (value: string): boolean =>
  value.endsWith("Z") && value.length > 0 && Number.isFinite(Date.parse(value));

const validPercentiles = (values: {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}): boolean => values.p50 >= 0 && values.p50 <= values.p95 && values.p95 <= values.p99;

const parseArtifact = parseEvidenceArtifact;

/** Exact rolling SLO dimensions required for every continued-beta UTC day. */
export const requiredContinuedBetaSplits = (
  manifest: ProductionQualificationManifest,
): ReadonlyArray<string> => {
  const dimensions = [
    ...manifest.regions.map((region) => `region:${region}`),
    "plan:free",
    "plan:adventurer",
    ...manifest.journeyMix.map(({ journey }) => `journey:${journey}`),
    "coldCause:firstUse",
    "coldCause:idleEviction",
    "coldCause:deployment",
    "coldCause:faultRecovery",
    ...manifest.providers.map((provider) => `provider:${provider}`),
  ];
  return [
    "admission",
    "scheduledTask",
    "workflow",
    ...stageObjectives.map(({ stage }) => `stage:${stage}`),
    ...dimensions,
    ...stageObjectives.flatMap(({ stage }) => {
      const applicableJourneys = stageApplicableJourneys(stage);
      return dimensions.flatMap((dimension) => {
        if (!dimension.startsWith("journey:") || applicableJourneys === null)
          return [`objective:${stage}|${dimension}`];
        const journey = dimension.slice("journey:".length);
        return applicableJourneys.some((candidate) => candidate === journey)
          ? [`objective:${stage}|${dimension}`]
          : [];
      });
    }),
  ];
};

const continuedBetaFloor = (manifest: ProductionQualificationManifest, split: string): number => {
  if (split === "admission" || split === "workflow") return 0.999;
  if (split === "scheduledTask") return 0.99;
  if (split.startsWith("stage:")) {
    return stageObjectives.find(({ stage }) => `stage:${stage}` === split)?.requiredRatio ?? 1;
  }
  if (split.startsWith("objective:")) {
    const stage = split.slice("objective:".length).split("|")[0];
    return stageObjectives.find((objective) => objective.stage === stage)?.requiredRatio ?? 1;
  }
  if (split.startsWith("journey:")) {
    return (
      manifest.journeyMix.find(({ journey }) => `journey:${journey}` === split)?.outcomeFloor ?? 1
    );
  }
  return 0.99;
};

/** Assess growth, public-promotion, and continued-beta evidence. */
export const assessPublicPromotionEvidence = (
  manifest: ProductionQualificationManifest,
  evidence: QualificationRunEvidence,
): ReadonlyArray<QualificationFinding> => {
  const findings: Array<QualificationFinding> = [];
  if ("growthCorpora" in manifest) {
    for (const corpus of manifest.growthCorpora) {
      const runs = evidence.growthCorpusRuns.filter((candidate) => candidate.kind === corpus.kind);
      if (runs.length > 1)
        findings.push(
          finding(
            "duplicateGrowthCorpusRun",
            `${corpus.kind} has ${runs.length} characterization records`,
            corpus.kind,
            "FAIL",
          ),
        );
      const run = runs[0];
      const corpusArtifact =
        run === undefined
          ? undefined
          : parseArtifact(
              run.corpusArtifact,
              GrowthCorpusRecordBoundary,
              `${corpus.kind}:corpus`,
              findings,
            );
      const corpusRecord = corpusArtifact?.records[0];
      const characterizationResult =
        run === undefined
          ? undefined
          : parseArtifact(
              run.characterizationResultArtifact,
              GrowthCharacterizationResultBoundary,
              `${corpus.kind}:characterization`,
              findings,
            );
      const resultRecord = characterizationResult?.records[0];
      if (
        run === undefined ||
        corpusArtifact === undefined ||
        characterizationResult === undefined ||
        run.characterizationArtifactId !== characterizationResult.artifactId ||
        run.corpusChecksum !== corpusArtifact.checksum ||
        run.registeredUsers !== corpus.registeredUsers ||
        run.retainedRegisteredMessages !== corpus.retainedRegisteredMessages ||
        run.allowancePeriods !== (corpus.allowancePeriods ?? null) ||
        corpusArtifact.records.length !== 1 ||
        corpusRecord === undefined ||
        characterizationResult.records.length !== 1 ||
        resultRecord === undefined ||
        resultRecord.corpusChecksum !== corpusArtifact.checksum ||
        resultRecord.successfulQueries < 1 ||
        resultRecord.correctnessViolations.length > 0 ||
        resultRecord.failedQueries > 0 ||
        resultRecord.queryP95Ms < 0 ||
        resultRecord.maximumQueueDepth < 0 ||
        corpusRecord.queryVersion.length === 0 ||
        corpusRecord.sourceSnapshotChecksum !==
          qualificationChecksum({
            allowancePeriods: corpusRecord.allowancePeriods,
            kind: run.kind,
            measuredAtUtc: corpusRecord.measuredAtUtc,
            queryVersion: corpusRecord.queryVersion,
            registeredUsers: corpusRecord.registeredUsers,
            retainedRegisteredMessages: corpusRecord.retainedRegisteredMessages,
          }) ||
        !validUtc(corpusRecord.measuredAtUtc) ||
        corpusRecord.registeredUsers !== corpus.registeredUsers ||
        corpusRecord.retainedRegisteredMessages !== corpus.retainedRegisteredMessages ||
        corpusRecord.allowancePeriods !== (corpus.allowancePeriods ?? null)
      ) {
        findings.push(
          finding(
            "growthCorpusCharacterizationMissing",
            `${corpus.kind} Growth Corpus has no complete characterization artifact`,
            corpus.kind,
            "MISSING",
          ),
        );
      }
    }
    if (
      evidence.publicPromotion === null ||
      evidence.publicPromotion.consecutiveBetaDays < 28 ||
      evidence.publicPromotion.acceptedRegisteredMessages < 25_000
    ) {
      findings.push(
        finding(
          "publicPromotionEvidenceInsufficient",
          "Public promotion requires 28 consecutive beta days and 25,000 accepted messages",
          "ScaleQualifiedPublic",
          "MISSING",
        ),
      );
    }
    const continued = evidence.continuedBeta;
    if (
      continued === null ||
      continued.rollingSevenDaySloArtifactId.length === 0 ||
      continued.errorBudget28DayArtifactId.length === 0
    ) {
      findings.push(
        finding(
          "continuedBetaEvidenceMissing",
          "Public promotion requires rolling seven-day SLO and 28-day error-budget evidence",
          "ScaleQualifiedPublic",
          "MISSING",
        ),
      );
    } else {
      const dailyEvidence = parseArtifact(
        continued.dailyEvidence,
        DailyBetaRecordBoundary,
        "continuedBeta:daily",
        findings,
      );
      if (dailyEvidence === undefined) return findings;
      const sloSplits = parseArtifact(
        continued.sloSplits,
        BetaSloSplitBoundary,
        "continuedBeta:sloSplits",
        findings,
      );
      if (sloSplits === undefined) return findings;
      const days = dailyEvidence.records;
      const expectedSplitIdentities = days.flatMap((day) =>
        requiredContinuedBetaSplits(manifest).map((split) => `${day.dayStartedAtUtc}:${split}`),
      );
      const observedSplitIdentities = sloSplits.records.map(
        (record) => `${record.dayStartedAtUtc}:${record.split}`,
      );
      const splitEvidenceInvalid =
        new Set(observedSplitIdentities).size !== observedSplitIdentities.length ||
        qualificationChecksum(
          Array.sortWith(observedSplitIdentities, (identity) => identity, Order.String),
        ) !==
          qualificationChecksum(
            Array.sortWith(expectedSplitIdentities, (identity) => identity, Order.String),
          ) ||
        sloSplits.records.some((record) => {
          const recordAt = Date.parse(record.dayStartedAtUtc);
          const rolling = sloSplits.records.filter((candidate) => {
            const candidateAt = Date.parse(candidate.dayStartedAtUtc);
            return (
              candidate.split === record.split &&
              candidateAt <= recordAt &&
              candidateAt >= recordAt - 6 * 86_400_000
            );
          });
          const rollingEligible = rolling.reduce(
            (total, candidate) => total + candidate.eligibleRoots,
            0,
          );
          const rollingGood = rolling.reduce(
            (total, candidate) => total + candidate.goodRootOutcomes,
            0,
          );
          const derivedRatio = rollingEligible === 0 ? 1 : rollingGood / rollingEligible;
          return (
            record.eligibleRoots < 1 ||
            record.eligibleRootIds.length !== record.eligibleRoots ||
            new Set(record.eligibleRootIds).size !== record.eligibleRootIds.length ||
            record.goodRootOutcomes < 0 ||
            record.goodRootIds.length !== record.goodRootOutcomes ||
            new Set(record.goodRootIds).size !== record.goodRootIds.length ||
            record.goodRootIds.some((rootId) => !record.eligibleRootIds.includes(rootId)) ||
            record.sourceArtifactId.length === 0 ||
            record.sourceAuthorityFactIds.length === 0 ||
            record.sourceVersion !== manifest.sourceVersion ||
            record.goodRootOutcomes > record.eligibleRoots ||
            record.rollingSevenDayRatio !== derivedRatio ||
            record.rollingSevenDayRatio < continuedBetaFloor(manifest, record.split)
          );
        });
      if (
        continued.rollingSevenDaySloArtifactId !== sloSplits.artifactId ||
        continued.errorBudget28DayArtifactChecksum !==
          qualificationChecksum({
            artifactId: continued.errorBudget28DayArtifactId,
            burnWindows: continued.burnWindows,
            dailyEvidenceChecksum: dailyEvidence.checksum,
            sloSplitsChecksum: sloSplits.checksum,
          }) ||
        splitEvidenceInvalid
      ) {
        findings.push(
          finding(
            "continuedBetaSplitEvidenceInvalid",
            "Continued beta does not retain every required rolling SLO split and error budget",
            "ScaleQualifiedPublic",
            "FAIL",
          ),
        );
      }
      const consecutive = days.every((day, index) => {
        if (!validUtc(day.dayStartedAtUtc)) return false;
        if (index === 0) return true;
        return (
          Date.parse(day.dayStartedAtUtc) - Date.parse(days[index - 1]?.dayStartedAtUtc ?? "") ===
          86_400_000
        );
      });
      const derivedAcceptedMessages = days.reduce(
        (total, day) => total + day.acceptedRegisteredMessages,
        0,
      );
      const invalidDailyEvidence = days.some((day, index) => {
        const rolling = days.slice(Math.max(0, index - 6), index + 1);
        const eligible = rolling.reduce(
          (total, candidate) => total + candidate.acceptedRegisteredMessages,
          0,
        );
        const good = rolling.reduce((total, candidate) => total + candidate.goodRootOutcomes, 0);
        return (
          !Number.isInteger(day.acceptedRegisteredMessages) ||
          day.acceptedRegisteredMessages < 0 ||
          day.acceptedRootIds.length !== day.acceptedRegisteredMessages ||
          new Set(day.acceptedRootIds).size !== day.acceptedRootIds.length ||
          !Number.isInteger(day.goodRootOutcomes) ||
          day.goodRootOutcomes < 0 ||
          day.goodRootIds.length !== day.goodRootOutcomes ||
          new Set(day.goodRootIds).size !== day.goodRootIds.length ||
          day.goodRootIds.some((rootId) => !day.acceptedRootIds.includes(rootId)) ||
          day.authorityArtifactId.length === 0 ||
          day.sourceVersion !== manifest.sourceVersion ||
          day.goodRootOutcomes > day.acceptedRegisteredMessages ||
          day.acceptedRegisteredMessages < 1 ||
          day.goodRootOutcomes / day.acceptedRegisteredMessages < 0.99 ||
          day.correctnessViolations.length > 0 ||
          day.errorBudgetRemaining < 0 ||
          day.errorBudgetRemaining > 1 ||
          day.rollingSevenDayRatio !== (eligible === 0 ? 1 : good / eligible) ||
          (index >= 6 && day.rollingSevenDayRatio < 0.99)
        );
      });
      if (
        days.length < 28 ||
        !consecutive ||
        invalidDailyEvidence ||
        continued.productionDays !== days.length ||
        continued.acceptedRegisteredMessages !== derivedAcceptedMessages ||
        evidence.publicPromotion?.consecutiveBetaDays !== days.length ||
        evidence.publicPromotion?.acceptedRegisteredMessages !== derivedAcceptedMessages
      ) {
        findings.push(
          finding(
            "continuedBetaDailyEvidenceInvalid",
            "Continued beta evidence is not derived from 28 consecutive UTC daily records",
            "ScaleQualifiedPublic",
            "FAIL",
          ),
        );
      }
      for (const window of ["1h", "6h", "3d", "28d"] as const) {
        const burns = continued.burnWindows.filter((burn) => burn.window === window);
        const burn = burns[0];
        if (burns.length !== 1 || burn === undefined || burn.artifactId.length === 0) {
          findings.push(
            finding(
              "burnWindowEvidenceMissing",
              `${window} has no unique burn-rate artifact`,
              window,
              burns.length > 1 ? "FAIL" : "MISSING",
            ),
          );
        } else if (
          !Number.isInteger(burn.eligibleRoots) ||
          !Number.isInteger(burn.badRoots) ||
          burn.eligibleRoots < 1 ||
          burn.badRoots < 0 ||
          burn.badRoots > burn.eligibleRoots ||
          burn.errorBudgetFraction <= 0 ||
          burn.maximumBurnRate <= 0 ||
          burn.measuredBurnRate !== burn.badRoots / burn.eligibleRoots / burn.errorBudgetFraction ||
          burn.verdict !== (burn.measuredBurnRate <= burn.maximumBurnRate ? "PASS" : "FAIL")
        ) {
          findings.push(
            finding(
              "burnWindowEvidenceInvalid",
              `${window} burn-rate verdict is not derived from its raw denominator and budget`,
              window,
              "FAIL",
            ),
          );
        } else if (burn.verdict === "FAIL") {
          findings.push(
            finding("burnWindowFailed", `${window} burn-rate evidence failed`, window, "FAIL"),
          );
        }
      }
      if (
        continued.productionDays >= 30 &&
        continued.acceptedRegisteredMessages >= 25_000 &&
        (continued.observedTraceReplacement === null ||
          continued.observedTraceReplacement.artifactId.length === 0 ||
          continued.observedTraceReplacement.checksum.length === 0)
      ) {
        findings.push(
          finding(
            "observedTraceReplacementMissing",
            "The assumed Reference Workload Trace was not replaced after its evidence threshold",
            "referenceWorkloadTrace",
            "MISSING",
          ),
        );
      } else if (continued.observedTraceReplacement !== null) {
        const replacement = continued.observedTraceReplacement;
        const traceArtifact = parseArtifact(
          replacement.traceArtifact,
          TraceReplacementRecordBoundary,
          "referenceWorkloadTrace",
          findings,
        );
        const record = traceArtifact?.records[0];
        const requiredAmplificationKeys = new Set(
          Object.values(manifest.semanticRequirements).flatMap((requirement) =>
            Object.keys(requirement.amplificationLimits),
          ),
        );
        const missingAmplification =
          record !== undefined &&
          [...requiredAmplificationKeys].some(
            (key) => !Object.hasOwn(record.amplificationDistribution, key),
          );
        if (missingAmplification) {
          findings.push(
            finding(
              "observedTraceAmplificationMissing",
              "Observed trace replacement omits a required amplification distribution",
              "referenceWorkloadTrace",
              "MISSING",
            ),
          );
        }
        if (
          traceArtifact === undefined ||
          traceArtifact.records.length !== 1 ||
          record === undefined ||
          replacement.artifactId !== traceArtifact.artifactId ||
          replacement.checksum !== traceArtifact.checksum ||
          traceArtifact.windowStartedAtUtc !== continued.dailyEvidence.windowStartedAtUtc ||
          traceArtifact.windowEndedAtUtc !== continued.dailyEvidence.windowEndedAtUtc ||
          replacement.productionDays !== continued.productionDays ||
          replacement.acceptedRegisteredMessages !== continued.acceptedRegisteredMessages ||
          replacement.productionDays < 30 ||
          replacement.acceptedRegisteredMessages < 25_000 ||
          record.productionDays !== replacement.productionDays ||
          record.acceptedRegisteredMessages !== replacement.acceptedRegisteredMessages ||
          Object.values(record.journeyMix).reduce((total, value) => total + value, 0) !== 100 ||
          Object.values(record.journeyMix).some((value) => value < 0) ||
          record.planMixBasisPoints.free + record.planMixBasisPoints.adventurer !== 10_000 ||
          Object.values(record.planMixBasisPoints).some((value) => value < 0) ||
          Object.values(record.geographyBasisPoints).reduce((total, value) => total + value, 0) !==
            10_000 ||
          Object.values(record.geographyBasisPoints).some((value) => value < 0) ||
          Object.values(record.coldCauseBasisPoints).reduce((total, value) => total + value, 0) !==
            10_000 ||
          Object.values(record.coldCauseBasisPoints).some((value) => value < 0) ||
          Object.values(record.amplificationDistribution).some(
            (value) => !validPercentiles(value) || value.maximum < value.p99,
          ) ||
          !validPercentiles(record.historyDepth) ||
          !validPercentiles(record.costUsdMicros)
        ) {
          findings.push(
            finding(
              "observedTraceReplacementInvalid",
              "Observed trace replacement is not derived from one complete dimension artifact",
              "referenceWorkloadTrace",
              "FAIL",
            ),
          );
        }
      }
    }
  }
  return findings;
};

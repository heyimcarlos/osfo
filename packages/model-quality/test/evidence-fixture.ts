import { assessHumanReview } from "../src/review";
import { initialCorpusManifest } from "../src/corpus";
import {
  configurationDigest,
  createEvaluationManifest,
  digestValue,
  parseEvidenceDigest,
  type BehaviorConfiguration,
} from "../src/manifest";
import { createReleasePass } from "../src/release-verdict";
import {
  createPairedPowerPlan,
  type CaseRunScores,
  type PairedPowerPlanInput,
} from "../src/statistics";
import { powerPlanSignature } from "./power-signatures";

const reviewedJourneys = [
  "ordinary",
  "memory",
  "file-analysis",
  "gmail",
  "research-report",
  "document-build",
  "scheduled-email",
] as const;

export const passingHumanReviewAssessment = () => {
  const safetyCases = initialCorpusManifest.cases.filter((item) => item.journey === "safety");
  return assessHumanReview(
    {
      adjudicatedDisagreements: 0,
      assessedAt: "2026-08-16T12:00:00.000Z",
      assessmentId: "human-assessment-1",
      authoredSafetyCases: safetyCases.map((item) => ({
        authorId: item.authorId,
        caseId: item.id,
        finalApproverId: item.finalApproverId,
      })),
      blinded: true,
      corpusDigest: initialCorpusManifest.contentDigest,
      disagreements: 0,
      journeyReviews: reviewedJourneys.map((journey) => {
        const reviewedCaseIds = initialCorpusManifest.cases
          .filter((item) => item.journey === journey)
          .slice(0, 20)
          .map((item) => item.id);
        return {
          doubleLabeledCaseIds: reviewedCaseIds,
          doubleLabeledCases: reviewedCaseIds.length,
          journey,
          reviewedCaseIds,
          reviewedCases: reviewedCaseIds.length,
          totalCases: initialCorpusManifest.cases.filter((item) => item.journey === journey).length,
        };
      }),
      reviewedSafetyCases: 160,
      reviewedSafetyCaseIds: safetyCases.map((item) => item.id),
      reviewAuthorityId: "human-review-owner-1",
      signature:
        "F/j444q1zeDT4y3NrB6biXjxagoQWfPXiOjYDfXB9bBz3p/XZE1XbaAH4aEB0hTFJpf361ZeUui6m2i69hrxAQ==",
      totalSafetyCases: 160,
    },
    initialCorpusManifest,
  );
};

export const testConfiguration = {
  context: digestValue("context", "context"),
  memory: digestValue("memory", "memory"),
  policies: digestValue("policies", "policies"),
  prompts: digestValue("prompts", "prompts"),
  rendering: digestValue("rendering", "rendering"),
  routes: digestValue("routes", "routes"),
  skills: digestValue("skills", "skills"),
  tools: digestValue("tools", "tools"),
  workflows: digestValue("workflows", "workflows"),
} satisfies BehaviorConfiguration;

export const testDependencyDigest = digestValue("dependency", "dependencies");
export const testGraderDigest = digestValue("grader", "graders");

const caseRuns = (score: number): ReadonlyArray<CaseRunScores> =>
  initialCorpusManifest.cases.map((item) => ({
    caseId: item.id,
    fixtureDigest:
      item.split === "sealed-holdout"
        ? item.fixture.contentDigest
        : digestValue("fixture", item.fixture),
    runs: Array.from({ length: item.repetitions }, () => score),
  }));

export const testProductionRuns = caseRuns(0.5);
export const testCandidateRuns = caseRuns(1);
const sealedCaseIds = new Set<string>(
  initialCorpusManifest.cases
    .filter((item) => item.split === "sealed-holdout")
    .map((item) => item.id),
);
const sealedRuns = (runs: ReadonlyArray<CaseRunScores>) =>
  runs.filter((item) => sealedCaseIds.has(item.caseId));

const developmentCases = initialCorpusManifest.cases.filter((item) => item.split === "development");

const pairedPlan = (
  caseIds: ReadonlyArray<string>,
  margin: number,
  pilotCases: typeof developmentCases,
) => {
  const pilotBaselineByCase = pilotCases.map((item) => ({
    caseId: item.id,
    fixtureDigest: digestValue("fixture", item.fixture),
    runs: Array.from({ length: item.repetitions }, () => 0),
  }));
  const pilotCandidateByCase = pilotCases.map((item, index) => ({
    caseId: item.id,
    fixtureDigest: digestValue("fixture", item.fixture),
    runs: Array.from({ length: item.repetitions }, () => (index < pilotCases.length * 0.8 ? 1 : 0)),
  }));
  const unsigned = {
    authorityId: "quality-power-owner-1",
    candidateEvaluationStartedAt: "2026-08-17T00:00:00.000Z",
    caseIds,
    corpusDigest: initialCorpusManifest.contentDigest,
    declaredAt: "2026-08-16T00:00:00.000Z",
    margin,
    pilotBaselineByCase,
    pilotCandidateByCase,
  } satisfies Omit<PairedPowerPlanInput, "signature">;
  const result = createPairedPowerPlan(
    {
      ...unsigned,
      signature: powerPlanSignature(unsigned),
    },
    initialCorpusManifest,
  );
  if (result.kind === "error") throw new Error(result.error.message);
  return result.value;
};

export const testOverallPairedEvidence = {
  baselineByCase: sealedRuns(testProductionRuns),
  candidateByCase: sealedRuns(testCandidateRuns),
  powerPlan: pairedPlan([...sealedCaseIds], 0.02, developmentCases.slice(0, 100)),
} as const;

export const testStratumPairedEvidence = reviewedJourneys.flatMap((journey) =>
  (["free", "adventurer"] as const).map((planRoute) => {
    const ids = initialCorpusManifest.cases
      .filter(
        (item) =>
          item.split === "sealed-holdout" &&
          item.journey === journey &&
          item.planRoute === planRoute,
      )
      .map((item) => item.id);
    const idSet = new Set<string>(ids);
    const pilotCases = developmentCases
      .filter((item) => item.journey === journey && item.planRoute === planRoute)
      .slice(0, 10);
    return {
      baselineByCase: testProductionRuns.filter((item) => idSet.has(item.caseId)),
      candidateByCase: testCandidateRuns.filter((item) => idSet.has(item.caseId)),
      journey,
      planRoute,
      powerPlan: pairedPlan(ids, 0.05, pilotCases),
    };
  }),
);
const parsedGateVerdictDigest = parseEvidenceDigest(
  "gate-verdict",
  "sha256:89a599407f7e9dcfd2fe3d4930a917c0c16af694531b347af095afab4480a6b8",
);
if (parsedGateVerdictDigest.kind === "error") throw new Error("Static gate digest is invalid.");
export const testGateVerdictDigest = parsedGateVerdictDigest.value;
export const testRubricDigest = digestValue("rubric", "rubric");
export const testPowerDigest = digestValue("power-calculation", {
  overall: testOverallPairedEvidence.powerPlan.contentDigest,
  strata: testStratumPairedEvidence.map((item) => ({
    journey: item.journey,
    planRoute: item.planRoute,
    powerPlanDigest: item.powerPlan.contentDigest,
  })),
});
export const testScoreDigest = digestValue("scores", {
  candidateRuns: testCandidateRuns,
  productionRuns: testProductionRuns,
});

export const passingEvaluationManifest = (overrides?: {
  readonly gateVerdictDigest?: typeof testGateVerdictDigest;
  readonly outputSignature?: string;
}) => {
  const humanReview = passingHumanReviewAssessment();
  const input = {
    approvedBaseline: {
      approvedAt: "2026-08-16T00:00:00.000Z",
      approverId: "quality-owner-1",
      corpusDigest: initialCorpusManifest.contentDigest,
      graderDigest: testGraderDigest,
      rubricDigest: testRubricDigest,
      signature:
        "QyGleZbqmUTzIPShcbL5zl/9wEQ2DQaaxCg5VbgtioFBSfG4kpv3sEZ1V2lnU08LlZIXEukhdrP9iQMQJx7oDw==",
    },
    configuration: testConfiguration,
    corpusDigest: initialCorpusManifest.contentDigest,
    corpusVersion: initialCorpusManifest.version,
    createdAt: "2026-08-17T00:00:00.000Z",
    dependencyDigest: testDependencyDigest,
    fixtureDigest: digestValue("fixture", "fixtures"),
    graderDigest: testGraderDigest,
    gateVerdictDigest: overrides?.gateVerdictDigest ?? testGateVerdictDigest,
    humanReviewDigest: humanReview.contentDigest,
    humanLabelSetVersion: "labels-v1",
    inferenceSettingsDigest: digestValue("inference-settings", "inference-settings"),
    manifestId: "evaluation-1",
    outputEvidence: {
      artifactChecksumsDigest: digestValue("artifact-checksums", "artifacts"),
      costDigest: digestValue("cost", "cost"),
      latencyDigest: digestValue("latency", "latency"),
      rawOutputsDigest: digestValue("raw-outputs", "outputs"),
      scoreDigest: testScoreDigest,
      tokenUseDigest: digestValue("token-use", "tokens"),
      traceDigest: digestValue("traces", "traces"),
      utcWindow: {
        endedAt: "2026-08-17T01:00:00.000Z",
        startedAt: "2026-08-17T00:00:00.000Z",
      },
    },
    outputSignature:
      overrides?.outputSignature ??
      "Jcte4rlE2Ra2bQXGEsfAGmCGClIJDGCZ3Qh351wndvBiysKX8SpLIFuu6LYsey9JqYeByQO6YAFd0RIE/NrFCw==",
    powerCalculationDigest: testPowerDigest,
    providerModelId: "pinned-model-2026-08-01",
    rubricDigest: testRubricDigest,
    releaseId: "release-1",
    sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
  };
  const result = createEvaluationManifest(input);
  if (result.kind === "error") throw new Error(result.error.message);
  return result.value;
};

export const testConfigurationDigest = configurationDigest(testConfiguration);

export const passingCurrentReleaseEvidence = {
  configurationDigest: testConfigurationDigest,
  corpusDigest: initialCorpusManifest.contentDigest,
  dependencyDigest: testDependencyDigest,
  graderDigest: testGraderDigest,
  now: "2026-08-17T01:00:00.000Z",
  rubricDigest: testRubricDigest,
} as const;

export const passingReleasePass = () => {
  const manifest = passingEvaluationManifest();
  const result = createReleasePass("release-1", manifest, manifest, passingCurrentReleaseEvidence);
  if (result.kind === "error") throw new Error(result.error.message);
  return result.value;
};

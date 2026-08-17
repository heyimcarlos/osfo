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

const reviewedJourneys = [
  "ordinary",
  "memory",
  "file-analysis",
  "gmail",
  "research-report",
  "document-build",
  "scheduled-email",
] as const;

export const passingHumanReviewAssessment = () =>
  assessHumanReview({
    adjudicatedDisagreements: 0,
    assessedAt: "2026-08-16T12:00:00.000Z",
    assessmentId: "human-assessment-1",
    authoredSafetyCases: Array.from({ length: 160 }, (_, index) => ({
      authorId: `author-${index}`,
      caseId: `safety-${index}`,
      finalApproverId: `approver-${index}`,
    })),
    blinded: true,
    disagreements: 0,
    journeyReviews: reviewedJourneys.map((journey) => ({
      doubleLabeledCases: 20,
      journey,
      reviewedCases: 20,
      totalCases: journey === "ordinary" || journey === "memory" ? 100 : 40,
    })),
    reviewedSafetyCases: 160,
    reviewAuthorityId: "human-review-owner-1",
    signature:
      "MxvWc7e7bZT1248qZVBy/6S8FGxA23X/6gqdGr15C4RmmQYlg+RAzsRScWHglqT27dq3VQyjir4KK7e9KkWoDA==",
    totalSafetyCases: 160,
  });

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
const parsedGateVerdictDigest = parseEvidenceDigest(
  "gate-verdict",
  "sha256:963698e9f52d547da228ca5b5cb58bda44e2abe93df31d4c3534a229801c3db0",
);
if (parsedGateVerdictDigest.kind === "error") throw new Error("Static gate digest is invalid.");
export const testGateVerdictDigest = parsedGateVerdictDigest.value;
export const testRubricDigest = digestValue("rubric", "rubric");
export const testPowerDigest = digestValue("power-calculation", "power-calculation");
export const testScoreDigest = digestValue("scores", "scores");

export const passingEvaluationManifest = (overrides?: {
  readonly gateVerdictDigest?: typeof testGateVerdictDigest;
  readonly outputSignature?: string;
}) => {
  const humanReview = passingHumanReviewAssessment();
  const result = createEvaluationManifest({
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
      "bRCt7b8hvA1j+RXFRi2QEkaZwtn5WzQbf/AMO4cDeM7DJlqFDx9EhRSeSLcnDR9jRrgpgbq/Zpt2Gj2hnSyWDg==",
    powerCalculationDigest: testPowerDigest,
    providerModelId: "pinned-model-2026-08-01",
    rubricDigest: testRubricDigest,
    sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
  });
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

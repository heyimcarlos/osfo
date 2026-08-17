import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";
import {
  assessPassCurrentness,
  configurationDigest,
  createEvaluationManifest,
  digestValue,
  evaluationOutputSigningDigest,
  type BehaviorConfiguration,
  verifyEvaluationManifest,
} from "../src/manifest";
import {
  passingHumanReviewAssessment,
  testGateVerdictDigest,
  testPowerDigest,
  testScoreDigest,
} from "./evidence-fixture";

const configuration = {
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

const dependencyDigest = digestValue("dependency", "dependencies");
const graderDigest = digestValue("grader", "graders");
const gateVerdictDigest = testGateVerdictDigest;
const rubricDigest = digestValue("rubric", "rubric");
const humanReview = passingHumanReviewAssessment();

describe("Model Quality evidence manifests", () => {
  it("creates an immutable, verifiable manifest bound to the complete configuration", () => {
    const input = {
      approvedBaseline: {
        approvedAt: "2026-08-16T00:00:00.000Z",
        approverId: "quality-owner-1",
        corpusDigest: initialCorpusManifest.contentDigest,
        graderDigest,
        rubricDigest,
        signature:
          "QyGleZbqmUTzIPShcbL5zl/9wEQ2DQaaxCg5VbgtioFBSfG4kpv3sEZ1V2lnU08LlZIXEukhdrP9iQMQJx7oDw==",
      },
      configuration,
      corpusDigest: initialCorpusManifest.contentDigest,
      corpusVersion: initialCorpusManifest.version,
      createdAt: "2026-08-17T00:00:00.000Z",
      dependencyDigest,
      fixtureDigest: digestValue("fixture", "fixtures"),
      graderDigest,
      gateVerdictDigest,
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
        "Z7WRr7vcjzUZpCWqfl8abnO4aVHMmA1PCMxS5I9ShD5TmH0c6pghsfjMxoXREmX3VG1YiIaPvru7GiG+Q3fLBg==",
      powerCalculationDigest: testPowerDigest,
      providerModelId: "pinned-model-2026-08-01",
      rubricDigest,
      releaseId: "release-1",
      sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
    };
    expect(evaluationOutputSigningDigest(input)).toBe(
      "sha256:b0b14cdf7e80e60dd2231174638d7cb2fb6b290f712d018c65534e452f420c7e",
    );
    const result = createEvaluationManifest(input);

    expect(result.kind).toBe("success");
    if (result.kind === "error") return;
    const manifest = result.value;

    expect(manifest.configurationDigest).toBe(configurationDigest(configuration));
    expect(manifest.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyEvaluationManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.approvedBaseline)).toBe(true);
    expect(Object.isFrozen(manifest.configuration)).toBe(true);

    const { contentDigest: ignoredDigest, ...validUnsigned } = manifest;
    expect(ignoredDigest).toBe(manifest.contentDigest);
    const tamperedUnsigned = {
      ...validUnsigned,
      outputEvidence: {
        ...validUnsigned.outputEvidence,
        utcWindow: { ...validUnsigned.outputEvidence.utcWindow, endedAt: "invalid" },
      },
    };
    expect(
      verifyEvaluationManifest({
        ...tamperedUnsigned,
        contentDigest: digestValue("manifest", tamperedUnsigned),
      }),
    ).toBe(false);

    const forgedUnsigned = {
      ...validUnsigned,
      outputEvidence: {
        ...validUnsigned.outputEvidence,
        scoreDigest: digestValue("scores", "forged-scores"),
      },
    };
    expect(
      verifyEvaluationManifest({
        ...forgedUnsigned,
        contentDigest: digestValue("manifest", forgedUnsigned),
      }),
    ).toBe(false);

    const forgedConfigurationDigest = {
      ...validUnsigned,
      configurationDigest: digestValue("configuration", "caller-derived-value"),
    };
    expect(
      verifyEvaluationManifest({
        ...forgedConfigurationDigest,
        contentDigest: digestValue("manifest", forgedConfigurationDigest),
      }),
    ).toBe(false);
  });

  it("rejects a self-attested baseline without product approval authority", () => {
    const input = makeManifestInput();
    expect(
      createEvaluationManifest({
        ...input,
        approvedBaseline: { ...input.approvedBaseline, approverId: "self-attested-caller" },
      }),
    ).toMatchObject({
      error: { _tag: "InvalidBaselineApproval" },
      kind: "error",
    });
  });

  it("rejects invalid or reversed evidence windows", () => {
    const input = makeManifestInput();
    expect(
      createEvaluationManifest({
        ...input,
        outputEvidence: {
          ...input.outputEvidence,
          utcWindow: {
            endedAt: "2026-08-17T00:00:00.000Z",
            startedAt: "2026-08-17T01:00:00.000Z",
          },
        },
      }),
    ).toMatchObject({ error: { _tag: "InvalidBaselineApproval" }, kind: "error" });
  });

  it("rejects unsigned or post-evaluation baseline approval claims", () => {
    const input = makeManifestInput();
    expect(
      createEvaluationManifest({
        ...input,
        approvedBaseline: { ...input.approvedBaseline, signature: "not-a-signature" },
      }),
    ).toMatchObject({ error: { _tag: "InvalidBaselineApproval" }, kind: "error" });
    expect(
      createEvaluationManifest({
        ...input,
        approvedBaseline: {
          ...input.approvedBaseline,
          approvedAt: "2026-08-18T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ error: { _tag: "InvalidBaselineApproval" }, kind: "error" });
  });

  it("invalidates PASS after seven days or any material evidence change", () => {
    const common = {
      currentConfigurationDigest: configurationDigest(configuration),
      currentCorpusDigest: initialCorpusManifest.contentDigest,
      currentDependencyDigest: dependencyDigest,
      currentGraderDigest: graderDigest,
      currentRubricDigest: rubricDigest,
      passConfigurationDigest: configurationDigest(configuration),
      passCorpusDigest: initialCorpusManifest.contentDigest,
      passDependencyDigest: dependencyDigest,
      passGraderDigest: graderDigest,
      passRubricDigest: rubricDigest,
      passedAt: "2026-08-10T12:00:00.000Z",
    } as const;

    expect(assessPassCurrentness({ ...common, now: "2026-08-17T12:00:00.000Z" })).toBe("PASS");
    expect(assessPassCurrentness({ ...common, now: "2026-08-17T12:00:00.001Z" })).toBe("MISSING");
    expect(
      assessPassCurrentness({
        ...common,
        currentConfigurationDigest: digestValue("configuration", "material-change"),
        now: "2026-08-11T12:00:00.000Z",
      }),
    ).toBe("MISSING");
  });

  it("keeps non-finite numeric evidence distinct from null and each other", () => {
    expect(
      new Set([
        digestValue("manifest", null),
        digestValue("manifest", Number.NaN),
        digestValue("manifest", Infinity),
      ]).size,
    ).toBe(3);
  });
});

const makeManifestInput = () => ({
  approvedBaseline: {
    approvedAt: "2026-08-16T00:00:00.000Z",
    approverId: "quality-owner-1",
    corpusDigest: initialCorpusManifest.contentDigest,
    graderDigest,
    rubricDigest,
    signature:
      "QyGleZbqmUTzIPShcbL5zl/9wEQ2DQaaxCg5VbgtioFBSfG4kpv3sEZ1V2lnU08LlZIXEukhdrP9iQMQJx7oDw==",
  },
  configuration,
  corpusDigest: initialCorpusManifest.contentDigest,
  corpusVersion: initialCorpusManifest.version,
  createdAt: "2026-08-17T00:00:00.000Z",
  dependencyDigest,
  fixtureDigest: digestValue("fixture", "fixtures"),
  graderDigest,
  gateVerdictDigest,
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
    "Z7WRr7vcjzUZpCWqfl8abnO4aVHMmA1PCMxS5I9ShD5TmH0c6pghsfjMxoXREmX3VG1YiIaPvru7GiG+Q3fLBg==",
  powerCalculationDigest: testPowerDigest,
  providerModelId: "pinned-model-2026-08-01",
  rubricDigest,
  releaseId: "release-1",
  sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
});

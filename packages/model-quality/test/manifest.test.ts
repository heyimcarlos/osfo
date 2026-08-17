import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";
import {
  assessPassCurrentness,
  configurationDigest,
  createEvaluationManifest,
  digestValue,
  type BehaviorConfiguration,
  verifyEvaluationManifest,
} from "../src/manifest";

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
const rubricDigest = digestValue("rubric", "rubric");

describe("Model Quality evidence manifests", () => {
  it("creates an immutable, verifiable manifest bound to the complete configuration", () => {
    const result = createEvaluationManifest({
      approvedBaseline: {
        approvedAt: "2026-08-16T00:00:00.000Z",
        approverId: "quality-owner-1",
        corpusDigest: initialCorpusManifest.contentDigest,
        graderDigest,
        rubricDigest,
      },
      configuration,
      corpusDigest: initialCorpusManifest.contentDigest,
      corpusVersion: initialCorpusManifest.version,
      createdAt: "2026-08-17T00:00:00.000Z",
      dependencyDigest,
      fixtureDigest: digestValue("fixture", "fixtures"),
      graderDigest,
      humanLabelSetVersion: "labels-v1",
      inferenceSettingsDigest: digestValue("inference-settings", "inference-settings"),
      outputEvidence: {
        artifactChecksumsDigest: digestValue("artifact-checksums", "artifacts"),
        costDigest: digestValue("cost", "cost"),
        latencyDigest: digestValue("latency", "latency"),
        rawOutputsDigest: digestValue("raw-outputs", "outputs"),
        scoreDigest: digestValue("scores", "scores"),
        tokenUseDigest: digestValue("token-use", "tokens"),
        traceDigest: digestValue("traces", "traces"),
        utcWindow: {
          endedAt: "2026-08-17T01:00:00.000Z",
          startedAt: "2026-08-17T00:00:00.000Z",
        },
      },
      powerCalculationDigest: digestValue("power-calculation", "power-calculation"),
      providerModelId: "pinned-model-2026-08-01",
      rubricDigest,
      sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "error") return;
    const manifest = result.value;

    expect(manifest.configurationDigest).toBe(configurationDigest(configuration));
    expect(manifest.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyEvaluationManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.approvedBaseline)).toBe(true);
    expect(Object.isFrozen(manifest.configuration)).toBe(true);
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
  },
  configuration,
  corpusDigest: initialCorpusManifest.contentDigest,
  corpusVersion: initialCorpusManifest.version,
  createdAt: "2026-08-17T00:00:00.000Z",
  dependencyDigest,
  fixtureDigest: digestValue("fixture", "fixtures"),
  graderDigest,
  humanLabelSetVersion: "labels-v1",
  inferenceSettingsDigest: digestValue("inference-settings", "inference-settings"),
  outputEvidence: {
    artifactChecksumsDigest: digestValue("artifact-checksums", "artifacts"),
    costDigest: digestValue("cost", "cost"),
    latencyDigest: digestValue("latency", "latency"),
    rawOutputsDigest: digestValue("raw-outputs", "outputs"),
    scoreDigest: digestValue("scores", "scores"),
    tokenUseDigest: digestValue("token-use", "tokens"),
    traceDigest: digestValue("traces", "traces"),
    utcWindow: {
      endedAt: "2026-08-17T01:00:00.000Z",
      startedAt: "2026-08-17T00:00:00.000Z",
    },
  },
  powerCalculationDigest: digestValue("power-calculation", "power-calculation"),
  providerModelId: "pinned-model-2026-08-01",
  rubricDigest,
  sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
});

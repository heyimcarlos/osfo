import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";
import {
  assessPassCurrentness,
  configurationDigest,
  createEvaluationManifest,
  type BehaviorConfiguration,
  verifyEvaluationManifest,
} from "../src/manifest";

const configuration = {
  context: "sha256:context",
  memory: "sha256:memory",
  policies: "sha256:policies",
  prompts: "sha256:prompts",
  rendering: "sha256:rendering",
  routes: "sha256:routes",
  skills: "sha256:skills",
  tools: "sha256:tools",
  workflows: "sha256:workflows",
} satisfies BehaviorConfiguration;

describe("Model Quality evidence manifests", () => {
  it("creates an immutable, verifiable manifest bound to the complete configuration", () => {
    const manifest = createEvaluationManifest({
      configuration,
      corpusDigest: initialCorpusManifest.contentDigest,
      corpusVersion: initialCorpusManifest.version,
      createdAt: "2026-08-17T00:00:00.000Z",
      dependencyDigest: "sha256:dependencies",
      fixtureDigest: "sha256:fixtures",
      graderDigest: "sha256:graders",
      humanLabelSetVersion: "labels-v1",
      inferenceSettingsDigest: "sha256:inference-settings",
      outputEvidence: {
        artifactChecksumsDigest: "sha256:artifacts",
        costDigest: "sha256:cost",
        latencyDigest: "sha256:latency",
        rawOutputsDigest: "sha256:outputs",
        scoreDigest: "sha256:scores",
        tokenUseDigest: "sha256:tokens",
        traceDigest: "sha256:traces",
        utcWindow: {
          endedAt: "2026-08-17T01:00:00.000Z",
          startedAt: "2026-08-17T00:00:00.000Z",
        },
      },
      powerCalculationDigest: "sha256:power-calculation",
      providerModelId: "pinned-model-2026-08-01",
      sourceCommit: "45e5d1743701911dc05ed8998702a3fac77a61c3",
    });

    expect(manifest.configurationDigest).toBe(configurationDigest(configuration));
    expect(manifest.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyEvaluationManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.configuration)).toBe(true);
  });

  it("invalidates PASS after seven days or any material evidence change", () => {
    const common = {
      currentConfigurationDigest: configurationDigest(configuration),
      currentCorpusDigest: initialCorpusManifest.contentDigest,
      currentDependencyDigest: "sha256:dependencies",
      currentGraderDigest: "sha256:graders",
      passConfigurationDigest: configurationDigest(configuration),
      passCorpusDigest: initialCorpusManifest.contentDigest,
      passDependencyDigest: "sha256:dependencies",
      passGraderDigest: "sha256:graders",
      passedAt: "2026-08-10T12:00:00.000Z",
    } as const;

    expect(assessPassCurrentness({ ...common, now: "2026-08-17T12:00:00.000Z" })).toBe("PASS");
    expect(assessPassCurrentness({ ...common, now: "2026-08-17T12:00:00.001Z" })).toBe("MISSING");
    expect(
      assessPassCurrentness({
        ...common,
        currentConfigurationDigest: "sha256:material-change",
        now: "2026-08-11T12:00:00.000Z",
      }),
    ).toBe("MISSING");
  });
});

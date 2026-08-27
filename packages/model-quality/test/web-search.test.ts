import { describe, expect, it } from "@effect/vitest";

import { ModelQualityTooling } from "../src";
import type { DeterministicTrace } from "../src/deterministic";

const cases = [
  {
    allowedToolNames: ["webSearch"],
    id: "ordinary-current-lookup",
    observedToolName: "webSearch",
    visibleToolNames: ["loadSkill", "webSearch"],
  },
  {
    allowedToolNames: ["readWebPage"],
    id: "ordinary-selected-page-follow-up",
    observedToolName: "readWebPage",
    visibleToolNames: ["loadSkill", "readWebPage"],
  },
  {
    allowedToolNames: ["startWorkflow"],
    id: "durable-multi-search-report",
    observedToolName: "startWorkflow",
    visibleToolNames: ["loadSkill", "startWorkflow"],
  },
  {
    allowedToolNames: [],
    id: "unrelated-conversation",
    observedToolName: null,
    visibleToolNames: ["loadSkill"],
  },
] as const;

describe("ordinary public-web Model Quality cases", () => {
  it("chooses interactive search, selected-page reading, or Research Report without unrelated Tools", () => {
    for (const qualityCase of cases) {
      const result = ModelQualityTooling.gradeDeterministicTrace(traceFor(qualityCase));

      expect(
        result.results.filter(
          ({ graderId }) => graderId === "tool-choice" || graderId === "tool-arguments",
        ),
      ).toEqual([
        { graderId: "tool-choice", verdict: "PASS" },
        { graderId: "tool-arguments", verdict: "PASS" },
      ]);
      expect(qualityCase.visibleToolNames.filter((name) => name !== "loadSkill")).toEqual(
        qualityCase.allowedToolNames,
      );
    }
  });

  it("rejects ordinary search as the Tool choice for a durable multi-search artifact", () => {
    const researchCase = cases[2];
    const result = ModelQualityTooling.gradeDeterministicTrace(
      traceFor({ ...researchCase, observedToolName: "webSearch" }),
    );

    expect(result.results.find(({ graderId }) => graderId === "tool-choice")).toEqual({
      graderId: "tool-choice",
      verdict: "FAIL",
    });
  });
});

const traceFor = (qualityCase: {
  readonly allowedToolNames: ReadonlyArray<string>;
  readonly observedToolName: string | null;
}): DeterministicTrace => ({
  approval: { granted: true, required: false },
  artifact: { required: false, valid: true },
  authority: "preserved",
  authorityChangingPromptInjection: false,
  citations: { citedSourceIds: [], requiredSourceIds: [] },
  expectedTool:
    qualityCase.allowedToolNames.length === 0
      ? null
      : { allowedNames: qualityCase.allowedToolNames, argumentsDigest: "sha256:bounded-web-input" },
  externalEffects: [],
  fabricatedEvidence: false,
  observedEvidence: [],
  observedTool:
    qualityCase.observedToolName === null
      ? null
      : { argumentsDigest: "sha256:bounded-web-input", name: qualityCase.observedToolName },
  requiredEvidence: [],
  retrievals: [],
  secretDisclosure: false,
});

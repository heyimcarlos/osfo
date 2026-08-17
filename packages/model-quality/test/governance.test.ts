import { describe, expect, it } from "@effect/vitest";

import { createCorpusVersion, initialCorpusManifest } from "../src/corpus";

describe("Model Quality corpus governance", () => {
  it("does not remove a known failing case to make a candidate pass", () => {
    const result = createCorpusVersion({
      cases: initialCorpusManifest.cases.filter((item) => item.id !== "ordinary-001"),
      createdAt: "2026-08-18T00:00:00.000Z",
      knownFailingCaseIds: ["ordinary-001"],
      previous: initialCorpusManifest,
      safetyApprovals: [],
      version: "model-quality-v2",
    });
    expect(result).toEqual({
      error: {
        _tag: "InvalidCorpusChange",
        message: "Known failing case ordinary-001 cannot be removed.",
      },
      kind: "error",
    });
  });

  it("links and deeply freezes an approved successor manifest", () => {
    const firstCase = initialCorpusManifest.cases[0];
    if (firstCase === undefined) throw new Error("Initial corpus requires a first case.");
    if (firstCase.split !== "development")
      throw new Error("First case must be a development case.");
    const copiedFirstCase = {
      ...firstCase,
      fixture: { ...firstCase.fixture, thread: [...firstCase.fixture.thread] },
    };
    const result = createCorpusVersion({
      cases: [copiedFirstCase, ...initialCorpusManifest.cases.slice(1)],
      createdAt: "2026-08-18T00:00:00.000Z",
      knownFailingCaseIds: [],
      previous: initialCorpusManifest,
      safetyApprovals: [],
      version: "model-quality-v2",
    });
    if (result.kind === "error") throw new Error(result.error.message);

    expect(result.value.previousVersion).toBe("model-quality-v1");
    expect(result.value.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.cases)).toBe(true);
    const firstResultCase = result.value.cases[0];
    expect(
      firstResultCase?.split === "development" && Object.isFrozen(firstResultCase.fixture.thread),
    ).toBe(true);
  });

  it("rejects a changed safety case without recorded independent approval", () => {
    const safetyCase = initialCorpusManifest.cases.find((item) => item.journey === "safety");
    if (safetyCase === undefined) throw new Error("Initial corpus requires a safety case.");
    if (safetyCase.split !== "development")
      throw new Error("First safety case must be development.");
    const changed = {
      ...safetyCase,
      fixture: { ...safetyCase.fixture, expectedOutcomes: ["changed outcome"] },
    };
    const result = createCorpusVersion({
      cases: initialCorpusManifest.cases.map((item) => (item.id === changed.id ? changed : item)),
      createdAt: "2026-08-18T00:00:00.000Z",
      knownFailingCaseIds: [],
      previous: initialCorpusManifest,
      safetyApprovals: [],
      version: "model-quality-v2",
    });
    expect(result).toEqual({
      error: {
        _tag: "InvalidCorpusChange",
        message: `Safety case ${changed.id} requires recorded independent approval.`,
      },
      kind: "error",
    });
  });
});

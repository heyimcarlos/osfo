import { describe, expect, it } from "@effect/vitest";

import {
  createCorpusVersion,
  initialCorpusManifest,
  parseCorpusManifest,
  verifyCorpusManifest,
} from "../src/corpus";
import { digestValue } from "../src/manifest";

describe("Model Quality corpus governance", () => {
  it("rejects a caller-rehashed manifest that relabels a development fixture as holdout", () => {
    const developmentCase = initialCorpusManifest.cases.find(
      (item) => item.split === "development",
    );
    if (developmentCase?.split !== "development") throw new Error("Development case required.");
    const relabelledContents = {
      ...initialCorpusManifest,
      cases: [
        {
          ...developmentCase,
          split: "sealed-holdout" as const,
        },
        ...initialCorpusManifest.cases.slice(1),
      ],
    };
    const { contentDigest: ignoredDigest, ...unsigned } = relabelledContents;
    expect(ignoredDigest).toBe(initialCorpusManifest.contentDigest);
    const relabelled = { ...unsigned, contentDigest: digestValue("corpus", unsigned) };
    expect(parseCorpusManifest(relabelled, null)).toMatchObject({
      error: { _tag: "InvalidCorpusManifest" },
      kind: "error",
    });
  });

  it("rejects a caller-rehashed replacement of the product-owned root fixture", () => {
    const firstCase = initialCorpusManifest.cases[0];
    if (firstCase?.split !== "development") throw new Error("Development case required.");
    const unsigned = {
      ...initialCorpusManifest,
      cases: [
        { ...firstCase, fixture: { ...firstCase.fixture, prompt: "caller replacement" } },
        ...initialCorpusManifest.cases.slice(1),
      ],
    };
    const { contentDigest: ignoredDigest, ...contents } = unsigned;
    expect(ignoredDigest).toBe(initialCorpusManifest.contentDigest);
    expect(
      parseCorpusManifest({ ...contents, contentDigest: digestValue("corpus", contents) }, null),
    ).toMatchObject({ error: { _tag: "InvalidCorpusManifest" }, kind: "error" });
    expect(
      verifyCorpusManifest({ ...contents, contentDigest: digestValue("corpus", contents) }),
    ).toBe(false);
  });

  it("does not remove a known failing case to make a candidate pass", () => {
    const result = createCorpusVersion({
      cases: initialCorpusManifest.cases.filter((item) => item.id !== "ordinary-001"),
      createdAt: "2026-08-18T00:00:00.000Z",
      newlyFailingCaseIds: ["ordinary-001"],
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
      newlyFailingCaseIds: [],
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

  it("accepts a valid successor whose direct predecessor is itself a successor", () => {
    const second = createCorpusVersion({
      cases: initialCorpusManifest.cases,
      createdAt: "2026-08-18T00:00:00.000Z",
      newlyFailingCaseIds: [],
      previous: initialCorpusManifest,
      safetyApprovals: [],
      version: "model-quality-v2",
    });
    if (second.kind === "error") throw new Error(second.error.message);
    expect(verifyCorpusManifest(second.value)).toBe(false);
    expect(verifyCorpusManifest(second.value, initialCorpusManifest)).toBe(true);
    const third = createCorpusVersion({
      cases: second.value.cases,
      createdAt: "2026-08-19T00:00:00.000Z",
      newlyFailingCaseIds: [],
      previous: second.value,
      safetyApprovals: [],
      version: "model-quality-v3",
    });
    expect(third.kind).toBe("success");
  });

  it("rejects a changed safety case without recorded independent approval", () => {
    const safetyCase = initialCorpusManifest.cases.find((item) => item.journey === "safety");
    if (safetyCase === undefined) throw new Error("Initial corpus requires a safety case.");
    if (safetyCase.split !== "development")
      throw new Error("First safety case must be development.");
    const changed = {
      ...safetyCase,
      fixture: {
        ...safetyCase.fixture,
        expectedOutcomes: [{ assertionId: "changed", expected: "changed outcome" }],
      },
    };
    const result = createCorpusVersion({
      cases: initialCorpusManifest.cases.map((item) => (item.id === changed.id ? changed : item)),
      createdAt: "2026-08-18T00:00:00.000Z",
      newlyFailingCaseIds: [],
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

  it("rejects safety approval identities that do not match the changed case", () => {
    const safetyCase = initialCorpusManifest.cases.find(
      (item) => item.journey === "safety" && item.split === "development",
    );
    if (safetyCase?.split !== "development") throw new Error("Safety fixture is required.");
    const changed = {
      ...safetyCase,
      fixture: {
        ...safetyCase.fixture,
        expectedOutcomes: [{ assertionId: "changed", expected: "changed outcome" }],
      },
    };
    expect(
      createCorpusVersion({
        cases: initialCorpusManifest.cases.map((item) => (item.id === changed.id ? changed : item)),
        createdAt: "2026-08-18T00:00:00.000Z",
        newlyFailingCaseIds: [],
        previous: initialCorpusManifest,
        safetyApprovals: [
          {
            authorId: "different-author",
            caseId: changed.id,
            finalApproverId: changed.finalApproverId,
          },
        ],
        version: "model-quality-v2",
      }),
    ).toMatchObject({ error: { _tag: "InvalidCorpusChange" }, kind: "error" });
  });

  it("carries known failures forward so a later caller cannot omit them", () => {
    const marked = createCorpusVersion({
      cases: initialCorpusManifest.cases,
      createdAt: "2026-08-18T00:00:00.000Z",
      newlyFailingCaseIds: ["ordinary-001"],
      previous: initialCorpusManifest,
      safetyApprovals: [],
      version: "model-quality-v2",
    });
    if (marked.kind === "error") throw new Error(marked.error.message);
    const removal = createCorpusVersion({
      cases: marked.value.cases.filter((item) => item.id !== "ordinary-001"),
      createdAt: "2026-08-19T00:00:00.000Z",
      newlyFailingCaseIds: [],
      previous: marked.value,
      safetyApprovals: [],
      version: "model-quality-v3",
    });
    expect(removal).toMatchObject({ error: { _tag: "InvalidCorpusChange" }, kind: "error" });
  });
});

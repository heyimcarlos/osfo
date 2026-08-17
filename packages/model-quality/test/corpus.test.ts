import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";

describe("initial Model Quality corpus", () => {
  it("freezes the exact 600-case composition and a 20% sealed holdout per class", () => {
    const journeys = [
      "document-build",
      "file-analysis",
      "gmail",
      "memory",
      "ordinary",
      "research-report",
      "safety",
      "scheduled-email",
    ] as const;

    expect(
      Object.fromEntries(
        journeys.map((journey) => [
          journey,
          initialCorpusManifest.cases.filter((item) => item.journey === journey).length,
        ]),
      ),
    ).toEqual({
      "document-build": 40,
      "file-analysis": 60,
      gmail: 60,
      memory: 100,
      ordinary: 100,
      "research-report": 40,
      safety: 160,
      "scheduled-email": 40,
    });
    expect(
      Object.fromEntries(
        journeys.map((journey) => [
          journey,
          initialCorpusManifest.cases.filter(
            (item) => item.journey === journey && item.split === "sealed-holdout",
          ).length,
        ]),
      ),
    ).toEqual({
      "document-build": 8,
      "file-analysis": 12,
      gmail: 12,
      memory: 20,
      ordinary: 20,
      "research-report": 8,
      safety: 32,
      "scheduled-email": 8,
    });
    expect(initialCorpusManifest.cases).toHaveLength(600);
    expect(initialCorpusManifest.cases[0]?.repetitions).toBe(3);
    expect(initialCorpusManifest.cases.find((item) => item.journey === "safety")?.repetitions).toBe(
      5,
    );
    expect(Object.isFrozen(initialCorpusManifest)).toBe(true);
    expect(Object.isFrozen(initialCorpusManifest.cases)).toBe(true);
    expect(Object.isFrozen(initialCorpusManifest.cases[0]?.fixture)).toBe(true);
    const developmentCase = initialCorpusManifest.cases.find(
      (item) => item.split === "development",
    );
    expect(developmentCase?.split).toBe("development");
    if (developmentCase?.split !== "development") return;
    expect(developmentCase.fixture.knowledgeSources[0]?.content).toContain("is due on");
    expect(developmentCase.fixture.providerFixtures[0]?.request.caseId).toBe(developmentCase.id);
    expect(developmentCase.fixture.toolDefinitions[0]?.inputSchema.idempotencyKey).toBe("string");
    const secretCase = initialCorpusManifest.cases.find(
      (item) =>
        item.split === "development" && item.journey === "safety" && item.riskClass === "secrets",
    );
    expect(secretCase?.split).toBe("development");
    if (secretCase?.split !== "development") return;
    expect(secretCase.fixture.knowledgeSources[0]?.content).toContain("OSFO_TEST_SECRET");
    const gmailCase = initialCorpusManifest.cases.find(
      (item) => item.split === "development" && item.journey === "gmail",
    );
    expect(gmailCase?.split).toBe("development");
    if (gmailCase?.split !== "development") return;
    expect(gmailCase.fixture.providerFixtures[0]?.request.recipient).toContain("@example.test");
    const sealedCase = initialCorpusManifest.cases.find((item) => item.split === "sealed-holdout");
    expect(sealedCase?.fixture).toMatchObject({ kind: "sealed-reference" });
    expect(sealedCase?.fixture).not.toHaveProperty("thread");
    expect(
      initialCorpusManifest.cases
        .filter((item) => item.journey === "safety")
        .every((item) => item.authorId !== item.finalApproverId),
    ).toBe(true);
  });
});

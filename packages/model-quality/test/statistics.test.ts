import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";
import { digestValue } from "../src/manifest";

import {
  createPairedPowerPlan,
  exactBinomialUpperBound,
  pairedNonInferiority,
  requiredPairedCaseCount,
  type PairedPowerPlanInput,
} from "../src/statistics";
import { powerPlanSignature } from "./power-signatures";

describe("Model Quality statistics", () => {
  it("calculates one-sided exact-binomial upper confidence bounds", () => {
    expect(exactBinomialUpperBound({ confidence: 0.95, failures: 0, total: 299 })).toEqual({
      kind: "success",
      value: expect.closeTo(0.009969146792899269, 12),
    });
    expect(exactBinomialUpperBound({ confidence: 0.95, failures: 0, total: 298 })).toEqual({
      kind: "success",
      value: expect.closeTo(0.010002432437677691, 12),
    });
    expect(exactBinomialUpperBound({ confidence: 0.95, failures: 2, total: 100 })).toEqual({
      kind: "success",
      value: expect.closeTo(0.06161920039604069, 12),
    });
  });

  it("predeclares paired independent-case power and reports underpowered evidence as MISSING", () => {
    expect(
      requiredPairedCaseCount({
        anticipatedDifference: 0,
        discordanceRate: 0.1,
        margin: 0.02,
        pilotIndependentCases: 100,
        secondMoment: 0.1,
      }),
    ).toEqual({ kind: "success", value: 2163 });

    expect(
      pairedNonInferiority({
        baselineByCase: caseScores([1, 1, 0, 1]),
        candidateByCase: caseScores([1, 1, 0, 1]),
        corpusManifest: initialCorpusManifest,
        powerPlan: powerPlan(4, { discordanceRate: 0.1, margin: 0.02 }),
      }),
    ).toMatchObject({
      independentCases: 4,
      kind: "success",
      requiredCases: 541,
      verdict: "MISSING",
    });
  });

  it("keeps repeated runs clustered under their independent case", () => {
    expect(
      pairedNonInferiority({
        baselineByCase: caseScores(Array.from({ length: 102 }, () => 1)),
        candidateByCase: caseScores(Array.from({ length: 102 }, () => 1)),
        corpusManifest: initialCorpusManifest,
        powerPlan: powerPlan(102, { discordanceRate: 0, margin: 0.05 }),
      }),
    ).toEqual({
      difference: 0,
      independentCases: 102,
      kind: "success",
      lowerConfidenceBound: 0,
      requiredCases: 102,
      verdict: "PASS",
    });
  });

  it("returns a tagged error when paired case identities do not match", () => {
    const first = sealedCases[0];
    const second = sealedCases[1];
    if (first?.split !== "sealed-holdout" || second?.split !== "sealed-holdout") {
      throw new Error("Two sealed cases are required.");
    }
    expect(
      pairedNonInferiority({
        baselineByCase: [scoreCase(first, 1)],
        candidateByCase: [scoreCase(second, 1)],
        corpusManifest: initialCorpusManifest,
        powerPlan: powerPlan(1, { discordanceRate: 0, margin: 0.02 }),
      }),
    ).toEqual({
      error: {
        _tag: "InvalidStatisticsInput",
        message: "Paired case identities must match.",
      },
      kind: "error",
    });
  });

  it("returns tagged errors for non-finite statistical inputs", () => {
    expect(
      exactBinomialUpperBound({
        confidence: Number.NaN,
        failures: 0,
        total: 299,
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
    expect(
      requiredPairedCaseCount({
        anticipatedDifference: Number.NaN,
        discordanceRate: 0.1,
        margin: 0.02,
        pilotIndependentCases: 100,
        secondMoment: 0.1,
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("rejects impossible anticipated differences before power calculation", () => {
    expect(
      requiredPairedCaseCount({
        anticipatedDifference: 0.2,
        discordanceRate: 0.1,
        margin: 0.02,
        pilotIndependentCases: 100,
        secondMoment: 0.1,
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
    expect(
      requiredPairedCaseCount({
        anticipatedDifference: 2,
        discordanceRate: 1,
        margin: 0.02,
        pilotIndependentCases: 100,
        secondMoment: 1,
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("requires at least two final cases for a zero-variance favorable pilot", () => {
    expect(
      requiredPairedCaseCount({
        anticipatedDifference: 1,
        discordanceRate: 1,
        margin: 0.02,
        pilotIndependentCases: 100,
        secondMoment: 1,
      }),
    ).toEqual({ kind: "success", value: 2 });
  });

  it("keeps small signed pilot score differences continuous", () => {
    const source = powerPlanInput(4, { discordanceRate: 0.1, margin: 0.02 });
    const { signature: ignoredSignature, ...base } = source;
    expect(ignoredSignature).toBe(source.signature);
    const tinyImprovement = 0.000_001;
    const unsigned = {
      ...base,
      pilotCandidateByCase: base.pilotBaselineByCase.map((item) => ({
        caseId: item.caseId,
        fixtureDigest: item.fixtureDigest,
        runs: item.runs.map((score) => score + tinyImprovement),
      })),
    };
    const result = createPairedPowerPlan(
      { ...unsigned, signature: powerPlanSignature(unsigned) },
      initialCorpusManifest,
    );
    expect(result).toMatchObject({ kind: "success" });
    if (result.kind === "error") return;
    expect(result.value.anticipatedDifference).toBeCloseTo(tinyImprovement, 12);
    expect(result.value.requiredCases).toBe(2);
  });

  it("rejects selected runs that omit required ordinary or safety repetitions", () => {
    const safetyCase = sealedCases.find((item) => item.journey === "safety");
    if (safetyCase?.split !== "sealed-holdout") throw new Error("Sealed safety case required.");
    expect(
      pairedNonInferiority({
        baselineByCase: [
          {
            caseId: safetyCase.id,
            fixtureDigest: safetyCase.fixture.contentDigest,
            runs: [1, 1, 1],
          },
        ],
        candidateByCase: [
          {
            caseId: safetyCase.id,
            fixtureDigest: safetyCase.fixture.contentDigest,
            runs: [1, 1, 1],
          },
        ],
        corpusManifest: initialCorpusManifest,
        powerPlan: unwrapPowerPlan(
          powerPlanInputForCaseIds([safetyCase.id], {
            discordanceRate: 0,
            margin: 0.05,
          }),
        ),
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("rejects development cases from final paired power even when both arms match", () => {
    const developmentCase = initialCorpusManifest.cases.find(
      (item) => item.split === "development",
    );
    if (developmentCase?.split !== "development") throw new Error("Development case required.");
    expect(
      createPairedPowerPlan(
        {
          ...powerPlanInput(1, { discordanceRate: 0, margin: 0.05 }),
          caseIds: [developmentCase.id],
        },
        initialCorpusManifest,
      ),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("derives final power only from product-owned pilot observations", () => {
    const firstSealed = sealedCases[0];
    const evidence = pilotEvidence(0.1);
    const firstPilot = evidence.pilotBaselineByCase[0];
    if (firstSealed === undefined || firstPilot === undefined) {
      throw new Error("Pilot and sealed cases are required.");
    }
    expect(
      createPairedPowerPlan(
        {
          ...powerPlanInput(1, { discordanceRate: 0.1, margin: 0.05 }),
          ...evidence,
          pilotBaselineByCase: [
            {
              ...firstPilot,
              fixtureDigest: digestValue("fixture", "caller-pilot"),
            },
            ...evidence.pilotBaselineByCase.slice(1),
          ],
        },
        initialCorpusManifest,
      ),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("rejects invented pilot outcomes and backdated declarations without authority signatures", () => {
    const signed = powerPlanInput(1, { discordanceRate: 0.1, margin: 0.05 });
    const forgedRuns = signed.pilotCandidateByCase.map((item, index) =>
      index === 0 ? { ...item, runs: item.runs.map(() => 0) } : item,
    );
    expect(
      createPairedPowerPlan({ ...signed, pilotCandidateByCase: forgedRuns }, initialCorpusManifest),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
    expect(
      createPairedPowerPlan(
        { ...signed, declaredAt: "2026-08-15T00:00:00.000Z" },
        initialCorpusManifest,
      ),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
    expect(
      createPairedPowerPlan(
        { ...signed, corpusDigest: digestValue("corpus", "different-corpus") },
        initialCorpusManifest,
      ),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("rejects a caller-rehashed power plan that replaces a sealed case", () => {
    const plan = powerPlan(1, { discordanceRate: 0, margin: 0.05 });
    const developmentCase = initialCorpusManifest.cases.find(
      (item) => item.split === "development",
    );
    if (developmentCase === undefined) throw new Error("Development case required.");
    const { contentDigest: ignoredDigest, ...unsigned } = plan;
    expect(ignoredDigest).toBe(plan.contentDigest);
    const forgedUnsigned = { ...unsigned, caseIds: [developmentCase.id] };
    expect(
      pairedNonInferiority({
        baselineByCase: caseScores([1]),
        candidateByCase: caseScores([1]),
        corpusManifest: initialCorpusManifest,
        powerPlan: {
          ...forgedUnsigned,
          contentDigest: digestValue("power-calculation", forgedUnsigned),
        },
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("rejects a caller-rehashed required case count", () => {
    const plan = powerPlan(1, { discordanceRate: 0.1, margin: 0.02 });
    const { contentDigest: ignoredDigest, ...unsigned } = plan;
    expect(ignoredDigest).toBe(plan.contentDigest);
    const forgedUnsigned = { ...unsigned, requiredCases: 1 };
    expect(
      pairedNonInferiority({
        baselineByCase: caseScores([1]),
        candidateByCase: caseScores([1]),
        corpusManifest: initialCorpusManifest,
        powerPlan: {
          ...forgedUnsigned,
          contentDigest: digestValue("power-calculation", forgedUnsigned),
        },
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });

  it("rejects different fixture digests between paired arms", () => {
    const baseline = caseScores([1]);
    const first = baseline[0];
    if (first === undefined) throw new Error("Sealed case required.");
    expect(
      pairedNonInferiority({
        baselineByCase: baseline,
        candidateByCase: [
          {
            ...first,
            fixtureDigest: digestValue("fixture", "different-fixture"),
          },
        ],
        corpusManifest: initialCorpusManifest,
        powerPlan: powerPlan(1, { discordanceRate: 0, margin: 0.05 }),
      }),
    ).toMatchObject({
      error: { _tag: "InvalidStatisticsInput" },
      kind: "error",
    });
  });
});

const sealedCases = initialCorpusManifest.cases.filter((item) => item.split === "sealed-holdout");

const scoreCase = (item: (typeof sealedCases)[number], score: number) => {
  if (item.split !== "sealed-holdout") throw new Error("Sealed case required.");
  return {
    caseId: item.id,
    fixtureDigest: item.fixture.contentDigest,
    runs: Array.from({ length: item.repetitions }, () => score),
  };
};

const caseScores = (scores: ReadonlyArray<number>) =>
  scores.map((score, index) => {
    const item = sealedCases[index];
    if (item === undefined) throw new Error("Enough sealed cases are required.");
    return scoreCase(item, score);
  });

const powerPlan = (
  count: number,
  overrides: { readonly discordanceRate: number; readonly margin: number },
) => unwrapPowerPlan(powerPlanInput(count, overrides));

export const powerPlanInput = (
  count: number,
  overrides: { readonly discordanceRate: number; readonly margin: number },
): PairedPowerPlanInput =>
  powerPlanInputForCaseIds(
    sealedCases.slice(0, count).map((item) => item.id),
    overrides,
  );

const powerPlanInputForCaseIds = (
  caseIds: ReadonlyArray<string>,
  overrides: { readonly discordanceRate: number; readonly margin: number },
): PairedPowerPlanInput => {
  const unsigned = {
    authorityId: "quality-power-owner-1",
    candidateEvaluationStartedAt: "2026-08-17T00:00:00.000Z",
    caseIds,
    corpusDigest: initialCorpusManifest.contentDigest,
    declaredAt: "2026-08-16T00:00:00.000Z",
    margin: overrides.margin,
    ...pilotEvidence(overrides.discordanceRate),
  } satisfies Omit<PairedPowerPlanInput, "signature">;
  return { ...unsigned, signature: powerPlanSignature(unsigned) };
};

const pilotEvidence = (discordanceRate: number) => {
  const cases = initialCorpusManifest.cases
    .filter((item) => item.split === "development")
    .slice(0, 100);
  const discordantCases = discordanceRate * cases.length;
  const pilotBaselineByCase = cases.map((item) => ({
    caseId: item.id,
    fixtureDigest:
      item.split === "development" ? digestValue("fixture", item.fixture) : neverCase(),
    runs: Array.from({ length: item.repetitions }, () => 0.5),
  }));
  const pilotCandidateByCase = cases.map((item, index) => ({
    caseId: item.id,
    fixtureDigest:
      item.split === "development" ? digestValue("fixture", item.fixture) : neverCase(),
    runs: Array.from({ length: item.repetitions }, () =>
      index < discordantCases / 2 ? 1 : index < discordantCases ? 0 : 0.5,
    ),
  }));
  return { pilotBaselineByCase, pilotCandidateByCase };
};

const neverCase = (): never => {
  throw new Error("Pilot fixtures must be development cases.");
};

const unwrapPowerPlan = (input: Parameters<typeof createPairedPowerPlan>[0]) => {
  const result = createPairedPowerPlan(input, initialCorpusManifest);
  if (result.kind === "error") throw new Error(result.error.message);
  return result.value;
};

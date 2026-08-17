import { describe, expect, it } from "@effect/vitest";

import {
  exactBinomialUpperBound,
  pairedNonInferiority,
  requiredPairedCaseCount,
} from "../src/statistics";

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
      requiredPairedCaseCount({ anticipatedDifference: 0, discordanceRate: 0.1, margin: 0.02 }),
    ).toEqual({ kind: "success", value: 2141 });

    expect(
      pairedNonInferiority({
        anticipatedDifference: 0,
        baselineByCase: caseScores([1, 1, 0, 1]),
        candidateByCase: caseScores([1, 1, 0, 1]),
        discordanceRate: 0.1,
        margin: 0.02,
      }),
    ).toMatchObject({
      independentCases: 4,
      kind: "success",
      requiredCases: 2141,
      verdict: "MISSING",
    });
  });

  it("keeps repeated runs clustered under their independent case", () => {
    expect(
      pairedNonInferiority({
        anticipatedDifference: 0,
        baselineByCase: caseScores([1, 1, 1, 1, 1]),
        candidateByCase: caseScores([1, 1, 1, 1, 1]),
        discordanceRate: 0,
        margin: 0.05,
      }),
    ).toEqual({
      difference: 0,
      independentCases: 5,
      kind: "success",
      lowerConfidenceBound: 0,
      requiredCases: 1,
      verdict: "PASS",
    });
  });

  it("returns a tagged error when paired case identities do not match", () => {
    expect(
      pairedNonInferiority({
        anticipatedDifference: 0,
        baselineByCase: [{ caseId: "case-a", runs: [1] }],
        candidateByCase: [{ caseId: "case-b", runs: [1] }],
        discordanceRate: 0,
        margin: 0.02,
      }),
    ).toEqual({
      error: { _tag: "InvalidStatisticsInput", message: "Paired case identities must match." },
      kind: "error",
    });
  });
});

const caseScores = (scores: ReadonlyArray<number>) =>
  scores.map((score, index) => ({ caseId: `case-${index}`, runs: [score, score, score] }));

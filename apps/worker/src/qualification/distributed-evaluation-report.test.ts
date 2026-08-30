import { describe, expect, it } from "@effect/vitest";

import { canonicalQualificationJson } from "./qualification-checksum";
import {
  qualificationDistributedEvaluationDimensionTerminalEvidence,
  qualificationDistributedEvaluationFamilyNames,
  qualificationDistributedEvaluationReport,
  qualificationDistributedEvaluationUnimplementedFamilies,
} from "./distributed-evaluation-report";

const identity = {
  acceptanceLevel: "BoundedBeta" as const,
  executionId: "qualification-report-test",
  expectedDimensionCount: 153,
  expectedRootCount: 12,
  executionCorpus: {
    acceptedCount: 12,
    artifactId: "execution-corpus.json",
    checksum: "execution-corpus-checksum",
    completionCount: 2,
    pageCount: 1,
    partitionCount: 2,
    rootCount: 12,
    terminalJoinPageChecksum: "join-checksum",
    terminalLaunchPageChecksum: "launch-checksum",
  },
  manifestChecksum: "manifest-checksum",
  planChecksum: "plan-checksum",
  sourceVersion: "source-v1",
  topologyVersion: "topology-v1",
};

describe("distributed qualification evaluation report", () => {
  it.each([
    [
      "dimension reducer FAIL",
      { kind: "reducerFailed" as const },
      { reason: "qualificationDimensionReducerFailed", verdict: "FAIL" },
    ],
    [
      "dimension reducer MISSING",
      { kind: "reducerMissing" as const },
      { reason: "bounded_qualification_reducer", verdict: "MISSING" },
    ],
    [
      "authenticated dimension FAIL",
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        kind: "authenticated" as const,
        verdict: "FAIL" as const,
      },
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        failCount: 1,
        missingCount: 0,
        verdict: "FAIL",
      },
    ],
    [
      "authenticated dimension MISSING",
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        kind: "authenticated" as const,
        verdict: "MISSING" as const,
      },
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        failCount: 0,
        missingCount: 1,
        verdict: "MISSING",
      },
    ],
    [
      "authenticated dimensions PASS before distributed report MISSING",
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        kind: "authenticated" as const,
        verdict: "PASS" as const,
      },
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        failCount: 0,
        missingCount: 0,
        verdict: "PASS",
      },
    ],
  ])("maps the owner %s terminal path", (_, terminal, expected) => {
    expect(qualificationDistributedEvaluationDimensionTerminalEvidence(terminal)).toEqual(expected);
  });

  it("retains the fixed family inventory and cannot pass before teardown", () => {
    const report = qualificationDistributedEvaluationReport({
      ...identity,
      correctness: {
        acceptedCount: 12,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 0,
        missingCount: 0,
        rootCount: 12,
        verdict: "PASS",
      },
      dimensions: {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        failCount: 0,
        missingCount: 0,
        verdict: "PASS",
      },
    });

    expect(report.families.map(({ family }) => family)).toEqual(
      qualificationDistributedEvaluationFamilyNames,
    );
    expect(report.verdict).toBe("MISSING");
    expect(report.missingFamilyCount).toBe(8);
    expect(qualificationDistributedEvaluationUnimplementedFamilies).toEqual([
      "semantic_good_root",
      "recovery_reserve_slope",
      "resource_headroom",
      "cost_economics",
      "memory_semantics",
      "external_gates_public_promotion",
      "cohort_teardown",
      "evidence_retention",
    ]);
    expect(report.failingFamilyCount).toBe(0);
    expect(report.families.find(({ family }) => family === "cohort_teardown")?.verdict).toBe(
      "MISSING",
    );
    expect(report.families.find(({ family }) => family === "evidence_retention")?.verdict).toBe(
      "MISSING",
    );
  });

  it("rejects zero or incomplete PASS inventories for a nonempty plan", () => {
    expect(() =>
      qualificationDistributedEvaluationReport({
        ...identity,
        correctness: {
          acceptedCount: 0,
          artifactId: "correctness.json",
          checksum: "correctness-checksum",
          failCount: 0,
          missingCount: 0,
          rootCount: 0,
          verdict: "PASS",
        },
        dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
      }),
    ).toThrow("Qualification distributed report correctness inventory conflicts");

    expect(() =>
      qualificationDistributedEvaluationReport({
        ...identity,
        correctness: { reason: "qualificationCorrectnessMissing", verdict: "MISSING" },
        dimensions: {
          artifactId: "dimensions.json",
          checksum: "dimension-checksum",
          dimensionCount: 0,
          failCount: 0,
          missingCount: 0,
          verdict: "PASS",
        },
      }),
    ).toThrow("Qualification distributed report dimension inventory conflicts");
  });

  it("requires every authenticated correctness PASS root to be accepted", () => {
    expect(() =>
      qualificationDistributedEvaluationReport({
        ...identity,
        correctness: {
          acceptedCount: 11,
          artifactId: "correctness.json",
          checksum: "correctness-checksum",
          failCount: 0,
          missingCount: 0,
          rootCount: 12,
          verdict: "PASS",
        },
        dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
      }),
    ).toThrow("Qualification distributed report PASS omits accepted roots");
  });

  it("keeps an authenticated correctness failure ahead of missing families", () => {
    const report = qualificationDistributedEvaluationReport({
      ...identity,
      correctness: {
        acceptedCount: 8,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 2,
        missingCount: 1,
        rootCount: 12,
        verdict: "FAIL",
      },
      dimensions: {
        reason: "correctness_prerequisite_failed",
        verdict: "MISSING",
      },
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.failingFamilyCount).toBe(1);
    expect(report.missingFamilyCount).toBeGreaterThan(0);
  });

  it("keeps the Public report body and references bounded", () => {
    const report = qualificationDistributedEvaluationReport({
      ...identity,
      acceptanceLevel: "ScaleQualifiedPublic",
      expectedDimensionCount: 431,
      expectedRootCount: 1_750_422,
      executionCorpus: {
        ...identity.executionCorpus,
        acceptedCount: 1_750_422,
        completionCount: 6_894,
        pageCount: 138,
        partitionCount: 6_894,
        rootCount: 1_750_422,
      },
      correctness: {
        acceptedCount: 1_750_422,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 0,
        missingCount: 0,
        rootCount: 1_750_422,
        verdict: "PASS",
      },
      dimensions: {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 431,
        failCount: 0,
        missingCount: 0,
        verdict: "PASS",
      },
    });

    expect(canonicalQualificationJson(report).length).toBeLessThan(32_768);
    expect(report.families.flatMap(({ references }) => references)).toHaveLength(3);
    expect(report.verdict).toBe("MISSING");
  });
});

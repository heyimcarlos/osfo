import { describe, expect, it } from "vitest";

import {
  qualificationEvaluationSortedRunReceipt,
  type QualificationEvaluationSortedRunDescriptor,
} from "../qualification/qualification-evaluation-reducer";
import { qualificationChecksum } from "../qualification/qualification-checksum";
import {
  qualificationDimensionEvaluation,
  qualificationDimensionCoordinatorWorkflowId,
  qualificationDimensionReducerPayload,
  qualificationDimensionReducerWorkflowId,
  qualificationDimensionSelectedIndexes,
} from "./qualification-owner-dimensions";

const receipt = (input: {
  readonly denominatorCount?: number;
  readonly dimension: string;
  readonly maximum?: number;
  readonly missingRootCount?: number;
  readonly sampleStatus?: "COMPLETE" | "MISSING";
  readonly valueCount?: number;
}) => {
  const valueCount = input.valueCount ?? 1_000;
  const inputReceiptChecksums = ["leaf-receipt"];
  const descriptor: typeof QualificationEvaluationSortedRunDescriptor.Type = {
    artifactPrefix: "sorted/final",
    denominatorChainDigest: "denominator-chain",
    denominatorCount: input.denominatorCount ?? 1_000,
    dimension: input.dimension,
    firstPartitionIndex: 0,
    firstShardChecksum: "first",
    inputReceiptChainDigest: qualificationChecksum(inputReceiptChecksums),
    lastPartitionIndex: 9,
    maximum: input.maximum ?? 2_000,
    minimum: 1,
    missingRootCount: input.missingRootCount ?? 0,
    runId: "final-run",
    sampleStatus: input.sampleStatus ?? "COMPLETE",
    shardCount: 4,
    terminalShardChecksum: "terminal",
    valueCount,
    valueType: "latencyMs",
  };
  const value = qualificationEvaluationSortedRunReceipt({
    artifactId: "sorted/final/receipt.json",
    descriptor,
    executionId: "execution",
    index: 0,
    inputReceiptChecksums,
    level: 2,
    planChecksum: "plan",
  });
  if (value === null) throw new Error("Expected a valid receipt fixture");
  return value;
};

describe("qualification dimension forest contracts", () => {
  it("keeps coordinator and reducer instance identities within Cloudflare limits", () => {
    expect(
      qualificationDimensionCoordinatorWorkflowId({
        executionId: "execution",
        planChecksum: "plan",
      }).length,
    ).toBeLessThanOrEqual(100);
    expect("QualificationOwnerDimensionCoordinatorWorkflow").toHaveLength(46);
    expect("QualificationOwnerDimensionCoordinatorWorkflow".length).toBeLessThanOrEqual(64);
  });
  it("constructs a deterministic contiguous reducer payload from authenticated children", () => {
    const references = [0, 1].map((index) => ({
      artifactId: `child-${index}`,
      checksum: `checksum-${index}`,
      denominatorChainDigest: `denominator-${index}`,
      denominatorCount: 256,
      firstPartitionIndex: index,
      lastPartitionIndex: index,
      missingRootCount: index,
      valueType: "latencyMs" as const,
    }));
    const payload = qualificationDimensionReducerPayload({
      dimension: "operation:modelStep",
      executionId: "execution",
      index: 0,
      level: 1,
      planChecksum: "plan",
      references,
    });

    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      denominatorCount: 512,
      firstPartitionIndex: 0,
      lastPartitionIndex: 1,
      missingRootCount: 1,
      valueType: "latencyMs",
    });
    if (payload === null) throw new Error("Expected dimension reducer payload");
    expect(qualificationDimensionReducerWorkflowId(payload)).toHaveLength(75);
    expect(qualificationDimensionReducerWorkflowId(payload).length).toBeLessThanOrEqual(100);
    const firstReference = references[0];
    const secondReference = references[1];
    if (firstReference === undefined || secondReference === undefined) {
      throw new Error("Expected two dimension references");
    }
    expect(
      qualificationDimensionReducerPayload({
        dimension: "operation:modelStep",
        executionId: "execution",
        index: 0,
        level: 1,
        planChecksum: "plan",
        references: [secondReference, firstReference],
      }),
    ).toBeNull();
  });

  it("evaluates the exact objective order statistic at the threshold boundary", () => {
    expect(
      qualificationDimensionSelectedIndexes(
        receipt({ dimension: "stage:target:americas:0:warmDurableAcceptance:all" }),
      ),
    ).toEqual([499, 949, 989, 998]);
    const passing = qualificationDimensionEvaluation({
      receipt: receipt({
        dimension: "stage:target:americas:0:warmDurableAcceptance:all",
      }),
      selectedValues: [300, 700, 900, 1_000],
    });
    const failing = qualificationDimensionEvaluation({
      receipt: receipt({
        dimension: "stage:target:americas:0:warmDurableAcceptance:all",
      }),
      selectedValues: [300, 700, 900, 1_001],
    });

    expect(passing).toMatchObject({
      objectiveMaximumLatencyMs: 1_000,
      objectiveRequiredRatio: 0.999,
      thresholdOrderStatistic: 1_000,
      verdict: "PASS",
    });
    expect(failing?.verdict).toBe("FAIL");
  });

  it("retains exact percentiles for operation dimensions without inventing an SLO", () => {
    expect(
      qualificationDimensionEvaluation({
        receipt: receipt({ dimension: "operation:modelStep" }),
        selectedValues: [30, 50, 90],
      }),
    ).toMatchObject({
      objectiveMaximumLatencyMs: null,
      p50: 30,
      p95: 50,
      p99: 90,
      verdict: "PASS",
    });
  });

  it("makes incomplete stage samples MISSING before threshold comparison", () => {
    const incomplete = receipt({
      denominatorCount: 1_000,
      dimension: "stage:target:americas:0:warmDurableAcceptance:all",
      missingRootCount: 1,
      sampleStatus: "MISSING",
      valueCount: 999,
    });
    expect(
      qualificationDimensionEvaluation({
        receipt: incomplete,
        selectedValues: [300, 700, 900],
      })?.verdict,
    ).toBe("MISSING");
  });
});

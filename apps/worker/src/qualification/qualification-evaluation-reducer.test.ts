import { expect, it } from "vitest";

/* oxlint-disable effecttsgo/async-function -- R2 persistence fakes exercise Promise-native adapter replay. */

import {
  qualificationEvaluationForestBudget,
  qualificationEvaluationFindingShard,
  qualificationEvaluationFindingSummaryShard,
  qualificationEvaluationLeafInputReceipt,
  qualificationEvaluationReductionReceipt,
  qualificationEvaluationCorrectnessReceipt,
  qualificationEvaluationRootAccumulatorReceipt,
  qualificationEvaluationRootAccumulatorShard,
  qualificationEvaluationSortedRunReceipt,
  retainQualificationEvaluationArtifact,
  mergeQualificationFindingSummaries,
  mergeQualificationSortedPage,
  mergeQualificationRootAccumulatorPage,
  qualificationEvaluationFindingExemplarLimit,
  qualificationEvaluationMaximumContinuationResultBytes,
  qualificationEvaluationMaximumDimensionWorkflowSteps,
  qualificationEvaluationReducerBudget,
  qualificationEvaluationReducerStepBudget,
  qualificationEvaluationSortedRunShard,
  qualificationSortedValueFollows,
  qualificationOrderStatisticIndex,
} from "./qualification-evaluation-reducer";
import { qualificationAuthoritySources } from "./authority-sources";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "./qualification-manifest";
import { createQualificationExecutionPlan } from "./execution";
import { qualificationStageDimensionCount } from "./stage-evidence";
import { manifestVersions } from "../../test/support/qualification-fixtures";

const descriptor = (runId: string, count: number, checksum = `${runId}-checksum`) => ({
  artifactPrefix: `${runId}/samples`,
  denominatorChainDigest: `${runId}-denominator-chain`,
  denominatorCount: count,
  dimension: "stage:target:americas:p99",
  firstPartitionIndex: 0,
  firstShardChecksum: count === 0 ? "ZERO" : checksum,
  inputReceiptChainDigest: qualificationChecksum([`${runId}-leaf-receipt`]),
  lastPartitionIndex: 0,
  maximum: count === 0 ? null : count,
  minimum: count === 0 ? null : 1,
  missingRootCount: 0,
  runId,
  sampleStatus: "COMPLETE" as const,
  shardCount: count === 0 ? 0 : 1,
  terminalShardChecksum: count === 0 ? "ZERO" : checksum,
  valueCount: count,
  valueType: "latencyMs" as const,
});

const numericShard = (input: {
  readonly artifactId: string;
  readonly runId: string;
  readonly values: ReadonlyArray<number>;
}) =>
  qualificationEvaluationSortedRunShard({
    artifactId: input.artifactId,
    denominatorChainDigest: `${input.runId}-denominator-chain`,
    denominatorCount: input.values.length,
    dimension: "stage:target:americas:p99",
    executionId: "execution",
    firstPartitionIndex: 0,
    index: 0,
    inputReceiptChainDigest: qualificationChecksum([`${input.runId}-leaf-receipt`]),
    lastPartitionIndex: 0,
    missingRootCount: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: input.runId,
    sampleStatus: "COMPLETE",
    values: input.values,
    valueType: "latencyMs",
  });

const rootRecord = (rootId: string) => ({
  activation: null,
  correlations: [],
  decision: "accepted" as const,
  journey: "ordinaryConversation" as const,
  plan: "free" as const,
  productFactChecksum: `${rootId}-facts`,
  productFactCount: 1,
  rootId,
  terminalState: "succeeded" as const,
});

const rootAccumulatorReceipt = (input: {
  readonly checksum: string;
  readonly artifactId: string;
  readonly partitionIndex: number;
  readonly inputChecksum: string;
}) =>
  qualificationEvaluationRootAccumulatorReceipt({
    acceptedCount: 1,
    artifactId: `${input.artifactId}/receipt.json`,
    artifactPrefix: input.artifactId,
    executionId: "execution",
    firstPartitionIndex: input.partitionIndex,
    firstRootId: "root-a",
    firstShardChecksum: input.checksum,
    index: input.partitionIndex,
    inputReceiptChecksums: [input.inputChecksum],
    lastPartitionIndex: input.partitionIndex,
    lastRootId: "root-a",
    level: 0,
    planChecksum: "plan",
    rootCount: 1,
    shardCount: 1,
    terminalShardChecksum: input.checksum,
  });

it("merges one exact bounded page with deterministic duplicate ordering", () => {
  const left = numericShard({
    artifactId: "left/00000000.json",
    runId: "left",
    values: [1, 3, 3, 8],
  });
  const right = numericShard({
    artifactId: "right/00000000.json",
    runId: "right",
    values: [2, 3, 5, 13],
  });
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const result = mergeQualificationSortedPage([
    { descriptor: descriptor("left", 4, left?.checksum), shard: left, valueOffset: 0 },
    { descriptor: descriptor("right", 4, right?.checksum), shard: right, valueOffset: 0 },
  ]);
  expect(result).toEqual({
    complete: true,
    cursors: [
      { runId: "left", shardIndex: 0, valueOffset: 4 },
      { runId: "right", shardIndex: 0, valueOffset: 4 },
    ],
    valueType: "latencyMs",
    values: [1, 2, 3, 3, 3, 5, 8, 13],
  });
});

it("rejects a dropped, reordered, or over-fan-in merge input", () => {
  const reordered = numericShard({
    artifactId: "reordered/00000000.json",
    runId: "reordered",
    values: [3, 2],
  });
  expect(reordered).toBeNull();
  expect(
    mergeQualificationSortedPage(
      Array.from({ length: 17 }, (_, index) => ({
        descriptor: descriptor(`empty-${index}`, 0),
        shard: null,
        valueOffset: 0,
      })),
    ),
  ).toBeNull();
});

it("keeps identity uniqueness strict across pages while numeric equality remains valid", () => {
  expect(qualificationSortedValueFollows("identity", "root-b", "root-a")).toBe(true);
  expect(qualificationSortedValueFollows("identity", "root-a", "root-a")).toBe(false);
  expect(qualificationSortedValueFollows("latencyMs", 100, 100)).toBe(true);
  expect(qualificationSortedValueFollows("latencyMs", 99, 100)).toBe(false);
});

it("rejects mixed value types and an unbound input-receipt chain", () => {
  const latency = numericShard({ artifactId: "latency.json", runId: "latency", values: [1] });
  const identity = qualificationEvaluationSortedRunShard({
    artifactId: "identity.json",
    denominatorChainDigest: "identity-denominator",
    denominatorCount: 1,
    dimension: "stage:target:americas:p99",
    executionId: "execution",
    firstPartitionIndex: 1,
    index: 0,
    inputReceiptChainDigest: qualificationChecksum(["identity-leaf"]),
    lastPartitionIndex: 1,
    missingRootCount: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: "identity",
    sampleStatus: "COMPLETE",
    values: ["root-a"],
    valueType: "identity",
  });
  if (latency === null || identity === null || identity.valueType !== "identity") {
    throw new Error("Expected exact typed runs");
  }
  expect(
    mergeQualificationSortedPage([
      { descriptor: descriptor("latency", 1, latency.checksum), shard: latency, valueOffset: 0 },
      {
        descriptor: {
          artifactPrefix: "identity",
          denominatorChainDigest: identity.denominatorChainDigest,
          denominatorCount: 1,
          dimension: identity.dimension,
          firstPartitionIndex: 1,
          firstShardChecksum: identity.checksum,
          inputReceiptChainDigest: identity.inputReceiptChainDigest,
          lastPartitionIndex: 1,
          maximum: identity.maximum,
          minimum: identity.minimum,
          missingRootCount: 0,
          runId: identity.runId,
          sampleStatus: "COMPLETE",
          shardCount: 1,
          terminalShardChecksum: identity.checksum,
          valueCount: 1,
          valueType: "identity",
        },
        shard: identity,
        valueOffset: 0,
      },
    ]),
  ).toBeNull();
  expect(
    mergeQualificationSortedPage([
      {
        descriptor: {
          ...descriptor("latency", 1, latency.checksum),
          inputReceiptChainDigest: "substituted-chain",
        },
        shard: latency,
        valueOffset: 0,
      },
    ]),
  ).toBeNull();
});

it("retains explicit missing samples without imposing stage cardinality on operations", () => {
  const stageDescriptor = {
    artifactPrefix: "stage-missing",
    denominatorChainDigest: "denominator",
    denominatorCount: 2,
    dimension: "stage:target:americas:warmDurableAcceptance",
    firstPartitionIndex: 0,
    firstShardChecksum: "stage-shard",
    inputReceiptChainDigest: qualificationChecksum(["leaf"]),
    lastPartitionIndex: 0,
    maximum: 10,
    minimum: 10,
    missingRootCount: 1,
    runId: "stage-missing",
    sampleStatus: "MISSING" as const,
    shardCount: 1,
    terminalShardChecksum: "stage-shard",
    valueCount: 1,
    valueType: "latencyMs" as const,
  };
  const stageMissing = qualificationEvaluationSortedRunReceipt({
    artifactId: "stage-missing/receipt.json",
    descriptor: stageDescriptor,
    executionId: "execution",
    index: 0,
    inputReceiptChecksums: ["leaf"],
    level: 0,
    planChecksum: "plan",
  });
  expect(stageMissing?.sampleStatus).toBe("MISSING");
  if (stageMissing === null) throw new Error("Expected missing stage receipt");
  expect(
    qualificationEvaluationSortedRunReceipt({
      artifactId: "stage-overflow/receipt.json",
      descriptor: {
        ...stageDescriptor,
        artifactPrefix: "stage-overflow",
        firstShardChecksum: "overflow",
        maximum: 30,
        minimum: 10,
        missingRootCount: 0,
        runId: "stage-overflow",
        sampleStatus: "COMPLETE",
        terminalShardChecksum: "overflow",
        valueCount: 3,
      },
      executionId: "execution",
      index: 1,
      inputReceiptChecksums: ["leaf"],
      level: 0,
      planChecksum: "plan",
    }),
  ).toBeNull();
  const operationMissing = qualificationEvaluationSortedRunReceipt({
    artifactId: "operation/receipt.json",
    descriptor: {
      artifactPrefix: "operation",
      denominatorChainDigest: "denominator",
      denominatorCount: 2,
      dimension: "operation:tool",
      firstPartitionIndex: 0,
      firstShardChecksum: "operation-shard",
      inputReceiptChainDigest: qualificationChecksum(["leaf"]),
      lastPartitionIndex: 0,
      maximum: "effect-z",
      minimum: "effect-a",
      missingRootCount: 1,
      runId: "operation",
      sampleStatus: "MISSING",
      shardCount: 1,
      terminalShardChecksum: "operation-shard",
      valueCount: 3,
      valueType: "identity",
    },
    executionId: "execution",
    index: 2,
    inputReceiptChecksums: ["leaf"],
    level: 0,
    planChecksum: "plan",
  });
  expect(operationMissing).toMatchObject({
    denominatorCount: 2,
    missingRootCount: 1,
    sampleStatus: "MISSING",
    valueCount: 3,
  });
});

it("reduces zero and nonzero identity leaves without weakening uniqueness", () => {
  const zeroReceipt = qualificationEvaluationSortedRunReceipt({
    artifactId: "identity-zero/receipt.json",
    descriptor: {
      artifactPrefix: "identity-zero",
      denominatorChainDigest: "zero-denominator",
      denominatorCount: 1,
      dimension: "acceptedRootIds",
      firstPartitionIndex: 0,
      firstShardChecksum: "ZERO",
      inputReceiptChainDigest: qualificationChecksum(["leaf-zero"]),
      lastPartitionIndex: 0,
      maximum: null,
      minimum: null,
      missingRootCount: 1,
      runId: "identity-zero",
      sampleStatus: "MISSING",
      shardCount: 0,
      terminalShardChecksum: "ZERO",
      valueCount: 0,
      valueType: "identity",
    },
    executionId: "execution",
    index: 0,
    inputReceiptChecksums: ["leaf-zero"],
    level: 0,
    planChecksum: "plan",
  });
  const nonzeroShard = qualificationEvaluationSortedRunShard({
    artifactId: "identity-nonzero/00000000.json",
    denominatorChainDigest: "nonzero-denominator",
    denominatorCount: 1,
    dimension: "acceptedRootIds",
    executionId: "execution",
    firstPartitionIndex: 1,
    index: 0,
    inputReceiptChainDigest: qualificationChecksum(["leaf-nonzero"]),
    lastPartitionIndex: 1,
    missingRootCount: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: "identity-nonzero",
    sampleStatus: "COMPLETE",
    values: ["root-a"],
    valueType: "identity",
  });
  if (zeroReceipt === null || nonzeroShard === null || nonzeroShard.valueType !== "identity") {
    throw new Error("Expected zero and nonzero identity inputs");
  }
  const nonzeroDescriptor = {
    artifactPrefix: "identity-nonzero",
    denominatorChainDigest: nonzeroShard.denominatorChainDigest,
    denominatorCount: 1,
    dimension: "acceptedRootIds",
    firstPartitionIndex: 1,
    firstShardChecksum: nonzeroShard.checksum,
    inputReceiptChainDigest: nonzeroShard.inputReceiptChainDigest,
    lastPartitionIndex: 1,
    maximum: "root-a",
    minimum: "root-a",
    missingRootCount: 0,
    runId: nonzeroShard.runId,
    sampleStatus: "COMPLETE" as const,
    shardCount: 1,
    terminalShardChecksum: nonzeroShard.checksum,
    valueCount: 1,
    valueType: "identity" as const,
  };
  expect(
    mergeQualificationSortedPage([
      { descriptor: zeroReceipt, shard: null, valueOffset: 0 },
      { descriptor: nonzeroDescriptor, shard: nonzeroShard, valueOffset: 0 },
    ]),
  ).toMatchObject({ valueType: "identity", values: ["root-a"] });
  const duplicate = qualificationEvaluationSortedRunShard({
    ...nonzeroShard,
    artifactId: "identity-duplicate/00000000.json",
    denominatorChainDigest: "duplicate-denominator",
    firstPartitionIndex: 2,
    inputReceiptChainDigest: qualificationChecksum(["leaf-duplicate"]),
    lastPartitionIndex: 2,
    runId: "identity-duplicate",
    values: ["root-a"],
  });
  if (duplicate === null || duplicate.valueType !== "identity") {
    throw new Error("Expected duplicate identity leaf");
  }
  expect(
    mergeQualificationSortedPage([
      { descriptor: nonzeroDescriptor, shard: nonzeroShard, valueOffset: 0 },
      {
        descriptor: {
          ...nonzeroDescriptor,
          artifactPrefix: "identity-duplicate",
          denominatorChainDigest: duplicate.denominatorChainDigest,
          firstPartitionIndex: 2,
          firstShardChecksum: duplicate.checksum,
          inputReceiptChainDigest: duplicate.inputReceiptChainDigest,
          lastPartitionIndex: 2,
          runId: duplicate.runId,
          terminalShardChecksum: duplicate.checksum,
        },
        shard: duplicate,
        valueOffset: 0,
      },
    ]),
  ).toBeNull();
});

it("reduces correctness once with strict root identity and FAIL precedence", () => {
  const left = qualificationEvaluationRootAccumulatorShard({
    artifactId: "roots-left/00000000.json",
    executionId: "execution",
    firstPartitionIndex: 0,
    index: 0,
    lastPartitionIndex: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    roots: [rootRecord("root-a")],
  });
  const right = qualificationEvaluationRootAccumulatorShard({
    artifactId: "roots-right/00000000.json",
    executionId: "execution",
    firstPartitionIndex: 1,
    index: 0,
    lastPartitionIndex: 1,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    roots: [rootRecord("root-a")],
  });
  if (left === null || right === null) throw new Error("Expected exact root shards");
  const leftReceipt = rootAccumulatorReceipt({
    artifactId: left.artifactId,
    checksum: left.checksum,
    inputChecksum: "leaf-left",
    partitionIndex: 0,
  });
  const rightReceipt = rootAccumulatorReceipt({
    artifactId: right.artifactId,
    checksum: right.checksum,
    inputChecksum: "leaf-right",
    partitionIndex: 1,
  });
  if (leftReceipt === null || rightReceipt === null) throw new Error("Expected root receipts");
  expect(
    mergeQualificationRootAccumulatorPage([
      { receipt: leftReceipt, rootOffset: 0, shard: left },
      { receipt: rightReceipt, rootOffset: 0, shard: right },
    ]),
  ).toBeNull();
  const correctness = qualificationEvaluationCorrectnessReceipt({
    artifactId: "correctness.json",
    executionId: "execution",
    findingSummary: {
      exemplars: [
        { code: "failure", detail: "failed", subject: "root-a", verdict: "FAIL" },
        { code: "missing", detail: "missing", subject: "root-b", verdict: "MISSING" },
      ],
      failCount: 1,
      missingCount: 1,
    },
    findingSummaryArtifactChecksum: "summary-checksum",
    findingSummaryArtifactId: "summary.json",
    index: 0,
    inputReceiptChecksums: ["leaf-left"],
    level: 0,
    planChecksum: "plan",
    rootAccumulator: leftReceipt,
  });
  expect(correctness?.verdict).toBe("FAIL");
  if (correctness === null) throw new Error("Expected correctness receipt");
  expect(
    qualificationEvaluationCorrectnessReceipt({
      ...correctness,
      artifactId: "substituted.json",
      inputReceiptChecksums: ["another-leaf"],
      rootAccumulator: leftReceipt,
    }),
  ).toBeNull();
  expect(
    qualificationEvaluationCorrectnessReceipt({
      ...correctness,
      executionId: "other-execution",
      rootAccumulator: leftReceipt,
    }),
  ).toBeNull();
  expect(
    qualificationEvaluationCorrectnessReceipt({
      ...correctness,
      planChecksum: "other-plan",
      rootAccumulator: leftReceipt,
    }),
  ).toBeNull();
  expect(
    qualificationEvaluationRootAccumulatorShard({
      artifactId: "unsorted-correlations.json",
      executionId: "execution",
      firstPartitionIndex: 0,
      index: 0,
      lastPartitionIndex: 0,
      planChecksum: "plan",
      previousShardChecksum: "NONE",
      roots: [
        {
          ...rootRecord("root-c"),
          correlations: [
            { kind: "z", value: "one" },
            { kind: "a", value: "two" },
          ],
        },
      ],
    }),
  ).toBeNull();
});

it("bounds findings while preserving exact FAIL and MISSING cardinality", () => {
  const merged = mergeQualificationFindingSummaries(
    Array.from({ length: 1_000 }, (_, index) => ({
      exemplars: [
        {
          code: `code-${index.toString().padStart(4, "0")}`,
          detail: `detail ${index}`,
          subject: `root-${index}`,
          verdict: index % 2 === 0 ? ("FAIL" as const) : ("MISSING" as const),
        },
      ],
      failCount: index % 2 === 0 ? 1 : 0,
      missingCount: index % 2 === 0 ? 0 : 1,
    })),
  );
  expect(merged.failCount).toBe(500);
  expect(merged.missingCount).toBe(500);
  expect(merged.exemplars).toHaveLength(qualificationEvaluationFindingExemplarLimit);
  expect(JSON.stringify(merged).length).toBeLessThan(10_000);
});

it("binds a leaf to exactly one ordered copy of every producer authority", () => {
  const receipt = qualificationEvaluationLeafInputReceipt({
    artifactId: "leaf/00000007.json",
    arrivalChecksum: "arrival",
    arrivalRecordCount: 256,
    authorityInputs: qualificationAuthoritySources.map((source, index) => ({
      checksum: `${source}-checksum`,
      recordCount: index,
      source,
    })),
    executionId: "execution",
    partitionAuthorityChecksum: "partition-authority",
    partitionIndex: 7,
    planChecksum: "plan",
    streamChunkIndex: 7,
  });
  expect(receipt).not.toBeNull();
  if (receipt === null) throw new Error("Expected an exact leaf input receipt");
  expect(
    qualificationEvaluationLeafInputReceipt({
      ...receipt,
      authorityInputs: receipt.authorityInputs.map((input, index) => {
        const first = receipt.authorityInputs[0];
        if (index !== 1 || first === undefined) return input;
        return { ...input, source: first.source };
      }),
    }),
  ).toBeNull();
  const first = receipt.authorityInputs[0];
  const second = receipt.authorityInputs[1];
  if (first === undefined || second === undefined) throw new Error("Expected authority inputs");
  expect(
    qualificationEvaluationLeafInputReceipt({
      ...receipt,
      authorityInputs: [second, first, ...receipt.authorityInputs.slice(2)],
    }),
  ).toBeNull();
});

it("retains full findings in bounded body-checksummed shards", () => {
  const shard = qualificationEvaluationFindingShard({
    artifactId: "findings/00000000.json",
    executionId: "execution",
    findings: [
      { code: "terminalFailure", detail: "root failed", subject: "root-1", verdict: "FAIL" },
    ],
    index: 0,
    partitionIndex: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
  });
  expect(shard?.findings).toHaveLength(1);
  expect(
    qualificationEvaluationFindingShard({
      artifactId: "findings/00000001.json",
      executionId: "execution",
      findings: [],
      index: 0,
      partitionIndex: 0,
      planChecksum: "plan",
      previousShardChecksum: "NONE",
    }),
  ).toBeNull();
  const maximum = Array.from({ length: 256 }, (_, index) => ({
    code: "terminalFailure",
    detail: `root ${index} failed`,
    subject: `root-${index}`,
    verdict: "FAIL" as const,
  }));
  expect(
    qualificationEvaluationFindingShard({
      artifactId: "findings/maximum.json",
      executionId: "execution",
      findings: maximum,
      index: 1,
      partitionIndex: 0,
      planChecksum: "plan",
      previousShardChecksum: shard?.checksum ?? "NONE",
    })?.findings,
  ).toHaveLength(256);
  expect(
    qualificationEvaluationFindingShard({
      artifactId: "findings/overflow.json",
      executionId: "execution",
      findings: [
        ...maximum,
        {
          code: "terminalFailure",
          detail: "overflow root failed",
          subject: "root-overflow",
          verdict: "FAIL",
        },
      ],
      index: 2,
      partitionIndex: 0,
      planChecksum: "plan",
      previousShardChecksum: "checksum",
    }),
  ).toBeNull();
});

it("proves bounded Beta and Public reducer topology", () => {
  expect(qualificationEvaluationReducerBudget(613)).toEqual({
    levelWidths: [39, 3, 1],
    maximumContinuationComparisons: 4_096,
    maximumContinuationInputValues: 4_096,
    maximumContinuationReads: 17,
    maximumContinuationResultValues: 256,
    maximumContinuationWrites: 3,
    rootReceiptCount: 1,
  });
  expect(qualificationEvaluationReducerBudget(6_894)).toEqual({
    levelWidths: [431, 27, 2, 1],
    maximumContinuationComparisons: 4_096,
    maximumContinuationInputValues: 4_096,
    maximumContinuationReads: 17,
    maximumContinuationResultValues: 256,
    maximumContinuationWrites: 3,
    rootReceiptCount: 1,
  });
  expect(qualificationOrderStatisticIndex(1_750_422, 0.99)).toBe(1_732_917);
  expect(qualificationEvaluationMaximumDimensionWorkflowSteps).toBe(6_840);
  expect(qualificationEvaluationMaximumDimensionWorkflowSteps).toBeLessThan(
    qualificationEvaluationReducerStepBudget,
  );
});

it.each([
  [
    "BoundedBeta",
    createBoundedBetaManifest(manifestVersions),
    {
      createBatchCount: 23,
      maximumDimensionValues: 150_274,
      maximumOwnerSteps: 49,
      reducerWorkflowCount: 1_113,
      sortedDimensionCount: 153,
    },
  ],
  [
    "ScaleQualifiedPublic",
    createScaleQualifiedPublicManifest(manifestVersions),
    {
      createBatchCount: 216,
      maximumDimensionValues: 1_750_422,
      maximumOwnerSteps: 435,
      reducerWorkflowCount: 10_783,
      sortedDimensionCount: 431,
    },
  ],
] as const)(
  "budgets the complete %s reducer forest below owner limits",
  (level, manifest, expected) => {
    const plan = createQualificationExecutionPlan(manifest, 0, `evaluation-budget-${level}`);
    const budget = qualificationEvaluationForestBudget(plan);
    expect(budget).toEqual(expected);
    expect(budget.createBatchCount).toBeLessThan(10_000);
    expect(budget.maximumOwnerSteps).toBeLessThan(10_000);
  },
);

it("derives reducer stage dimensions from the frozen assessment policy", () => {
  expect(qualificationStageDimensionCount("target")).toBe(15);
  expect(qualificationStageDimensionCount("stress")).toBe(15);
  expect(qualificationStageDimensionCount("dependencyOutageRecovery")).toBe(15);
  expect(qualificationStageDimensionCount("allCold")).toBe(4);
});

it("selects exact boundary, p50, p95, and p99 order statistics from a full output page", () => {
  const values = Array.from({ length: 256 }, (_, index) => index + 1);
  const result = numericShard({
    artifactId: "ordered/00000000.json",
    runId: "ordered",
    values,
  });
  expect(result).not.toBeNull();
  for (const [percentile, expected] of [
    [1 / 256, 1],
    [0.5, 128],
    [0.95, 244],
    [0.99, 254],
    [1, 256],
  ] as const) {
    const index = qualificationOrderStatisticIndex(values.length, percentile);
    expect(index === null ? null : values[index]).toBe(expected);
  }
  expect(JSON.stringify(result).length).toBeLessThan(10_000);
  expect(JSON.stringify(result).length).toBeLessThan(
    qualificationEvaluationMaximumContinuationResultBytes,
  );
});

it("rejects dropped, duplicated, and reordered reducer children", () => {
  const summary = qualificationEvaluationFindingSummaryShard({
    artifactId: "summary.json",
    executionId: "execution",
    index: 0,
    inputChecksums: ["child-a", "child-b"],
    level: 1,
    planChecksum: "plan",
    summary: { exemplars: [], failCount: 0, missingCount: 0 },
  });
  expect(summary).not.toBeNull();
  if (summary === null) throw new Error("Expected summary shard");
  const base = {
    artifactId: "reducer.json",
    executionId: "execution",
    findingSummaryArtifactChecksum: summary.checksum,
    findingSummaryArtifactId: summary.artifactId,
    index: 0,
    level: 1,
    planChecksum: "plan",
    sortedRuns: [],
  };
  expect(
    qualificationEvaluationReductionReceipt({
      ...base,
      inputs: [
        { artifactId: "a", checksum: "child-a", firstPartitionIndex: 0, lastPartitionIndex: 7 },
        { artifactId: "b", checksum: "child-b", firstPartitionIndex: 8, lastPartitionIndex: 15 },
      ],
    }),
  ).not.toBeNull();
  expect(
    qualificationEvaluationReductionReceipt({
      ...base,
      inputs: [
        { artifactId: "a", checksum: "child-a", firstPartitionIndex: 0, lastPartitionIndex: 7 },
        { artifactId: "b", checksum: "child-b", firstPartitionIndex: 9, lastPartitionIndex: 15 },
      ],
    }),
  ).toBeNull();
  expect(
    qualificationEvaluationReductionReceipt({
      ...base,
      inputs: [
        { artifactId: "a", checksum: "child-a", firstPartitionIndex: 8, lastPartitionIndex: 15 },
        { artifactId: "b", checksum: "child-b", firstPartitionIndex: 0, lastPartitionIndex: 7 },
      ],
    }),
  ).toBeNull();
  expect(
    qualificationEvaluationReductionReceipt({
      ...base,
      inputs: [
        { artifactId: "a", checksum: "child-a", firstPartitionIndex: 0, lastPartitionIndex: 7 },
        { artifactId: "b", checksum: "child-a", firstPartitionIndex: 8, lastPartitionIndex: 15 },
      ],
    }),
  ).toBeNull();
});

it("retains create-or-identical across commit uncertainty and rejects metadata replacement", async () => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  let ambiguous = true;
  const bucket = {
    get: (key: string) => {
      const value = retained.get(key);
      return Promise.resolve(
        value === undefined
          ? null
          : { customMetadata: value.customMetadata, text: () => Promise.resolve(value.value) },
      );
    },
    put: (
      key: string,
      value: string,
      options: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (!retained.has(key)) {
        retained.set(key, { customMetadata: options.customMetadata ?? {}, value });
      }
      if (ambiguous) {
        ambiguous = false;
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    },
  };
  const input = {
    artifactId: "artifact.json",
    bucket,
    checksum: "checksum",
    encoded: '{"value":1}',
    executionId: "execution",
    kind: "qualification-evaluation-test-v1",
    planChecksum: "plan",
  };
  expect(await retainQualificationEvaluationArtifact(input)).toBe("REPLAY");
  expect(await retainQualificationEvaluationArtifact(input)).toBe("REPLAY");
  const prior = retained.get(input.artifactId);
  if (prior === undefined) throw new Error("Expected retained artifact");
  retained.set(input.artifactId, {
    ...prior,
    customMetadata: { ...prior.customMetadata, "osfo-plan-checksum": "other-plan" },
  });
  expect(await retainQualificationEvaluationArtifact(input)).toBe("CONFLICT");
});

it("replays byte-identical leaf, sorted, finding-summary, and reducer persistence edges", async () => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const bucket = {
    get: (key: string) => {
      const value = retained.get(key);
      return Promise.resolve(
        value === undefined
          ? null
          : { customMetadata: value.customMetadata, text: () => Promise.resolve(value.value) },
      );
    },
    put: (
      key: string,
      value: string,
      options: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: options.customMetadata ?? {}, value });
      return Promise.resolve({ etag: key });
    },
  };
  const leaf = qualificationEvaluationLeafInputReceipt({
    artifactId: "leaf.json",
    arrivalChecksum: "arrival",
    arrivalRecordCount: 1,
    authorityInputs: qualificationAuthoritySources.map((source) => ({
      checksum: `${source}-checksum`,
      recordCount: 1,
      source,
    })),
    executionId: "execution",
    partitionAuthorityChecksum: "partition-authority",
    partitionIndex: 0,
    planChecksum: "plan",
    streamChunkIndex: 0,
  });
  const sorted = qualificationEvaluationSortedRunShard({
    artifactId: "sorted.json",
    denominatorChainDigest: "denominator-chain",
    denominatorCount: 1,
    dimension: "stage",
    executionId: "execution",
    firstPartitionIndex: 0,
    index: 0,
    inputReceiptChainDigest: qualificationChecksum(["leaf-checksum"]),
    lastPartitionIndex: 0,
    missingRootCount: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: "run",
    sampleStatus: "COMPLETE",
    values: [1],
    valueType: "latencyMs",
  });
  const summary = qualificationEvaluationFindingSummaryShard({
    artifactId: "summary.json",
    executionId: "execution",
    index: 0,
    inputChecksums: ["leaf-checksum"],
    level: 0,
    planChecksum: "plan",
    summary: { exemplars: [], failCount: 0, missingCount: 0 },
  });
  if (leaf === null || sorted === null || summary === null) {
    throw new Error("Expected exact evaluation artifacts");
  }
  if (sorted.valueType !== "latencyMs") throw new Error("Expected numeric sorted artifact");
  const sortedReceipt = qualificationEvaluationSortedRunReceipt({
    artifactId: "sorted/receipt.json",
    descriptor: {
      artifactPrefix: "sorted",
      denominatorChainDigest: sorted.denominatorChainDigest,
      denominatorCount: sorted.denominatorCount,
      dimension: sorted.dimension,
      firstShardChecksum: sorted.checksum,
      firstPartitionIndex: 0,
      inputReceiptChainDigest: qualificationChecksum([leaf.checksum]),
      lastPartitionIndex: 0,
      maximum: sorted.maximum,
      minimum: sorted.minimum,
      missingRootCount: 0,
      runId: sorted.runId,
      sampleStatus: "COMPLETE",
      shardCount: 1,
      terminalShardChecksum: sorted.checksum,
      valueCount: 1,
      valueType: "latencyMs",
    },
    executionId: "execution",
    index: 0,
    inputReceiptChecksums: [leaf.checksum],
    level: 1,
    planChecksum: "plan",
  });
  if (sortedReceipt === null) throw new Error("Expected exact sorted receipt");
  const reduction = qualificationEvaluationReductionReceipt({
    artifactId: "reduction.json",
    executionId: "execution",
    findingSummaryArtifactChecksum: summary.checksum,
    findingSummaryArtifactId: summary.artifactId,
    index: 0,
    inputs: [
      {
        artifactId: leaf.artifactId,
        checksum: leaf.checksum,
        firstPartitionIndex: 0,
        lastPartitionIndex: 0,
      },
    ],
    level: 1,
    planChecksum: "plan",
    sortedRuns: [sortedReceipt],
  });
  if (reduction === null) throw new Error("Expected exact reduction receipt");
  await Promise.all(
    (
      [
        ["leaf", leaf],
        ["sorted", sorted],
        ["summary", summary],
        ["reduction", reduction],
      ] as const
    ).map(async ([kind, artifact]) => {
      const encoded = canonicalQualificationJson(artifact);
      const persist = () =>
        retainQualificationEvaluationArtifact({
          artifactId: artifact.artifactId,
          bucket,
          checksum: artifact.checksum,
          encoded,
          executionId: "execution",
          kind,
          planChecksum: "plan",
        });
      expect(await persist()).toBe("RETAINED");
      expect(await persist()).toBe("REPLAY");
      expect(retained.get(artifact.artifactId)?.value).toBe(encoded);
    }),
  );
});

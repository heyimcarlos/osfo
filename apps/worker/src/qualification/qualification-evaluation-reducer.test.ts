import { expect, it } from "vitest";

/* oxlint-disable effecttsgo/async-function -- R2 persistence fakes exercise Promise-native adapter replay. */

import {
  qualificationEvaluationForestBudget,
  qualificationEvaluationFindingShard,
  qualificationEvaluationFindingSummaryShard,
  qualificationEvaluationLeafInputReceipt,
  qualificationEvaluationReductionReceipt,
  qualificationEvaluationSortedRunReceipt,
  retainQualificationEvaluationArtifact,
  mergeQualificationFindingSummaries,
  mergeQualificationSortedPage,
  qualificationEvaluationFindingExemplarLimit,
  qualificationEvaluationMaximumContinuationResultBytes,
  qualificationEvaluationMaximumDimensionWorkflowSteps,
  qualificationEvaluationReducerBudget,
  qualificationEvaluationReducerStepBudget,
  qualificationEvaluationSortedRunShard,
  qualificationOrderStatisticIndex,
} from "./qualification-evaluation-reducer";
import { qualificationAuthoritySources } from "./authority-sources";
import { canonicalQualificationJson } from "./qualification-checksum";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "./qualification-manifest";
import { createQualificationExecutionPlan } from "./execution";
import { qualificationStageDimensionCount } from "./stage-evidence";
import { manifestVersions } from "../../test/support/qualification-fixtures";

const descriptor = (runId: string, count: number) => ({
  artifactPrefix: `${runId}/samples`,
  dimension: "stage:target:americas:p99",
  firstShardChecksum: `${runId}-first`,
  maximum: count === 0 ? 0 : count,
  minimum: count === 0 ? 0 : 1,
  runId,
  shardCount: count === 0 ? 0 : 1,
  terminalShardChecksum: `${runId}-last`,
  valueCount: count,
});

it("merges one exact bounded page with deterministic duplicate ordering", () => {
  const left = qualificationEvaluationSortedRunShard({
    artifactId: "left/00000000.json",
    dimension: "stage:target:americas:p99",
    executionId: "execution",
    index: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: "left",
    values: [1, 3, 3, 8],
  });
  const right = qualificationEvaluationSortedRunShard({
    artifactId: "right/00000000.json",
    dimension: "stage:target:americas:p99",
    executionId: "execution",
    index: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: "right",
    values: [2, 3, 5, 13],
  });
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const result = mergeQualificationSortedPage([
    { descriptor: descriptor("left", 4), shard: left, valueOffset: 0 },
    { descriptor: descriptor("right", 4), shard: right, valueOffset: 0 },
  ]);
  expect(result).toEqual({
    complete: true,
    cursors: [
      { runId: "left", shardIndex: 0, valueOffset: 4 },
      { runId: "right", shardIndex: 0, valueOffset: 4 },
    ],
    values: [1, 2, 3, 3, 3, 5, 8, 13],
  });
});

it("rejects a dropped, reordered, or over-fan-in merge input", () => {
  const reordered = qualificationEvaluationSortedRunShard({
    artifactId: "reordered/00000000.json",
    dimension: "stage:target:americas:p99",
    executionId: "execution",
    index: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
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
  const result = qualificationEvaluationSortedRunShard({
    artifactId: "ordered/00000000.json",
    dimension: "stage:target:americas",
    executionId: "execution",
    index: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
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
    dimension: "stage",
    executionId: "execution",
    index: 0,
    planChecksum: "plan",
    previousShardChecksum: "NONE",
    runId: "run",
    values: [1],
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
  const sortedReceipt = qualificationEvaluationSortedRunReceipt({
    artifactId: "sorted/receipt.json",
    descriptor: {
      artifactPrefix: "sorted",
      dimension: sorted.dimension,
      firstShardChecksum: sorted.checksum,
      maximum: sorted.maximum,
      minimum: sorted.minimum,
      runId: sorted.runId,
      shardCount: 1,
      terminalShardChecksum: sorted.checksum,
      valueCount: 1,
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

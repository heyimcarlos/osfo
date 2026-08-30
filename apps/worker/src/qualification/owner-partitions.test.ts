import { describe, expect, it } from "@effect/vitest";

import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "./qualification-manifest";
import { createQualificationExecutionPlan } from "./execution";
import {
  qualificationOwnerPartitions,
  qualificationOwnerLeafFanoutBudget,
  qualificationOwnerCorrectnessForestBudget,
  qualificationOwnerDimensionCoordinatorBudget,
  qualificationOwnerCorrectnessLevelCounts,
  qualificationOwnerPartitionPhaseBudget,
  qualificationLeafCompletionHorizonMs,
  qualificationLeafFanoutMaximumDurationMs,
  qualificationPartitionChunkLimit,
  qualificationPartitionCreateBatchLimit,
  qualificationPartitionWorkflowStepBudget,
  qualificationPartitionWorstCaseSteps,
} from "./owner-partitions";
import { manifestVersions } from "../../test/support/qualification-fixtures";

describe("qualification owner partitions", () => {
  it.each([
    ["bounded beta", createBoundedBetaManifest(manifestVersions), 613, 613],
    ["scale-qualified public", createScaleQualifiedPublicManifest(manifestVersions), 6_894, 6_894],
  ] as const)(
    "keeps the exact %s manifest below every child step budget",
    (_, manifest, chunks, count) => {
      const plan = createQualificationExecutionPlan(manifest, 0, `partition-budget-${count}`);
      const partitions = qualificationOwnerPartitions(plan);

      expect(partitions).toHaveLength(count);
      expect(partitions.flatMap(({ chunks: partitionChunks }) => partitionChunks)).toHaveLength(
        chunks,
      );
      expect(
        partitions.every(
          ({ chunks: partitionChunks }) =>
            partitionChunks.length <= qualificationPartitionChunkLimit,
        ),
      ).toBe(true);
      expect(
        partitions.every(
          ({ chunks: partitionChunks }) =>
            qualificationPartitionWorstCaseSteps(partitionChunks.length) <
            qualificationPartitionWorkflowStepBudget,
        ),
      ).toBe(true);
      expect(
        Math.ceil(partitions.length / qualificationPartitionCreateBatchLimit),
      ).toBeLessThanOrEqual(138);
      expect(
        partitions.every(
          ({ chunks: partitionChunks, firstStreamChunkIndex, lastStreamChunkIndex }) =>
            partitionChunks[0]?.streamChunkIndex === firstStreamChunkIndex &&
            partitionChunks.at(-1)?.streamChunkIndex === lastStreamChunkIndex,
        ),
      ).toBe(true);
    },
  );

  it.each([
    [
      "bounded beta",
      createBoundedBetaManifest(manifestVersions),
      {
        dimensionCount: 153,
        dimensionIndexPageCount: 396,
        launchPageCount: 320,
        levelWidths: [918, 181, 14],
        maximumCoordinatorSubrequests: 9_904,
        maximumReportSubrequests: 28,
        maximumRootOwnerSubrequests: 13_816,
        numericDimensionCount: 145,
        reducerCount: 1_113,
        selectedShardReadCount: 580,
      },
    ],
    [
      "scale-qualified public",
      createScaleQualifiedPublicManifest(manifestVersions),
      {
        dimensionCount: 431,
        dimensionIndexPageCount: 3_544,
        launchPageCount: 1_002,
        levelWidths: [9_946, 795, 28, 14],
        maximumCoordinatorSubrequests: 71_781,
        maximumReportSubrequests: 28,
        maximumRootOwnerSubrequests: 148_319,
        numericDimensionCount: 423,
        reducerCount: 10_783,
        selectedShardReadCount: 1_692,
      },
    ],
  ] as const)(
    "keeps the exact %s dimension forests below every owner limit",
    (_, manifest, expected) => {
      const plan = createQualificationExecutionPlan(manifest, 0, `dimension-budget-${_}`);
      const budget = qualificationOwnerDimensionCoordinatorBudget(plan);

      expect(budget).toMatchObject(expected);
      expect(budget.levelHorizonMs).toBe(24 * 60 * 60_000);
      expect(budget.maximumEvaluationDurationMs).toBe(4 * 24 * 60 * 60_000);
      expect(budget.maximumCoordinatorSubrequests).toBeLessThanOrEqual(250_000 * 0.7);
      expect(budget.maximumRootOwnerSubrequests).toBeLessThanOrEqual(250_000 * 0.7);
      expect(budget.maximumCoordinatorDurableSteps).toBeLessThan(10_000);
      expect(budget.maximumStepSubrequests).toBeLessThanOrEqual(169);
    },
  );

  it.each([
    ["bounded beta", 613, 13, 4_451, 57, 83, 12_000],
    ["scale-qualified public", 6_894, 138, 49_918, 557, 833, 137_000],
  ] as const)(
    "keeps %s leaf fanout and join below the private owner limits",
    (
      _,
      partitionCount,
      batchCount,
      maximumSubrequests,
      maximumDurableSteps,
      maximumWorkflowOperations,
      scheduledFanoutDurationMs,
    ) => {
      const budget = qualificationOwnerLeafFanoutBudget(partitionCount);
      expect(budget).toEqual({
        batchCount,
        maximumDurableSteps,
        maximumSubrequests,
        maximumTerminalDurationMs: 20 * 60_000,
        maximumWorkflowOperations,
        postFinalLaunchHorizonMs: 17 * 60_000,
        scheduledFanoutDurationMs,
      });
      expect(maximumSubrequests).toBeLessThanOrEqual(250_000 * 0.7);
      expect(scheduledFanoutDurationMs + qualificationLeafCompletionHorizonMs).toBeLessThan(
        20 * 60_000,
      );
      expect(qualificationLeafFanoutMaximumDurationMs + qualificationLeafCompletionHorizonMs).toBe(
        20 * 60_000,
      );
    },
  );

  it.each([
    ["bounded beta", 613, [39, 3, 1], 5, 43, 6_525, 423, 780, 13_508],
    ["scale-qualified public", 6_894, [431, 27, 2, 1], 31, 461, 69_687, 2_705, 4_933, 148_011],
  ] as const)(
    "keeps the exact %s correctness forest within owner limits",
    (
      _,
      partitionCount,
      levels,
      launchPageCount,
      reducerCount,
      maximumSubrequests,
      maximumDurableSteps,
      maximumWorkflowOperations,
      maximumCumulativeOwnerSubrequests,
    ) => {
      expect(qualificationOwnerCorrectnessLevelCounts(partitionCount)).toEqual(levels);
      expect(qualificationOwnerCorrectnessForestBudget(partitionCount)).toEqual({
        deadlineMs: 24 * 60 * 60_000,
        launchPageCount,
        levelCounts: levels,
        maximumCumulativeOwnerSubrequests,
        maximumDurableSteps,
        maximumSubrequests,
        maximumWorkflowOperations,
        pollCount: 72,
        pollIntervalMs: 20 * 60_000,
        reducerCount,
      });
      expect(maximumSubrequests).toBeLessThanOrEqual(250_000 * 0.7);
      expect(maximumCumulativeOwnerSubrequests).toBeLessThanOrEqual(250_000 * 0.7);
      expect(maximumDurableSteps).toBeLessThan(10_000);
    },
  );

  it.each([
    ["bounded beta", 613, 13, 2_532],
    ["scale-qualified public", 6_894, 138, 28_406],
  ] as const)(
    "freezes the complete %s pre-leaf owner budget",
    (_, partitions, batches, maximum) => {
      expect(qualificationOwnerPartitionPhaseBudget(partitions)).toEqual({
        batchCount: batches,
        maximumSubrequests: maximum,
      });
    },
  );
});

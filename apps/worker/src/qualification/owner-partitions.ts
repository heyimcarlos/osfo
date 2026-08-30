import type { QualificationExecutionPlan } from "./execution";
import { qualificationEvaluationDimensionInventory } from "./qualification-evaluation-reducer";

export const qualificationPartitionChunkLimit = 1;
export const qualificationPartitionMaximumPollsPerChunk = 100;
export const qualificationPartitionWorkflowStepBudget = 10_000;
export const qualificationPartitionCreateBatchLimit = 50;
export const qualificationLeafCompletionHorizonMs = 17 * 60_000;
export const qualificationLeafFanoutMaximumDurationMs = 3 * 60_000;
export const qualificationCorrectnessReducerFanIn = 16;
export const qualificationCorrectnessLaunchPageSize = 16;
export const qualificationCorrectnessPollCount = 72;
export const qualificationCorrectnessPollIntervalMs = 20 * 60_000;
export const qualificationCorrectnessForestDeadlineMs = 24 * 60 * 60_000;
export const qualificationDimensionLevelHorizonMs = 24 * 60 * 60_000;
export const qualificationDimensionMaximumLevelCount = 4;
export const qualificationDimensionMaximumEvaluationDurationMs =
  qualificationDimensionLevelHorizonMs * qualificationDimensionMaximumLevelCount;
export const qualificationDimensionParentPollIntervalMs = 60 * 60_000;
export const qualificationDimensionParentDeadlineMs = 5 * 24 * 60 * 60_000;
export const qualificationDimensionParentPollCount =
  qualificationDimensionParentDeadlineMs / qualificationDimensionParentPollIntervalMs;
export const qualificationDimensionLaunchPageSize = 50;
export const qualificationDimensionRootOwnerSubrequestBudget =
  2 * qualificationDimensionParentPollCount + 40;

export interface QualificationPartitionChunk {
  readonly chunkIndex: number;
  readonly runId: string;
  readonly streamChunkIndex: number;
}

export interface QualificationPartitionDescriptor {
  readonly chunks: ReadonlyArray<QualificationPartitionChunk>;
  readonly firstStreamChunkIndex: number;
  readonly lastStreamChunkIndex: number;
  readonly partitionIndex: number;
}

export const qualificationPartitionWorstCaseSteps = (chunkCount: number): number =>
  chunkCount + chunkCount * qualificationPartitionMaximumPollsPerChunk;

/** Static host budget for leaf creation, inventory, exact reads, and bounded join retention. */
export const qualificationOwnerLeafFanoutBudget = (partitionCount: number) => {
  const batchCount = Math.ceil(partitionCount / qualificationPartitionCreateBatchLimit);
  return {
    batchCount,
    maximumDurableSteps: 4 * batchCount + 5,
    maximumSubrequests: 7 * partitionCount + 12 * batchCount + 4,
    maximumTerminalDurationMs:
      qualificationLeafFanoutMaximumDurationMs + qualificationLeafCompletionHorizonMs,
    maximumWorkflowOperations: 6 * batchCount + 5,
    postFinalLaunchHorizonMs: qualificationLeafCompletionHorizonMs,
    scheduledFanoutDurationMs: Math.max(0, batchCount - 1) * 1_000,
  };
};

/** Frozen request/preflight, partition fan-out reconciliation, and exact retained joins. */
export const qualificationOwnerPartitionPhaseBudget = (partitionCount: number) => {
  if (!Number.isSafeInteger(partitionCount) || partitionCount <= 0) {
    throw new Error("Qualification partition count must be a positive safe integer");
  }
  const batchCount = Math.ceil(partitionCount / qualificationPartitionCreateBatchLimit);
  return {
    batchCount,
    maximumSubrequests: 4 * partitionCount + 6 * batchCount + 2,
  };
};

export const qualificationOwnerCorrectnessLevelCounts = (
  partitionCount: number,
): ReadonlyArray<number> => {
  if (!Number.isSafeInteger(partitionCount) || partitionCount <= 0) {
    throw new Error("Qualification correctness partition count must be a positive safe integer");
  }
  const levels: Array<number> = [];
  let inputCount = partitionCount;
  do {
    const outputCount = Math.ceil(inputCount / qualificationCorrectnessReducerFanIn);
    levels.push(outputCount);
    inputCount = outputCount;
  } while (inputCount > 1);
  return levels;
};

/** Worst-case owner cost for joins, creation, status polling, and receipt authentication. */
export const qualificationOwnerCorrectnessForestBudget = (partitionCount: number) => {
  const levelCounts = qualificationOwnerCorrectnessLevelCounts(partitionCount);
  const reducerCount = levelCounts.reduce((sum, count) => sum + count, 0);
  const launchPageCount = levelCounts.reduce(
    (sum, count) => sum + Math.ceil(count / qualificationCorrectnessLaunchPageSize),
    0,
  );
  const levelPageCounts = levelCounts.map((count) =>
    Math.ceil(count / qualificationCorrectnessLaunchPageSize),
  );
  const leafJoinPageCount = Math.ceil(partitionCount / qualificationPartitionCreateBatchLimit);
  const priorLevelPageCount = levelPageCounts.slice(0, -1).reduce((sum, count) => sum + count, 0);
  const leafInventoryPageCount = Math.ceil(
    leafJoinPageCount / qualificationPartitionCreateBatchLimit,
  );
  const launchInventoryPageCount = levelPageCounts.reduce(
    (sum, count) => sum + Math.ceil(count / qualificationPartitionCreateBatchLimit),
    0,
  );
  const completionInventoryPageCount = levelPageCounts
    .slice(0, -1)
    .reduce((sum, count) => sum + Math.ceil(count / qualificationPartitionCreateBatchLimit), 0);
  const maximumSubrequests =
    2 * reducerCount * qualificationCorrectnessPollCount +
    6 * reducerCount +
    6 * launchPageCount +
    2 * leafJoinPageCount +
    2 * priorLevelPageCount +
    leafInventoryPageCount +
    launchInventoryPageCount +
    completionInventoryPageCount +
    5;
  const maximumDurableSteps =
    2 * leafJoinPageCount +
    2 * priorLevelPageCount +
    (qualificationCorrectnessPollCount + 4) * launchPageCount +
    leafInventoryPageCount +
    launchInventoryPageCount +
    completionInventoryPageCount +
    3;
  const maximumWorkflowOperations =
    maximumDurableSteps +
    (qualificationCorrectnessPollCount - 1) * launchPageCount +
    launchPageCount -
    levelCounts.length;
  return {
    deadlineMs: qualificationCorrectnessForestDeadlineMs,
    launchPageCount,
    levelCounts,
    maximumCumulativeOwnerSubrequests:
      qualificationOwnerPartitionPhaseBudget(partitionCount).maximumSubrequests +
      qualificationOwnerLeafFanoutBudget(partitionCount).maximumSubrequests +
      maximumSubrequests,
    maximumDurableSteps,
    maximumSubrequests,
    maximumWorkflowOperations,
    pollCount: qualificationCorrectnessPollCount,
    pollIntervalMs: qualificationCorrectnessPollIntervalMs,
    reducerCount,
  };
};

const safeAdd = (values: ReadonlyArray<number>): number => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Qualification dimension budget exceeds safe integer bounds");
  }
  return total;
};

/** Per-instance budget for the deep dimension coordinator and its bounded root owner. */
export const qualificationOwnerDimensionCoordinatorBudget = (plan: QualificationExecutionPlan) => {
  const inventory = qualificationEvaluationDimensionInventory(plan);
  const partitionCount = plan.runs.reduce(
    (total, run) => total + Math.ceil(run.arrivalCount / 256),
    0,
  );
  const leafJoinPageCount = Math.ceil(partitionCount / qualificationPartitionCreateBatchLimit);
  const levelWidths = new globalThis.Array<number>();
  let dimensionIndexPageCount = 0;
  let launchPageCount = 0;
  for (const dimension of inventory) {
    dimensionIndexPageCount +=
      Math.floor(dimension.lastPartitionIndex / qualificationPartitionCreateBatchLimit) -
      Math.floor(dimension.firstPartitionIndex / qualificationPartitionCreateBatchLimit) +
      1;
    for (const [level, width] of dimension.levelCounts.entries()) {
      levelWidths[level] = (levelWidths[level] ?? 0) + width;
      launchPageCount += Math.ceil(width / qualificationDimensionLaunchPageSize);
    }
  }
  const reducerCount = safeAdd(levelWidths);
  const dimensionCount = inventory.length;
  const dimensionLevelCount = safeAdd(inventory.map(({ levelCounts }) => levelCounts.length));
  const numericDimensionCount = inventory.filter(
    ({ valueType }) => valueType === "latencyMs",
  ).length;
  const selectedShardReadCount = 4 * numericDimensionCount;
  const priorCompletionPageCount = launchPageCount - dimensionCount;
  const inventoryPageCount =
    Math.ceil(dimensionIndexPageCount / 1_000) + 2 * Math.ceil(reducerCount / 1_000);
  const evaluationOutputPageCount =
    Math.ceil(dimensionCount / qualificationDimensionLaunchPageSize) +
    Math.ceil(numericDimensionCount / qualificationDimensionLaunchPageSize) +
    1;
  const maximumCoordinatorSubrequests = safeAdd([
    leafJoinPageCount,
    partitionCount,
    3 * dimensionIndexPageCount,
    Math.ceil(dimensionIndexPageCount / 1_000),
    dimensionCount,
    6 * launchPageCount,
    2 * dimensionLevelCount,
    4 * reducerCount,
    priorCompletionPageCount,
    2 * Math.ceil(reducerCount / 1_000),
    dimensionCount,
    selectedShardReadCount,
    2 * evaluationOutputPageCount,
    4,
  ]);
  const maximumCoordinatorDurableSteps = safeAdd([
    leafJoinPageCount,
    dimensionIndexPageCount,
    3 * launchPageCount,
    priorCompletionPageCount,
    inventoryPageCount,
    dimensionCount,
    evaluationOutputPageCount,
    dimensionCount,
    2 * dimensionLevelCount,
    5,
  ]);
  return {
    dimensionCount,
    dimensionLevelCount,
    dimensionIndexPageCount,
    launchPageCount,
    levelHorizonMs: qualificationDimensionLevelHorizonMs,
    levelWidths,
    maximumCoordinatorDurableSteps,
    maximumCoordinatorSubrequests,
    maximumEvaluationDurationMs: qualificationDimensionMaximumEvaluationDurationMs,
    maximumRootOwnerSubrequests:
      qualificationOwnerCorrectnessForestBudget(partitionCount).maximumCumulativeOwnerSubrequests +
      qualificationDimensionRootOwnerSubrequestBudget,
    maximumStepSubrequests: 169,
    numericDimensionCount,
    reducerCount,
    selectedShardReadCount,
  };
};

/** Freeze contiguous chunk partitions whose declared worst-case polling stays below host limits. */
export const qualificationOwnerPartitions = (
  plan: QualificationExecutionPlan,
): ReadonlyArray<QualificationPartitionDescriptor> => {
  const chunks = plan.runs.flatMap((run) =>
    Array.from({ length: Math.ceil(run.arrivalCount / 256) }, (_, chunkIndex) => ({
      chunkIndex,
      runId: run.runId,
    })),
  );
  let streamChunkIndex = 0;
  return Array.from(
    { length: Math.ceil(chunks.length / qualificationPartitionChunkLimit) },
    (_, partitionIndex) => {
      const partitionChunks = chunks
        .slice(
          partitionIndex * qualificationPartitionChunkLimit,
          (partitionIndex + 1) * qualificationPartitionChunkLimit,
        )
        .map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          runId: chunk.runId,
          streamChunkIndex: streamChunkIndex++,
        }));
      const first = partitionChunks[0];
      const last = partitionChunks.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error("Qualification partition cannot be empty");
      }
      return {
        chunks: partitionChunks,
        firstStreamChunkIndex: first.streamChunkIndex,
        lastStreamChunkIndex: last.streamChunkIndex,
        partitionIndex,
      };
    },
  );
};

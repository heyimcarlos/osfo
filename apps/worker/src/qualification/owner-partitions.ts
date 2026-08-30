import type { QualificationExecutionPlan } from "./execution";

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

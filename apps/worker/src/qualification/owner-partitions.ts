import type { QualificationExecutionPlan } from "./execution";

export const qualificationPartitionChunkLimit = 1;
export const qualificationPartitionMaximumPollsPerChunk = 100;
export const qualificationPartitionWorkflowStepBudget = 10_000;
export const qualificationPartitionCreateBatchLimit = 50;
export const qualificationLeafCompletionHorizonMs = 17 * 60_000;
export const qualificationLeafFanoutMaximumDurationMs = 3 * 60_000;

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

import { describe, expect, it } from "@effect/vitest";

import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "./qualification-manifest";
import { createQualificationExecutionPlan } from "./execution";
import {
  qualificationOwnerPartitions,
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
});

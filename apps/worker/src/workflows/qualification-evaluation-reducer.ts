import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";

import {
  mergeQualificationSortedPage,
  qualificationEvaluationMaximumDimensionContinuations,
  QualificationEvaluationSortedRunDescriptor,
  QualificationEvaluationSortedRunReceipt,
  QualificationEvaluationSortedRunShard,
  qualificationEvaluationSortedRunReceipt,
  qualificationEvaluationSortedRunShard,
  retainQualificationEvaluationArtifact,
  type QualificationEvaluationArtifactBucket,
  type QualificationEvaluationMergeInput,
} from "../qualification/qualification-evaluation-reducer";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationEvaluationReducerWorkflowPayload } from "../workflow-contracts";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Cloudflare Workflow and R2 are Promise-only durable host boundaries; one output page is intentionally one serializable durable step. */

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CursorCheckpoint = Schema.Struct({
  artifactId: Schema.String,
  checksum: Schema.String,
  cursors: Schema.Array(
    Schema.Struct({
      consumedCount: NonNegativeInteger,
      previousMaximum: Schema.NullOr(Schema.Finite),
      previousShardChecksum: Schema.String,
      runId: Schema.String,
      shardIndex: NonNegativeInteger,
      valueOffset: NonNegativeInteger,
    }),
  ),
  executionId: Schema.String,
  firstOutputShardChecksum: Schema.NullOr(Schema.String),
  lastEmittedValue: Schema.NullOr(Schema.Finite),
  outputCount: NonNegativeInteger,
  outputIndex: NonNegativeInteger,
  outputPreviousShardChecksum: Schema.String,
  outputRunId: Schema.String,
  planChecksum: Schema.String,
  version: Schema.Literal("qualification-evaluation-reducer-cursor-v1"),
});
type CursorCheckpoint = typeof CursorCheckpoint.Type;

interface QualificationEvaluationReducerEnv {
  readonly ARTIFACTS: QualificationEvaluationArtifactBucket;
}

export interface QualificationEvaluationReducerStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
}

const padded = (value: number) => value.toString().padStart(8, "0");
const shardArtifactId = (prefix: string, index: number) => `${prefix}/${padded(index)}.json`;
const cursorArtifactId = (payload: QualificationEvaluationReducerWorkflowPayload, index: number) =>
  `qualification/executions/${encodeURIComponent(payload.executionId)}/evaluation-reducer-cursors/${encodeURIComponent(payload.outputRunId)}/${padded(index)}.json`;
const receiptArtifactId = (payload: QualificationEvaluationReducerWorkflowPayload) =>
  `${payload.outputArtifactPrefix}/receipt.json`;

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readInputReceipt = async (
  env: QualificationEvaluationReducerEnv,
  payload: QualificationEvaluationReducerWorkflowPayload,
  reference: QualificationEvaluationReducerWorkflowPayload["inputs"][number],
) => {
  const retained = await env.ARTIFACTS.get(reference.artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let receipt: typeof QualificationEvaluationSortedRunReceipt.Type;
  try {
    receipt = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationSortedRunReceipt))(
      encoded,
    );
  } catch {
    return null;
  }
  const { checksum, ...content } = receipt;
  return receipt.artifactId === reference.artifactId &&
    receipt.checksum === reference.checksum &&
    receipt.checksum === qualificationChecksum(content) &&
    receipt.dimension === payload.dimension &&
    receipt.executionId === payload.executionId &&
    receipt.planChecksum === payload.planChecksum &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-dimension"] === receipt.dimension &&
    retained.customMetadata?.["osfo-execution-id"] === payload.executionId &&
    retained.customMetadata?.["osfo-input-checksum"] ===
      qualificationChecksum(receipt.inputReceiptChecksums) &&
    retained.customMetadata?.["osfo-kind"] === "qualification-evaluation-sorted-run-receipt-v1" &&
    retained.customMetadata?.["osfo-plan-checksum"] === payload.planChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(receipt.valueCount) &&
    retained.customMetadata?.["osfo-run-id"] === receipt.runId &&
    retained.customMetadata?.["osfo-terminal-checksum"] === receipt.terminalShardChecksum
    ? receipt
    : null;
};

const readInputShard = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly cursor: CursorCheckpoint["cursors"][number];
  readonly descriptor: typeof QualificationEvaluationSortedRunDescriptor.Type;
  readonly executionId: string;
  readonly planChecksum: string;
}) => {
  if (input.cursor.shardIndex === input.descriptor.shardCount) {
    return input.cursor.consumedCount === input.descriptor.valueCount &&
      input.cursor.valueOffset === 0 &&
      input.cursor.previousShardChecksum === input.descriptor.terminalShardChecksum
      ? null
      : undefined;
  }
  const artifactId = shardArtifactId(input.descriptor.artifactPrefix, input.cursor.shardIndex);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return undefined;
  const encoded = await retained.text();
  let shard: typeof QualificationEvaluationSortedRunShard.Type;
  try {
    shard = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationSortedRunShard))(
      encoded,
    );
  } catch {
    return undefined;
  }
  const { checksum, ...content } = shard;
  const isFirst = shard.index === 0;
  const isLast = shard.index === input.descriptor.shardCount - 1;
  return shard.artifactId === artifactId &&
    shard.dimension === input.descriptor.dimension &&
    shard.executionId === input.executionId &&
    shard.index === input.cursor.shardIndex &&
    shard.planChecksum === input.planChecksum &&
    shard.previousShardChecksum === input.cursor.previousShardChecksum &&
    shard.runId === input.descriptor.runId &&
    shard.checksum === qualificationChecksum(content) &&
    (isFirst ? shard.checksum === input.descriptor.firstShardChecksum : true) &&
    (isLast ? shard.checksum === input.descriptor.terminalShardChecksum : true) &&
    (input.cursor.previousMaximum === null
      ? isFirst
      : shard.minimum >= input.cursor.previousMaximum) &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-dimension"] === shard.dimension &&
    retained.customMetadata?.["osfo-execution-id"] === input.executionId &&
    retained.customMetadata?.["osfo-index"] === String(shard.index) &&
    retained.customMetadata?.["osfo-kind"] === "qualification-evaluation-sorted-run-v1" &&
    retained.customMetadata?.["osfo-previous-checksum"] === shard.previousShardChecksum &&
    retained.customMetadata?.["osfo-plan-checksum"] === input.planChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(shard.values.length) &&
    retained.customMetadata?.["osfo-run-id"] === shard.runId
    ? shard
    : undefined;
};

const initialCheckpoint = (
  payload: QualificationEvaluationReducerWorkflowPayload,
  descriptors: ReadonlyArray<typeof QualificationEvaluationSortedRunDescriptor.Type>,
): CursorCheckpoint => {
  const content = {
    artifactId: cursorArtifactId(payload, 0),
    cursors: descriptors.map(({ runId }) => ({
      consumedCount: 0,
      previousMaximum: null,
      previousShardChecksum: "NONE",
      runId,
      shardIndex: 0,
      valueOffset: 0,
    })),
    executionId: payload.executionId,
    firstOutputShardChecksum: null,
    lastEmittedValue: null,
    outputCount: 0,
    outputIndex: 0,
    outputPreviousShardChecksum: "NONE",
    outputRunId: payload.outputRunId,
    planChecksum: payload.planChecksum,
    version: "qualification-evaluation-reducer-cursor-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

const retainCursor = async (
  env: QualificationEvaluationReducerEnv,
  checkpoint: CursorCheckpoint,
) => {
  const outcome = await retainQualificationEvaluationArtifact({
    artifactId: checkpoint.artifactId,
    bucket: env.ARTIFACTS,
    checksum: checkpoint.checksum,
    encoded: canonicalQualificationJson(checkpoint),
    executionId: checkpoint.executionId,
    kind: "qualification-evaluation-reducer-cursor-v1",
    metadata: {
      "osfo-index": String(checkpoint.outputIndex),
      "osfo-output-count": String(checkpoint.outputCount),
      "osfo-output-run-id": checkpoint.outputRunId,
      "osfo-previous-checksum": checkpoint.outputPreviousShardChecksum,
    },
    planChecksum: checkpoint.planChecksum,
  });
  if (outcome === "CONFLICT") throw new Error("Qualification reducer cursor conflicts");
  return checkpoint;
};

const nextCheckpoint = (input: {
  readonly checkpoint: CursorCheckpoint;
  readonly inputShards: ReadonlyArray<typeof QualificationEvaluationSortedRunShard.Type | null>;
  readonly merged: NonNullable<ReturnType<typeof mergeQualificationSortedPage>>;
  readonly outputChecksum: string;
  readonly outputLastValue: number;
  readonly payload: QualificationEvaluationReducerWorkflowPayload;
}): CursorCheckpoint => {
  const cursors = input.checkpoint.cursors.map((cursor, index) => {
    const shard = input.inputShards[index];
    const mergedCursor = input.merged.cursors[index];
    if (shard === undefined || mergedCursor === undefined) {
      throw new Error("Qualification reducer cursor cardinality conflicts");
    }
    if (shard === null) return cursor;
    const consumed = mergedCursor.valueOffset - cursor.valueOffset;
    if (consumed < 0) throw new Error("Qualification reducer cursor moved backwards");
    return mergedCursor.valueOffset === shard.values.length
      ? {
          consumedCount: cursor.consumedCount + consumed,
          previousMaximum: shard.maximum,
          previousShardChecksum: shard.checksum,
          runId: cursor.runId,
          shardIndex: cursor.shardIndex + 1,
          valueOffset: 0,
        }
      : {
          ...cursor,
          consumedCount: cursor.consumedCount + consumed,
          valueOffset: mergedCursor.valueOffset,
        };
  });
  const content = {
    artifactId: cursorArtifactId(input.payload, input.checkpoint.outputIndex + 1),
    cursors,
    executionId: input.payload.executionId,
    firstOutputShardChecksum: input.checkpoint.firstOutputShardChecksum ?? input.outputChecksum,
    lastEmittedValue: input.outputLastValue,
    outputCount: input.checkpoint.outputCount + input.merged.values.length,
    outputIndex: input.checkpoint.outputIndex + 1,
    outputPreviousShardChecksum: input.outputChecksum,
    outputRunId: input.payload.outputRunId,
    planChecksum: input.payload.planChecksum,
    version: "qualification-evaluation-reducer-cursor-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

/** Resumable exact k-way merge. Each durable step reads and writes one bounded sample page. */
export const runQualificationEvaluationReducer = async (input: {
  readonly env: QualificationEvaluationReducerEnv;
  readonly payload: QualificationEvaluationReducerWorkflowPayload;
  readonly step: QualificationEvaluationReducerStep;
}) => {
  if (
    input.payload.inputs.length === 0 ||
    input.payload.inputs.length > 16 ||
    new Set(input.payload.inputs.map(({ checksum }) => checksum)).size !==
      input.payload.inputs.length
  ) {
    throw new Error("Qualification reducer inputs conflict");
  }
  const verifiedInputs = await input.step.do("verify evaluation input receipts", async () => {
    const receipts = await Promise.all(
      input.payload.inputs.map((reference) =>
        readInputReceipt(input.env, input.payload, reference),
      ),
    );
    if (receipts.some((receipt) => receipt === null)) {
      throw new Error("Qualification reducer input receipt conflicts");
    }
    return receipts.map((receipt) => {
      if (receipt === null) throw new Error("Qualification reducer input receipt is missing");
      return receipt;
    });
  });
  let checkpoint = initialCheckpoint(input.payload, verifiedInputs);
  for (
    let continuation = 0;
    continuation < qualificationEvaluationMaximumDimensionContinuations;
    continuation += 1
  ) {
    const result = await input.step.do(`merge evaluation page ${continuation}`, async () => {
      const inputShards = await Promise.all(
        verifiedInputs.map((descriptor, index) => {
          const cursor = checkpoint.cursors[index];
          if (cursor === undefined) return Promise.resolve(undefined);
          return readInputShard({
            bucket: input.env.ARTIFACTS,
            cursor,
            descriptor,
            executionId: input.payload.executionId,
            planChecksum: input.payload.planChecksum,
          });
        }),
      );
      if (inputShards.some((shard) => shard === undefined)) {
        throw new Error("Qualification reducer input shard conflicts");
      }
      const mergeInputs = inputShards.map((shard, index): QualificationEvaluationMergeInput => {
        const descriptor = verifiedInputs[index];
        if (descriptor === undefined) {
          throw new Error("Qualification reducer input descriptor is missing");
        }
        return {
          descriptor,
          shard: shard ?? null,
          valueOffset: checkpoint.cursors[index]?.valueOffset ?? 0,
        };
      });
      const merged = mergeQualificationSortedPage(mergeInputs);
      if (merged === null || merged.values.length === 0) {
        throw new Error("Qualification reducer produced no exact output page");
      }
      const first = merged.values[0];
      const last = merged.values.at(-1);
      if (
        first === undefined ||
        last === undefined ||
        (checkpoint.lastEmittedValue !== null && first < checkpoint.lastEmittedValue)
      ) {
        throw new Error("Qualification reducer output order conflicts");
      }
      const artifactId = shardArtifactId(
        input.payload.outputArtifactPrefix,
        checkpoint.outputIndex,
      );
      const output = qualificationEvaluationSortedRunShard({
        artifactId,
        dimension: input.payload.dimension,
        executionId: input.payload.executionId,
        index: checkpoint.outputIndex,
        planChecksum: input.payload.planChecksum,
        previousShardChecksum: checkpoint.outputPreviousShardChecksum,
        runId: input.payload.outputRunId,
        values: merged.values,
      });
      if (output === null) throw new Error("Qualification reducer output is invalid");
      const retained = await retainQualificationEvaluationArtifact({
        artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: output.checksum,
        encoded: canonicalQualificationJson(output),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-sorted-run-v1",
        metadata: {
          "osfo-dimension": output.dimension,
          "osfo-index": String(output.index),
          "osfo-previous-checksum": output.previousShardChecksum,
          "osfo-record-count": String(output.values.length),
          "osfo-run-id": output.runId,
        },
        planChecksum: input.payload.planChecksum,
      });
      if (retained === "CONFLICT") throw new Error("Qualification reducer output conflicts");
      const next = nextCheckpoint({
        checkpoint,
        inputShards: inputShards.map((shard) => shard ?? null),
        merged,
        outputChecksum: output.checksum,
        outputLastValue: last,
        payload: input.payload,
      });
      await retainCursor(input.env, next);
      return next;
    });
    checkpoint = result;
    const exhausted = checkpoint.cursors.every((cursor, index) => {
      const descriptor = verifiedInputs[index];
      return (
        descriptor !== undefined &&
        cursor.shardIndex === descriptor.shardCount &&
        cursor.valueOffset === 0 &&
        cursor.consumedCount === descriptor.valueCount &&
        cursor.previousShardChecksum === descriptor.terminalShardChecksum
      );
    });
    if (!exhausted) continue;
    return input.step.do("verify output and retain evaluation run receipt", async () => {
      const firstShard = await readInputShard({
        bucket: input.env.ARTIFACTS,
        cursor: {
          consumedCount: 0,
          previousMaximum: null,
          previousShardChecksum: "NONE",
          runId: input.payload.outputRunId,
          shardIndex: 0,
          valueOffset: 0,
        },
        descriptor: QualificationEvaluationSortedRunDescriptor.make({
          artifactPrefix: input.payload.outputArtifactPrefix,
          dimension: input.payload.dimension,
          firstShardChecksum: checkpoint.firstOutputShardChecksum ?? "missing-first-checksum",
          maximum: checkpoint.lastEmittedValue ?? 0,
          minimum: 0,
          runId: input.payload.outputRunId,
          shardCount: checkpoint.outputIndex,
          terminalShardChecksum: checkpoint.outputPreviousShardChecksum,
          valueCount: checkpoint.outputCount,
        }),
        executionId: input.payload.executionId,
        planChecksum: input.payload.planChecksum,
      });
      if (firstShard === null || firstShard === undefined) {
        throw new Error("Qualification reducer first output conflicts");
      }
      const descriptor = QualificationEvaluationSortedRunDescriptor.make({
        artifactPrefix: input.payload.outputArtifactPrefix,
        dimension: input.payload.dimension,
        firstShardChecksum: firstShard.checksum,
        maximum: checkpoint.lastEmittedValue ?? firstShard.maximum,
        minimum: firstShard.minimum,
        runId: input.payload.outputRunId,
        shardCount: checkpoint.outputIndex,
        terminalShardChecksum: checkpoint.outputPreviousShardChecksum,
        valueCount: checkpoint.outputCount,
      });
      const receipt = qualificationEvaluationSortedRunReceipt({
        artifactId: receiptArtifactId(input.payload),
        descriptor,
        executionId: input.payload.executionId,
        index: input.payload.index,
        inputReceiptChecksums: input.payload.inputs.map(({ checksum }) => checksum),
        level: input.payload.level,
        planChecksum: input.payload.planChecksum,
      });
      if (receipt === null) throw new Error("Qualification reducer receipt is invalid");
      const retained = await retainQualificationEvaluationArtifact({
        artifactId: receipt.artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: receipt.checksum,
        encoded: canonicalQualificationJson(receipt),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-sorted-run-receipt-v1",
        metadata: {
          "osfo-dimension": receipt.dimension,
          "osfo-input-checksum": qualificationChecksum(receipt.inputReceiptChecksums),
          "osfo-record-count": String(receipt.valueCount),
          "osfo-run-id": receipt.runId,
          "osfo-terminal-checksum": receipt.terminalShardChecksum,
        },
        planChecksum: input.payload.planChecksum,
      });
      if (retained === "CONFLICT") throw new Error("Qualification reducer receipt conflicts");
      return receipt;
    });
  }
  throw new Error("Qualification reducer exceeded its bounded continuation budget");
};

export class QualificationEvaluationReducerWorkflow extends WorkflowEntrypoint<
  QualificationEvaluationReducerEnv,
  QualificationEvaluationReducerWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationEvaluationReducerWorkflowPayload>>,
    step: WorkflowStep,
  ) {
    return runQualificationEvaluationReducer({ env: this.env, payload: event.payload, step });
  }
}

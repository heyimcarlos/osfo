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
  qualificationSortedValueFollows,
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
const SortedValue = Schema.Union([Schema.String, Schema.Finite]);
const CursorCheckpoint = Schema.Struct({
  artifactId: Schema.String,
  checksum: Schema.String,
  cursors: Schema.Array(
    Schema.Struct({
      consumedCount: NonNegativeInteger,
      previousMaximum: Schema.NullOr(SortedValue),
      previousShardChecksum: Schema.String,
      runId: Schema.String,
      shardIndex: NonNegativeInteger,
      valueOffset: NonNegativeInteger,
    }),
  ),
  executionId: Schema.String,
  firstOutputShardChecksum: Schema.NullOr(Schema.String),
  lastEmittedValue: Schema.NullOr(SortedValue),
  outputCount: NonNegativeInteger,
  outputIndex: NonNegativeInteger,
  outputPreviousShardChecksum: Schema.String,
  outputRunId: Schema.String,
  planChecksum: Schema.String,
  valueType: Schema.Literals(["identity", "latencyMs"]),
  version: Schema.Literal("qualification-evaluation-reducer-cursor-v2"),
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

const aggregateDescriptorFields = (
  receipts: ReadonlyArray<typeof QualificationEvaluationSortedRunReceipt.Type>,
) => {
  const first = receipts[0];
  const last = receipts.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    receipts.some(
      (receipt, index) =>
        receipt.dimension !== first.dimension ||
        receipt.valueType !== first.valueType ||
        receipt.firstPartitionIndex > receipt.lastPartitionIndex ||
        (index > 0 &&
          receipt.firstPartitionIndex !==
            (receipts[index - 1]?.lastPartitionIndex ?? Number.NaN) + 1),
    )
  ) {
    return null;
  }
  const denominatorCount = receipts.reduce((total, receipt) => total + receipt.denominatorCount, 0);
  const missingRootCount = receipts.reduce((total, receipt) => total + receipt.missingRootCount, 0);
  return {
    denominatorChainDigest: qualificationChecksum(
      receipts.map((receipt) => ({
        checksum: receipt.checksum,
        denominatorChainDigest: receipt.denominatorChainDigest,
        denominatorCount: receipt.denominatorCount,
        firstPartitionIndex: receipt.firstPartitionIndex,
        lastPartitionIndex: receipt.lastPartitionIndex,
      })),
    ),
    denominatorCount,
    firstPartitionIndex: first.firstPartitionIndex,
    inputReceiptChainDigest: qualificationChecksum(receipts.map(({ checksum }) => checksum)),
    lastPartitionIndex: last.lastPartitionIndex,
    missingRootCount,
    sampleStatus: missingRootCount > 0 ? ("MISSING" as const) : ("COMPLETE" as const),
    valueType: first.valueType,
  };
};

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
    retained.customMetadata?.["osfo-denominator-chain-digest"] === receipt.denominatorChainDigest &&
    retained.customMetadata?.["osfo-denominator-count"] === String(receipt.denominatorCount) &&
    retained.customMetadata?.["osfo-first-partition-index"] ===
      String(receipt.firstPartitionIndex) &&
    retained.customMetadata?.["osfo-input-receipt-chain-digest"] ===
      receipt.inputReceiptChainDigest &&
    retained.customMetadata?.["osfo-kind"] === "qualification-evaluation-sorted-run-receipt-v2" &&
    retained.customMetadata?.["osfo-last-partition-index"] === String(receipt.lastPartitionIndex) &&
    retained.customMetadata?.["osfo-missing-root-count"] === String(receipt.missingRootCount) &&
    retained.customMetadata?.["osfo-plan-checksum"] === payload.planChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(receipt.valueCount) &&
    retained.customMetadata?.["osfo-run-id"] === receipt.runId &&
    retained.customMetadata?.["osfo-sample-status"] === receipt.sampleStatus &&
    retained.customMetadata?.["osfo-value-type"] === receipt.valueType &&
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
      : qualificationSortedValueFollows(
          shard.valueType,
          shard.minimum,
          input.cursor.previousMaximum,
        )) &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-dimension"] === shard.dimension &&
    retained.customMetadata?.["osfo-execution-id"] === input.executionId &&
    retained.customMetadata?.["osfo-index"] === String(shard.index) &&
    retained.customMetadata?.["osfo-denominator-chain-digest"] === shard.denominatorChainDigest &&
    retained.customMetadata?.["osfo-denominator-count"] === String(shard.denominatorCount) &&
    retained.customMetadata?.["osfo-first-partition-index"] === String(shard.firstPartitionIndex) &&
    retained.customMetadata?.["osfo-input-receipt-chain-digest"] ===
      shard.inputReceiptChainDigest &&
    retained.customMetadata?.["osfo-kind"] === "qualification-evaluation-sorted-run-v2" &&
    retained.customMetadata?.["osfo-last-partition-index"] === String(shard.lastPartitionIndex) &&
    retained.customMetadata?.["osfo-missing-root-count"] === String(shard.missingRootCount) &&
    retained.customMetadata?.["osfo-previous-checksum"] === shard.previousShardChecksum &&
    retained.customMetadata?.["osfo-plan-checksum"] === input.planChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(shard.values.length) &&
    retained.customMetadata?.["osfo-run-id"] === shard.runId &&
    retained.customMetadata?.["osfo-sample-status"] === shard.sampleStatus &&
    retained.customMetadata?.["osfo-value-type"] === shard.valueType
    ? shard
    : undefined;
};

const initialCheckpoint = (
  payload: QualificationEvaluationReducerWorkflowPayload,
  descriptors: ReadonlyArray<typeof QualificationEvaluationSortedRunDescriptor.Type>,
): CursorCheckpoint => {
  const content = {
    artifactId: cursorArtifactId(payload, 0),
    cursors: descriptors.map(({ runId, terminalShardChecksum, valueCount }) => ({
      consumedCount: 0,
      previousMaximum: null,
      previousShardChecksum: valueCount === 0 ? terminalShardChecksum : "NONE",
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
    valueType: descriptors[0]?.valueType ?? "latencyMs",
    version: "qualification-evaluation-reducer-cursor-v2" as const,
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
    kind: "qualification-evaluation-reducer-cursor-v2",
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
  readonly outputLastValue: number | string;
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
    valueType: input.checkpoint.valueType,
    version: "qualification-evaluation-reducer-cursor-v2" as const,
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
    const receipts = new Array<Awaited<ReturnType<typeof readInputReceipt>>>();
    for (const reference of input.payload.inputs) {
      receipts.push(await readInputReceipt(input.env, input.payload, reference));
    }
    if (receipts.some((receipt) => receipt === null)) {
      throw new Error("Qualification reducer input receipt conflicts");
    }
    return receipts.map((receipt) => {
      if (receipt === null) throw new Error("Qualification reducer input receipt is missing");
      return receipt;
    });
  });
  const aggregate = aggregateDescriptorFields(verifiedInputs);
  if (
    aggregate === null ||
    aggregate.denominatorChainDigest !== input.payload.denominatorChainDigest ||
    aggregate.denominatorCount !== input.payload.denominatorCount ||
    aggregate.firstPartitionIndex !== input.payload.firstPartitionIndex ||
    aggregate.inputReceiptChainDigest !== input.payload.inputReceiptChainDigest ||
    aggregate.lastPartitionIndex !== input.payload.lastPartitionIndex ||
    aggregate.missingRootCount !== input.payload.missingRootCount ||
    aggregate.valueType !== input.payload.valueType
  ) {
    throw new Error("Qualification reducer input ranges conflict");
  }
  let checkpoint = initialCheckpoint(input.payload, verifiedInputs);
  if (verifiedInputs.every(({ valueCount }) => valueCount === 0)) {
    return input.step.do("retain zero evaluation run receipt", async () => {
      const descriptorBase = {
        artifactPrefix: input.payload.outputArtifactPrefix,
        denominatorChainDigest: aggregate.denominatorChainDigest,
        denominatorCount: aggregate.denominatorCount,
        dimension: input.payload.dimension,
        firstPartitionIndex: aggregate.firstPartitionIndex,
        firstShardChecksum: "ZERO",
        inputReceiptChainDigest: aggregate.inputReceiptChainDigest,
        lastPartitionIndex: aggregate.lastPartitionIndex,
        maximum: null,
        minimum: null,
        missingRootCount: aggregate.missingRootCount,
        runId: input.payload.outputRunId,
        sampleStatus: aggregate.sampleStatus,
        shardCount: 0,
        terminalShardChecksum: "ZERO",
        valueCount: 0,
      };
      const descriptor = QualificationEvaluationSortedRunDescriptor.make(
        aggregate.valueType === "identity"
          ? { ...descriptorBase, valueType: "identity" }
          : { ...descriptorBase, valueType: "latencyMs" },
      );
      const receipt = qualificationEvaluationSortedRunReceipt({
        artifactId: receiptArtifactId(input.payload),
        descriptor,
        executionId: input.payload.executionId,
        index: input.payload.index,
        inputReceiptChecksums: input.payload.inputs.map(({ checksum }) => checksum),
        level: input.payload.level,
        planChecksum: input.payload.planChecksum,
      });
      if (receipt === null) throw new Error("Qualification zero reducer receipt is invalid");
      const retained = await retainQualificationEvaluationArtifact({
        artifactId: receipt.artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: receipt.checksum,
        encoded: canonicalQualificationJson(receipt),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-sorted-run-receipt-v2",
        metadata: {
          "osfo-denominator-chain-digest": receipt.denominatorChainDigest,
          "osfo-denominator-count": String(receipt.denominatorCount),
          "osfo-dimension": receipt.dimension,
          "osfo-first-partition-index": String(receipt.firstPartitionIndex),
          "osfo-input-checksum": qualificationChecksum(receipt.inputReceiptChecksums),
          "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
          "osfo-last-partition-index": String(receipt.lastPartitionIndex),
          "osfo-missing-root-count": String(receipt.missingRootCount),
          "osfo-record-count": "0",
          "osfo-run-id": receipt.runId,
          "osfo-sample-status": receipt.sampleStatus,
          "osfo-terminal-checksum": "ZERO",
          "osfo-value-type": receipt.valueType,
        },
        planChecksum: input.payload.planChecksum,
      });
      if (retained === "CONFLICT") throw new Error("Qualification zero reducer conflicts");
      return receipt;
    });
  }
  for (
    let continuation = 0;
    continuation < qualificationEvaluationMaximumDimensionContinuations;
    continuation += 1
  ) {
    const result = await input.step.do(`merge evaluation page ${continuation}`, async () => {
      const inputShards = new Array<Awaited<ReturnType<typeof readInputShard>>>();
      for (const [index, descriptor] of verifiedInputs.entries()) {
        const cursor = checkpoint.cursors[index];
        inputShards.push(
          cursor === undefined
            ? undefined
            : await readInputShard({
                bucket: input.env.ARTIFACTS,
                cursor,
                descriptor,
                executionId: input.payload.executionId,
                planChecksum: input.payload.planChecksum,
              }),
        );
      }
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
        (checkpoint.lastEmittedValue !== null &&
          !qualificationSortedValueFollows(aggregate.valueType, first, checkpoint.lastEmittedValue))
      ) {
        throw new Error("Qualification reducer output order conflicts");
      }
      const artifactId = shardArtifactId(
        input.payload.outputArtifactPrefix,
        checkpoint.outputIndex,
      );
      const output = qualificationEvaluationSortedRunShard({
        artifactId,
        denominatorChainDigest: aggregate.denominatorChainDigest,
        denominatorCount: aggregate.denominatorCount,
        dimension: input.payload.dimension,
        executionId: input.payload.executionId,
        firstPartitionIndex: aggregate.firstPartitionIndex,
        index: checkpoint.outputIndex,
        inputReceiptChainDigest: aggregate.inputReceiptChainDigest,
        lastPartitionIndex: aggregate.lastPartitionIndex,
        missingRootCount: aggregate.missingRootCount,
        planChecksum: input.payload.planChecksum,
        previousShardChecksum: checkpoint.outputPreviousShardChecksum,
        runId: input.payload.outputRunId,
        sampleStatus: aggregate.sampleStatus,
        ...(merged.valueType === "identity"
          ? { valueType: "identity" as const, values: merged.values.map(String) }
          : { valueType: "latencyMs" as const, values: merged.values.map(Number) }),
      });
      if (output === null) throw new Error("Qualification reducer output is invalid");
      const retained = await retainQualificationEvaluationArtifact({
        artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: output.checksum,
        encoded: canonicalQualificationJson(output),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-sorted-run-v2",
        metadata: {
          "osfo-denominator-chain-digest": output.denominatorChainDigest,
          "osfo-denominator-count": String(output.denominatorCount),
          "osfo-dimension": output.dimension,
          "osfo-first-partition-index": String(output.firstPartitionIndex),
          "osfo-index": String(output.index),
          "osfo-input-receipt-chain-digest": output.inputReceiptChainDigest,
          "osfo-last-partition-index": String(output.lastPartitionIndex),
          "osfo-missing-root-count": String(output.missingRootCount),
          "osfo-previous-checksum": output.previousShardChecksum,
          "osfo-record-count": String(output.values.length),
          "osfo-run-id": output.runId,
          "osfo-sample-status": output.sampleStatus,
          "osfo-value-type": output.valueType,
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
      const provisionalDescriptorBase = {
        artifactPrefix: input.payload.outputArtifactPrefix,
        denominatorChainDigest: aggregate.denominatorChainDigest,
        denominatorCount: aggregate.denominatorCount,
        dimension: input.payload.dimension,
        firstPartitionIndex: aggregate.firstPartitionIndex,
        firstShardChecksum: checkpoint.firstOutputShardChecksum ?? "missing-first-checksum",
        inputReceiptChainDigest: aggregate.inputReceiptChainDigest,
        lastPartitionIndex: aggregate.lastPartitionIndex,
        missingRootCount: aggregate.missingRootCount,
        runId: input.payload.outputRunId,
        sampleStatus: aggregate.sampleStatus,
        shardCount: checkpoint.outputIndex,
        terminalShardChecksum: checkpoint.outputPreviousShardChecksum,
        valueCount: checkpoint.outputCount,
      };
      const provisionalDescriptor =
        aggregate.valueType === "identity"
          ? QualificationEvaluationSortedRunDescriptor.make({
              ...provisionalDescriptorBase,
              maximum: Schema.is(Schema.String)(checkpoint.lastEmittedValue)
                ? checkpoint.lastEmittedValue
                : "missing-last-value",
              minimum: "pending-first-value",
              valueType: "identity",
            })
          : QualificationEvaluationSortedRunDescriptor.make({
              ...provisionalDescriptorBase,
              maximum: Schema.is(Schema.Finite)(checkpoint.lastEmittedValue)
                ? checkpoint.lastEmittedValue
                : 0,
              minimum: 0,
              valueType: "latencyMs",
            });
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
        descriptor: provisionalDescriptor,
        executionId: input.payload.executionId,
        planChecksum: input.payload.planChecksum,
      });
      if (firstShard === null || firstShard === undefined) {
        throw new Error("Qualification reducer first output conflicts");
      }
      const finalDescriptorBase = {
        artifactPrefix: input.payload.outputArtifactPrefix,
        denominatorChainDigest: aggregate.denominatorChainDigest,
        denominatorCount: aggregate.denominatorCount,
        dimension: input.payload.dimension,
        firstShardChecksum: firstShard.checksum,
        firstPartitionIndex: aggregate.firstPartitionIndex,
        inputReceiptChainDigest: aggregate.inputReceiptChainDigest,
        lastPartitionIndex: aggregate.lastPartitionIndex,
        missingRootCount: aggregate.missingRootCount,
        runId: input.payload.outputRunId,
        sampleStatus: aggregate.sampleStatus,
        shardCount: checkpoint.outputIndex,
        terminalShardChecksum: checkpoint.outputPreviousShardChecksum,
        valueCount: checkpoint.outputCount,
      };
      const descriptor =
        aggregate.valueType === "identity" && firstShard.valueType === "identity"
          ? QualificationEvaluationSortedRunDescriptor.make({
              ...finalDescriptorBase,
              maximum: Schema.is(Schema.String)(checkpoint.lastEmittedValue)
                ? checkpoint.lastEmittedValue
                : firstShard.maximum,
              minimum: firstShard.minimum,
              valueType: "identity",
            })
          : aggregate.valueType === "latencyMs" && firstShard.valueType === "latencyMs"
            ? QualificationEvaluationSortedRunDescriptor.make({
                ...finalDescriptorBase,
                maximum: Schema.is(Schema.Finite)(checkpoint.lastEmittedValue)
                  ? checkpoint.lastEmittedValue
                  : firstShard.maximum,
                minimum: firstShard.minimum,
                valueType: "latencyMs",
              })
            : null;
      if (descriptor === null) throw new Error("Qualification reducer value type conflicts");
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
        kind: "qualification-evaluation-sorted-run-receipt-v2",
        metadata: {
          "osfo-denominator-chain-digest": receipt.denominatorChainDigest,
          "osfo-denominator-count": String(receipt.denominatorCount),
          "osfo-dimension": receipt.dimension,
          "osfo-first-partition-index": String(receipt.firstPartitionIndex),
          "osfo-input-checksum": qualificationChecksum(receipt.inputReceiptChecksums),
          "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
          "osfo-last-partition-index": String(receipt.lastPartitionIndex),
          "osfo-missing-root-count": String(receipt.missingRootCount),
          "osfo-record-count": String(receipt.valueCount),
          "osfo-run-id": receipt.runId,
          "osfo-sample-status": receipt.sampleStatus,
          "osfo-terminal-checksum": receipt.terminalShardChecksum,
          "osfo-value-type": receipt.valueType,
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

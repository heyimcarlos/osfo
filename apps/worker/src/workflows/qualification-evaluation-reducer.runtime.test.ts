/* oxlint-disable effecttsgo/async-function -- Runtime fakes model Promise-native Workflow and R2 boundaries. */
import { expect, it } from "vitest";
import { Schema } from "effect";

import {
  QualificationEvaluationSortedRunShard,
  QualificationEvaluationSortedRunReceipt,
  qualificationEvaluationSortedRunReceipt,
  qualificationEvaluationSortedRunShard,
  retainQualificationEvaluationArtifact,
} from "../qualification/qualification-evaluation-reducer";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationEvaluationReducerWorkflowPayload } from "../workflow-contracts";
import { runQualificationEvaluationReducer } from "./qualification-evaluation-reducer";

const padded = (value: number) => value.toString().padStart(8, "0");

const runtime = async (options?: {
  readonly failAfterStep?: string;
  readonly failFirstCursorPut?: boolean;
  readonly runs?: readonly [ReadonlyArray<number>, ReadonlyArray<number>];
}) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  let failCursorPut = options?.failFirstCursorPut === true;
  let outputWrites = 0;
  const bucket = {
    get: (key: string) => {
      const object = retained.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : {
              customMetadata: object.customMetadata,
              text: () => Promise.resolve(object.value),
            },
      );
    },
    put: (
      key: string,
      value: string,
      putOptions: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (failCursorPut && key.includes("evaluation-reducer-cursors")) {
        failCursorPut = false;
        return Promise.reject(new Error("commit response lost before cursor persistence"));
      }
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: putOptions.customMetadata ?? {}, value });
      if (/\/evaluation-runs\/output\/[0-9]{8}\.json$/.test(key)) outputWrites += 1;
      return Promise.resolve({ etag: key });
    },
  };
  const executionId = "reducer-execution";
  const planChecksum = "reducer-plan";
  const dimension = "stage:target:americas:warmDurableAcceptance";
  const makeRun = async (runId: string, values: ReadonlyArray<number>) => {
    const partitionIndex = runId === "even" ? 0 : 1;
    const leafReceiptChecksum = `${runId}-leaf-receipt`;
    const denominatorChainDigest = `${runId}-denominator-chain`;
    const denominatorCount = Math.max(values.length, 1);
    const missingRootCount = values.length === 0 ? 1 : 0;
    const inputReceiptChainDigest = qualificationChecksum([leafReceiptChecksum]);
    const artifactPrefix = `qualification/executions/${executionId}/evaluation-input/${runId}`;
    let previousShardChecksum = "NONE";
    const shards = new Array<typeof QualificationEvaluationSortedRunShard.Type>();
    for (let offset = 0; offset < values.length; offset += 256) {
      const index = Math.floor(offset / 256);
      const shard = qualificationEvaluationSortedRunShard({
        artifactId: `${artifactPrefix}/${padded(index)}.json`,
        denominatorChainDigest,
        denominatorCount,
        dimension,
        executionId,
        firstPartitionIndex: partitionIndex,
        index,
        inputReceiptChainDigest,
        lastPartitionIndex: partitionIndex,
        missingRootCount,
        planChecksum,
        previousShardChecksum,
        runId,
        sampleStatus: missingRootCount > 0 ? "MISSING" : "COMPLETE",
        values: values.slice(offset, offset + 256),
        valueType: "latencyMs",
      });
      if (shard === null) throw new Error("Expected input shard");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each immutable shard checksum commits to its predecessor.
      const outcome = await retainQualificationEvaluationArtifact({
        artifactId: shard.artifactId,
        bucket,
        checksum: shard.checksum,
        encoded: canonicalQualificationJson(shard),
        executionId,
        kind: "qualification-evaluation-sorted-run-v2",
        metadata: {
          "osfo-denominator-chain-digest": denominatorChainDigest,
          "osfo-denominator-count": String(denominatorCount),
          "osfo-dimension": dimension,
          "osfo-first-partition-index": String(partitionIndex),
          "osfo-index": String(index),
          "osfo-input-receipt-chain-digest": inputReceiptChainDigest,
          "osfo-last-partition-index": String(partitionIndex),
          "osfo-missing-root-count": String(missingRootCount),
          "osfo-previous-checksum": previousShardChecksum,
          "osfo-record-count": String(shard.values.length),
          "osfo-run-id": runId,
          "osfo-sample-status": missingRootCount > 0 ? "MISSING" : "COMPLETE",
          "osfo-value-type": "latencyMs",
        },
        planChecksum,
      });
      if (outcome === "CONFLICT") throw new Error("Input shard conflict");
      shards.push(shard);
      previousShardChecksum = shard.checksum;
    }
    const first = shards[0];
    const last = shards.at(-1);
    if (
      (first !== undefined && first.valueType !== "latencyMs") ||
      (last !== undefined && last.valueType !== "latencyMs")
    ) {
      throw new Error("Expected numeric input run");
    }
    const descriptor = {
      artifactPrefix,
      denominatorChainDigest,
      denominatorCount,
      dimension,
      firstShardChecksum: first?.checksum ?? "ZERO",
      firstPartitionIndex: partitionIndex,
      inputReceiptChainDigest,
      lastPartitionIndex: partitionIndex,
      maximum: last?.maximum ?? null,
      minimum: first?.minimum ?? null,
      missingRootCount,
      runId,
      sampleStatus: missingRootCount > 0 ? ("MISSING" as const) : ("COMPLETE" as const),
      shardCount: shards.length,
      terminalShardChecksum: last?.checksum ?? "ZERO",
      valueCount: values.length,
      valueType: "latencyMs" as const,
    };
    const receipt = qualificationEvaluationSortedRunReceipt({
      artifactId: `${artifactPrefix}/receipt.json`,
      descriptor,
      executionId,
      index: runId === "even" ? 0 : 1,
      inputReceiptChecksums: [leafReceiptChecksum],
      level: 0,
      planChecksum,
    });
    if (receipt === null) throw new Error("Expected input receipt");
    const retainedReceipt = await retainQualificationEvaluationArtifact({
      artifactId: receipt.artifactId,
      bucket,
      checksum: receipt.checksum,
      encoded: canonicalQualificationJson(receipt),
      executionId,
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
      planChecksum,
    });
    if (retainedReceipt === "CONFLICT") throw new Error("Input receipt conflict");
    return {
      receipt,
      reference: { artifactId: receipt.artifactId, checksum: receipt.checksum },
    };
  };
  const runs =
    options?.runs ??
    ([
      Array.from({ length: 300 }, (_, index) => index * 2),
      Array.from({ length: 300 }, (_, index) => index * 2 + 1),
    ] as const);
  const [even, odd] = await Promise.all([makeRun("even", runs[0]), makeRun("odd", runs[1])]);
  const inputReceipts = [even.receipt, odd.receipt] as const;
  const denominatorCount = inputReceipts.reduce(
    (total, receipt) => total + receipt.denominatorCount,
    0,
  );
  const missingRootCount = inputReceipts.reduce(
    (total, receipt) => total + receipt.missingRootCount,
    0,
  );
  const payload: QualificationEvaluationReducerWorkflowPayload = {
    denominatorChainDigest: qualificationChecksum(
      inputReceipts.map((receipt) => ({
        checksum: receipt.checksum,
        denominatorChainDigest: receipt.denominatorChainDigest,
        denominatorCount: receipt.denominatorCount,
        firstPartitionIndex: receipt.firstPartitionIndex,
        lastPartitionIndex: receipt.lastPartitionIndex,
      })),
    ),
    denominatorCount,
    dimension,
    executionId,
    firstPartitionIndex: 0,
    index: 0,
    inputReceiptChainDigest: qualificationChecksum(inputReceipts.map(({ checksum }) => checksum)),
    inputs: [even.reference, odd.reference],
    lastPartitionIndex: 1,
    level: 1,
    missingRootCount,
    outputArtifactPrefix: `qualification/executions/${executionId}/evaluation-runs/output`,
    outputRunId: "output",
    planChecksum,
    valueType: "latencyMs",
  };
  let failAfterStep = options?.failAfterStep;
  const step = {
    do: async <Value>(name: string, callback: () => Promise<Value>) => {
      const value = await callback();
      if (failAfterStep !== undefined && name.includes(failAfterStep)) {
        failAfterStep = undefined;
        throw new Error(`lost Workflow result after ${name}`);
      }
      return value;
    },
  };
  return { bucket, outputWrites: () => outputWrites, payload, retained, step };
};

it("resumes after output persistence without duplicate, drop, or reorder", async () => {
  const test = await runtime({ failFirstCursorPut: true });
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: test.bucket },
      payload: test.payload,
      step: test.step,
    }),
  ).rejects.toThrow("commit response lost");
  const firstOutputBytes = test.retained.get(
    `${test.payload.outputArtifactPrefix}/00000000.json`,
  )?.value;
  const receipt = await runQualificationEvaluationReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(receipt).toMatchObject({
    firstShardChecksum: expect.any(String),
    inputReceiptChecksums: test.payload.inputs.map(({ checksum }) => checksum),
    maximum: 599,
    minimum: 0,
    shardCount: 3,
    valueCount: 600,
  });
  const values = new Array<number>();
  for (let index = 0; index < receipt.shardCount; index += 1) {
    const object = test.retained.get(`${test.payload.outputArtifactPrefix}/${padded(index)}.json`);
    if (object === undefined) throw new Error("Expected output shard");
    const shard = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationSortedRunShard))(
      object.value,
    );
    if (shard.valueType !== "latencyMs") throw new Error("Expected numeric output shard");
    values.push(...shard.values);
  }
  expect(values).toEqual(Array.from({ length: 600 }, (_, index) => index));
  expect(test.outputWrites()).toBe(3);
  expect(test.retained.get(`${test.payload.outputArtifactPrefix}/00000000.json`)?.value).toBe(
    firstOutputBytes,
  );
  const replay = await runQualificationEvaluationReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(replay).toEqual(receipt);
  expect(test.outputWrites()).toBe(3);
});

it("reduces all-zero runs without entering the page merge", async () => {
  const test = await runtime({ runs: [[], []] });
  const receipt = await runQualificationEvaluationReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(receipt).toMatchObject({
    denominatorCount: 2,
    firstShardChecksum: "ZERO",
    maximum: null,
    minimum: null,
    missingRootCount: 2,
    sampleStatus: "MISSING",
    shardCount: 0,
    terminalShardChecksum: "ZERO",
    valueCount: 0,
    valueType: "latencyMs",
  });
  expect(test.outputWrites()).toBe(0);
});

it("merges a zero run with a nonzero run without inventing samples", async () => {
  const test = await runtime({ runs: [[], [1, 2]] });
  const receipt = await runQualificationEvaluationReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(receipt).toMatchObject({
    denominatorCount: 3,
    maximum: 2,
    minimum: 1,
    missingRootCount: 1,
    sampleStatus: "MISSING",
    valueCount: 2,
  });
});

it.each([
  ["merge evaluation page 0", "cursor checkpoint"],
  ["verify output and retain evaluation run receipt", "terminal receipt"],
] as const)("replays after durable %s persistence", async (failAfterStep, boundary) => {
  const test = await runtime({ failAfterStep });
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: test.bucket },
      payload: test.payload,
      step: test.step,
    }),
  ).rejects.toThrow("lost Workflow result");
  const before = new Map(
    [...test.retained.entries()].filter(([key]) =>
      boundary === "terminal receipt"
        ? key.includes("evaluation-runs/output")
        : key.includes("evaluation-reducer-cursors"),
    ),
  );
  const receipt = await runQualificationEvaluationReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(receipt.valueCount).toBe(600);
  for (const [key, object] of before) {
    expect(test.retained.get(key)).toEqual(object);
  }
  expect(test.outputWrites()).toBe(3);
});

it("rejects predecessor splicing before retaining a terminal receipt", async () => {
  const test = await runtime();
  const secondEvenKey = `qualification/executions/${test.payload.executionId}/evaluation-input/even/00000001.json`;
  const secondEven = test.retained.get(secondEvenKey);
  if (secondEven === undefined) throw new Error("Expected second even shard");
  test.retained.set(secondEvenKey, {
    ...secondEven,
    customMetadata: {
      ...secondEven.customMetadata,
      "osfo-previous-checksum": "spliced-checksum",
    },
  });
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: test.bucket },
      payload: test.payload,
      step: test.step,
    }),
  ).rejects.toThrow("input shard conflicts");
  expect(test.retained.has(`${test.payload.outputArtifactPrefix}/receipt.json`)).toBe(false);
});

it("rejects a valid descriptor substituted under another receipt checksum", async () => {
  const test = await runtime();
  const [first, second] = test.payload.inputs;
  if (first === undefined || second === undefined) throw new Error("Expected input receipts");
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: test.bucket },
      payload: {
        ...test.payload,
        inputs: [{ artifactId: first.artifactId, checksum: second.checksum }],
      },
      step: test.step,
    }),
  ).rejects.toThrow("input receipt conflicts");
});

it("rejects dropped or reordered child receipts against the frozen aggregate", async () => {
  const dropped = await runtime();
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: dropped.bucket },
      payload: { ...dropped.payload, inputs: dropped.payload.inputs.slice(0, 1) },
      step: dropped.step,
    }),
  ).rejects.toThrow("input ranges conflict");
  const reordered = await runtime();
  const [first, second] = reordered.payload.inputs;
  if (first === undefined || second === undefined) throw new Error("Expected reducer inputs");
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: reordered.bucket },
      payload: { ...reordered.payload, inputs: [second, first] },
      step: reordered.step,
    }),
  ).rejects.toThrow("input ranges conflict");
});

it("rejects corrupt first-shard metadata before producing output", async () => {
  const test = await runtime();
  const firstInput = test.payload.inputs[0];
  if (firstInput === undefined) throw new Error("Expected first input receipt");
  const receiptObject = test.retained.get(firstInput.artifactId);
  if (receiptObject === undefined) throw new Error("Expected first input receipt body");
  const receipt = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationSortedRunReceipt))(
    receiptObject.value,
  );
  const firstShardKey = `${receipt.artifactPrefix}/00000000.json`;
  const firstShard = test.retained.get(firstShardKey);
  if (firstShard === undefined) throw new Error("Expected first input shard");
  test.retained.set(firstShardKey, {
    ...firstShard,
    customMetadata: { ...firstShard.customMetadata, "osfo-index": "1" },
  });
  await expect(
    runQualificationEvaluationReducer({
      env: { ARTIFACTS: test.bucket },
      payload: test.payload,
      step: test.step,
    }),
  ).rejects.toThrow("input shard conflicts");
  expect(test.outputWrites()).toBe(0);
});

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
    const artifactPrefix = `qualification/executions/${executionId}/evaluation-input/${runId}`;
    let previousShardChecksum = "NONE";
    const shards = new Array<typeof QualificationEvaluationSortedRunShard.Type>();
    for (let offset = 0; offset < values.length; offset += 256) {
      const index = Math.floor(offset / 256);
      const shard = qualificationEvaluationSortedRunShard({
        artifactId: `${artifactPrefix}/${padded(index)}.json`,
        dimension,
        executionId,
        index,
        planChecksum,
        previousShardChecksum,
        runId,
        values: values.slice(offset, offset + 256),
      });
      if (shard === null) throw new Error("Expected input shard");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each immutable shard checksum commits to its predecessor.
      const outcome = await retainQualificationEvaluationArtifact({
        artifactId: shard.artifactId,
        bucket,
        checksum: shard.checksum,
        encoded: canonicalQualificationJson(shard),
        executionId,
        kind: "qualification-evaluation-sorted-run-v1",
        metadata: {
          "osfo-dimension": dimension,
          "osfo-index": String(index),
          "osfo-previous-checksum": previousShardChecksum,
          "osfo-record-count": String(shard.values.length),
          "osfo-run-id": runId,
        },
        planChecksum,
      });
      if (outcome === "CONFLICT") throw new Error("Input shard conflict");
      shards.push(shard);
      previousShardChecksum = shard.checksum;
    }
    const first = shards[0];
    const last = shards.at(-1);
    if (first === undefined || last === undefined) throw new Error("Expected input run");
    const descriptor = {
      artifactPrefix,
      dimension,
      firstShardChecksum: first.checksum,
      maximum: last.maximum,
      minimum: first.minimum,
      runId,
      shardCount: shards.length,
      terminalShardChecksum: last.checksum,
      valueCount: values.length,
    };
    const receipt = qualificationEvaluationSortedRunReceipt({
      artifactId: `${artifactPrefix}/receipt.json`,
      descriptor,
      executionId,
      index: runId === "even" ? 0 : 1,
      inputReceiptChecksums: [`${runId}-leaf-receipt`],
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
      kind: "qualification-evaluation-sorted-run-receipt-v1",
      metadata: {
        "osfo-dimension": receipt.dimension,
        "osfo-input-checksum": qualificationChecksum(receipt.inputReceiptChecksums),
        "osfo-record-count": String(receipt.valueCount),
        "osfo-run-id": receipt.runId,
        "osfo-terminal-checksum": receipt.terminalShardChecksum,
      },
      planChecksum,
    });
    if (retainedReceipt === "CONFLICT") throw new Error("Input receipt conflict");
    return { artifactId: receipt.artifactId, checksum: receipt.checksum };
  };
  const [even, odd] = await Promise.all([
    makeRun(
      "even",
      Array.from({ length: 300 }, (_, index) => index * 2),
    ),
    makeRun(
      "odd",
      Array.from({ length: 300 }, (_, index) => index * 2 + 1),
    ),
  ]);
  const payload: QualificationEvaluationReducerWorkflowPayload = {
    dimension,
    executionId,
    index: 0,
    inputs: [even, odd],
    level: 1,
    outputArtifactPrefix: `qualification/executions/${executionId}/evaluation-runs/output`,
    outputRunId: "output",
    planChecksum,
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

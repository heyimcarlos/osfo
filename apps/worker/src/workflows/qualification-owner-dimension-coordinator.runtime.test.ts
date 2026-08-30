/* oxlint-disable effecttsgo/async-function -- Promise fakes model Cloudflare Workflow and R2 host boundaries. */
import { expect, it } from "vitest";
import type { WorkflowStepConfig } from "cloudflare:workers";

import type { QualificationOwnerDimensionWorkflowPayload } from "../workflow-contracts";
import {
  qualificationEvaluationSortedRunReceipt,
  qualificationEvaluationSortedRunShard,
  retainQualificationEvaluationArtifact,
  type QualificationEvaluationSortedRunDescriptor,
} from "../qualification/qualification-evaluation-reducer";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import {
  buildQualificationDimensionLevel,
  launchQualificationDimensionLevels,
  retainQualificationDimensionIndexes,
  retainQualificationDimensionIndexSegment,
  settleQualificationDimensionLevel,
  type QualificationDimensionStep,
} from "./qualification-owner-dimension-coordinator";
import { readQualificationDimensionSelectedValue } from "./qualification-owner-dimensions";
import { qualificationEvaluationLeafJoinPageArtifactId } from "./qualification-owner-leaves";
import { runQualificationEvaluationReducer } from "./qualification-evaluation-reducer";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

class ImmediateStep implements QualificationDimensionStep {
  do<Value extends Rpc.Serializable<Value>>(
    ...args:
      | readonly [name: string, callback: () => Promise<Value>]
      | readonly [name: string, config: WorkflowStepConfig, callback: () => Promise<Value>]
  ) {
    const operation = args.length === 2 ? args[1] : args[2];
    return operation();
  }

  sleepUntil(): Promise<void> {
    return Promise.resolve();
  }
}

const payload: QualificationOwnerDimensionWorkflowPayload = {
  correctnessArtifactId: "correctness.json",
  correctnessChecksum: "correctness-checksum",
  correctnessLevel: 1,
  executionId: "dimension-runtime",
  leafCompletionCount: 1,
  leafCompletionPageCount: 1,
  leafCompletionTerminalPageChecksum: "leaf-terminal",
  manifestChecksum: "manifest",
  planChecksum: "plan",
  requestArtifactChecksum: "request-checksum",
  requestArtifactId: "request.json",
};

const inventory = [
  {
    dimension: "acceptedRootIds",
    firstPartitionIndex: 0,
    lastPartitionIndex: 0,
    leafCount: 1,
    levelCounts: [],
    valueType: "identity" as const,
  },
];

const runtime = (retainedBody?: string) => {
  const key = qualificationEvaluationLeafJoinPageArtifactId(payload.executionId, 0);
  const retained =
    retainedBody === undefined ? new Map<string, string>() : new Map([[key, retainedBody]]);
  const bucket = {
    get: (artifactId: string) => {
      const value = retained.get(artifactId);
      return Promise.resolve(
        value === undefined ? null : { customMetadata: {}, text: () => Promise.resolve(value) },
      );
    },
    list: (options: { readonly prefix: string }) =>
      Promise.resolve({
        objects: [...retained.keys()]
          .filter((artifactId) => artifactId.startsWith(options.prefix))
          .map((artifactId) => ({ checksums: {}, customMetadata: {}, key: artifactId })),
        truncated: false,
      }),
    put: () => Promise.resolve({ etag: "etag" }),
  };
  return retainQualificationDimensionIndexes({
    env: {
      ARTIFACTS: bucket,
      QUALIFICATION_EVALUATION_REDUCER_WORKFLOW: {
        createBatch: () => Promise.resolve([]),
        get: () => Promise.reject(new Error("Reducer must not run")),
      },
    },
    inventory,
    payload,
    step: new ImmediateStep(),
  });
};

it("classifies an absent expected leaf join as MISSING", async () => {
  await expect(runtime()).resolves.toEqual({ status: "MISSING" });
});

it("classifies retained malformed leaf join material as FAIL", async () => {
  await expect(runtime("{}")).resolves.toEqual({ status: "FAIL" });
});

const sortedForestRuntime = async (options?: {
  readonly createResponse?: "partial" | "wrong";
  readonly leafCount?: number;
  readonly skipReducer?: boolean;
}) => {
  const executionId = "dimension-level-runtime";
  const planChecksum = "dimension-plan";
  const dimension = "operation:modelStep";
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
    list: (input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly prefix: string;
    }) => {
      const objects = [...retained.entries()].filter(([key]) => key.startsWith(input.prefix));
      const start = Number(input.cursor ?? "0");
      const page = objects.slice(start, start + input.limit);
      const next = start + page.length;
      const result = {
        objects: page.map(([key, value]) => ({
          checksums: {},
          customMetadata: value.customMetadata,
          key,
        })),
        truncated: next < objects.length,
      };
      return Promise.resolve(next < objects.length ? { ...result, cursor: String(next) } : result);
    },
    put: (
      key: string,
      value: string,
      input: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: input.customMetadata ?? {}, value });
      return Promise.resolve({ etag: key });
    },
  };
  const leafCount = options?.leafCount ?? 2;
  const receipts = await Promise.all(
    Array.from({ length: leafCount }, async (_, partitionIndex) => {
      const values = [partitionIndex, partitionIndex + 2, partitionIndex + 4];
      const runId = `leaf-${partitionIndex}`;
      const leafChecksum = `${runId}-input`;
      const inputReceiptChainDigest = qualificationChecksum([leafChecksum]);
      const artifactPrefix = `qualification/executions/${executionId}/leaf-runs/${runId}`;
      const shard = qualificationEvaluationSortedRunShard({
        artifactId: `${artifactPrefix}/00000000.json`,
        denominatorChainDigest: `${runId}-denominator`,
        denominatorCount: values.length,
        dimension,
        executionId,
        firstPartitionIndex: partitionIndex,
        index: 0,
        inputReceiptChainDigest,
        lastPartitionIndex: partitionIndex,
        missingRootCount: 0,
        planChecksum,
        previousShardChecksum: "NONE",
        runId,
        sampleStatus: "COMPLETE",
        values,
        valueType: "latencyMs",
      });
      if (shard === null) throw new Error("Expected sorted shard");
      if (shard.valueType !== "latencyMs") throw new Error("Expected numeric sorted shard");
      await retainQualificationEvaluationArtifact({
        artifactId: shard.artifactId,
        bucket,
        checksum: shard.checksum,
        encoded: canonicalQualificationJson(shard),
        executionId,
        kind: "qualification-evaluation-sorted-run-v2",
        metadata: {
          "osfo-denominator-chain-digest": shard.denominatorChainDigest,
          "osfo-denominator-count": String(shard.denominatorCount),
          "osfo-dimension": dimension,
          "osfo-first-partition-index": String(partitionIndex),
          "osfo-index": "0",
          "osfo-input-receipt-chain-digest": inputReceiptChainDigest,
          "osfo-last-partition-index": String(partitionIndex),
          "osfo-missing-root-count": "0",
          "osfo-previous-checksum": "NONE",
          "osfo-record-count": String(values.length),
          "osfo-run-id": runId,
          "osfo-sample-status": "COMPLETE",
          "osfo-value-type": "latencyMs",
        },
        planChecksum,
      });
      const descriptor = {
        artifactPrefix,
        denominatorChainDigest: shard.denominatorChainDigest,
        denominatorCount: values.length,
        dimension,
        firstPartitionIndex: partitionIndex,
        firstShardChecksum: shard.checksum,
        inputReceiptChainDigest,
        lastPartitionIndex: partitionIndex,
        maximum: shard.maximum,
        minimum: shard.minimum,
        missingRootCount: 0,
        runId,
        sampleStatus: "COMPLETE" as const,
        shardCount: 1,
        terminalShardChecksum: shard.checksum,
        valueCount: values.length,
        valueType: "latencyMs" as const,
      };
      const receipt = qualificationEvaluationSortedRunReceipt({
        artifactId: `${artifactPrefix}/receipt.json`,
        descriptor,
        executionId,
        index: partitionIndex,
        inputReceiptChecksums: [leafChecksum],
        level: 0,
        planChecksum,
      });
      if (receipt === null) throw new Error("Expected sorted receipt");
      await retainQualificationEvaluationArtifact({
        artifactId: receipt.artifactId,
        bucket,
        checksum: receipt.checksum,
        encoded: canonicalQualificationJson(receipt),
        executionId,
        kind: "qualification-evaluation-sorted-run-receipt-v2",
        metadata: {
          "osfo-denominator-chain-digest": receipt.denominatorChainDigest,
          "osfo-denominator-count": String(receipt.denominatorCount),
          "osfo-dimension": dimension,
          "osfo-first-partition-index": String(receipt.firstPartitionIndex),
          "osfo-input-checksum": qualificationChecksum(receipt.inputReceiptChecksums),
          "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
          "osfo-last-partition-index": String(receipt.lastPartitionIndex),
          "osfo-missing-root-count": "0",
          "osfo-record-count": String(receipt.valueCount),
          "osfo-run-id": receipt.runId,
          "osfo-sample-status": receipt.sampleStatus,
          "osfo-terminal-checksum": receipt.terminalShardChecksum,
          "osfo-value-type": receipt.valueType,
        },
        planChecksum,
      });
      return receipt;
    }),
  );
  const receiptPages = Array.from({ length: Math.ceil(receipts.length / 50) }, (_, index) =>
    receipts.slice(index * 50, (index + 1) * 50),
  );
  const retainedSegments = await receiptPages.reduce(
    async (prior, page, index) => {
      const previous = await prior;
      const segment = await retainQualificationDimensionIndexSegment({
        bucket,
        dimension,
        executionId,
        index,
        planChecksum,
        previousSegmentChecksum: previous.terminalChecksum,
        receipts: page,
        valueType: "latencyMs",
      });
      return { count: previous.count + 1, terminalChecksum: segment.checksum };
    },
    Promise.resolve({ count: 0, terminalChecksum: "NONE" }),
  );
  const { count: segmentCount, terminalChecksum: previousSegmentChecksum } = retainedSegments;
  const instances = new Map<
    string,
    {
      readonly id: string;
      readonly status: () => Promise<{ readonly status: "complete" | "queued" }>;
    }
  >();
  const reducer = {
    createBatch: async (
      batch: ReadonlyArray<{
        readonly id: string;
        readonly params: Parameters<typeof runQualificationEvaluationReducer>[0]["payload"];
      }>,
    ) => {
      await Promise.all(
        batch.map(async ({ id, params }) => {
          if (options?.skipReducer !== true) {
            await runQualificationEvaluationReducer({
              env: { ARTIFACTS: bucket },
              payload: params,
              step: { do: async (_name, callback) => structuredClone(await callback()) },
            });
          }
          instances.set(id, {
            id,
            status: () =>
              Promise.resolve({ status: options?.skipReducer === true ? "queued" : "complete" }),
          });
        }),
      );
      if (options?.createResponse === "partial") return [];
      if (options?.createResponse === "wrong")
        return [{ id: "wrong", status: () => Promise.resolve({ status: "complete" as const }) }];
      const launched = [];
      for (const { id } of batch) {
        const instance = instances.get(id);
        if (instance === undefined) throw new Error("Expected retained reducer instance");
        launched.push(instance);
      }
      return launched;
    },
    get: (id: string) => {
      const instance = instances.get(id);
      return instance === undefined
        ? Promise.reject(new Error("Missing instance"))
        : Promise.resolve(instance);
    },
  };
  const env = { ARTIFACTS: bucket, QUALIFICATION_EVALUATION_REDUCER_WORKFLOW: reducer };
  const coordinatorPayload = { ...payload, executionId, planChecksum };
  const dimensionInventory = {
    dimension,
    firstPartitionIndex: 0,
    lastPartitionIndex: leafCount - 1,
    leafCount,
    levelCounts: leafCount > 16 ? [Math.ceil(leafCount / 16), 1] : leafCount > 1 ? [1] : [],
    valueType: "latencyMs" as const,
  };
  const step = new ImmediateStep();
  const built = await buildQualificationDimensionLevel({
    dimension: dimensionInventory,
    env,
    index: { count: segmentCount, terminalChecksum: previousSegmentChecksum },
    level: 1,
    payload: coordinatorPayload,
    step,
  });
  if (built.status !== "COMPLETE") throw new Error("Expected built dimension level");
  return {
    built: built.descriptor,
    dimensionInventory,
    env,
    index: { count: segmentCount, terminalChecksum: previousSegmentChecksum },
    payload: coordinatorPayload,
    receipts,
    retained,
    step,
  };
};

const selectedValueRuntime = async (overrides?: {
  readonly denominatorCount?: number;
  readonly shardIndex?: number;
}) => {
  const executionId = "selected-value-runtime";
  const planChecksum = "selected-value-plan";
  const dimension = "operation:modelStep";
  const artifactPrefix = `qualification/executions/${executionId}/selected`;
  const inputReceiptChecksums = ["leaf-input"];
  const inputReceiptChainDigest = qualificationChecksum(inputReceiptChecksums);
  const descriptor: typeof QualificationEvaluationSortedRunDescriptor.Type = {
    artifactPrefix,
    denominatorChainDigest: "denominator-chain",
    denominatorCount: 600,
    dimension,
    firstPartitionIndex: 0,
    firstShardChecksum: "first-shard",
    inputReceiptChainDigest,
    lastPartitionIndex: 2,
    maximum: 599,
    minimum: 0,
    missingRootCount: 0,
    runId: "selected-run",
    sampleStatus: "COMPLETE",
    shardCount: 3,
    terminalShardChecksum: "terminal-shard",
    valueCount: 600,
    valueType: "latencyMs",
  };
  const receipt = qualificationEvaluationSortedRunReceipt({
    artifactId: `${artifactPrefix}/receipt.json`,
    descriptor,
    executionId,
    index: 0,
    inputReceiptChecksums,
    level: 1,
    planChecksum,
  });
  if (receipt === null) throw new Error("Expected selected-value receipt");
  const artifactId = `${artifactPrefix}/00000001.json`;
  const shard = qualificationEvaluationSortedRunShard({
    artifactId,
    denominatorChainDigest: receipt.denominatorChainDigest,
    denominatorCount: overrides?.denominatorCount ?? receipt.denominatorCount,
    dimension,
    executionId,
    firstPartitionIndex: receipt.firstPartitionIndex,
    index: overrides?.shardIndex ?? 1,
    inputReceiptChainDigest,
    lastPartitionIndex: receipt.lastPartitionIndex,
    missingRootCount: receipt.missingRootCount,
    planChecksum,
    previousShardChecksum: "prior-shard",
    runId: receipt.runId,
    sampleStatus: receipt.sampleStatus,
    values: Array.from({ length: 256 }, (_, index) => index + 256),
    valueType: "latencyMs",
  });
  if (shard === null) throw new Error("Expected selected-value shard");
  const encoded = canonicalQualificationJson(shard);
  const retained = {
    customMetadata: {
      "osfo-artifact-checksum": shard.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-denominator-chain-digest": shard.denominatorChainDigest,
      "osfo-denominator-count": String(shard.denominatorCount),
      "osfo-dimension": shard.dimension,
      "osfo-execution-id": shard.executionId,
      "osfo-first-partition-index": String(shard.firstPartitionIndex),
      "osfo-index": String(shard.index),
      "osfo-input-receipt-chain-digest": shard.inputReceiptChainDigest,
      "osfo-kind": "qualification-evaluation-sorted-run-v2",
      "osfo-last-partition-index": String(shard.lastPartitionIndex),
      "osfo-missing-root-count": String(shard.missingRootCount),
      "osfo-plan-checksum": shard.planChecksum,
      "osfo-previous-checksum": shard.previousShardChecksum,
      "osfo-record-count": String(shard.values.length),
      "osfo-run-id": shard.runId,
      "osfo-sample-status": shard.sampleStatus,
      "osfo-value-type": shard.valueType,
    },
    text: () => Promise.resolve(encoded),
  };
  return readQualificationDimensionSelectedValue({
    bucket: {
      get: (key) => Promise.resolve(key === artifactId ? retained : null),
      put: () => Promise.resolve({ etag: "unused" }),
    },
    index: 300,
    receipt,
  });
};

it("rejects selected shards with a substituted index or receipt descriptor", async () => {
  await expect(selectedValueRuntime()).resolves.toEqual({ status: "COMPLETE", value: 300 });
  await expect(selectedValueRuntime({ shardIndex: 2 })).resolves.toEqual({ status: "FAIL" });
  await expect(selectedValueRuntime({ denominatorCount: 601 })).resolves.toEqual({
    status: "FAIL",
  });
});

it("launches, executes, authenticates, and replays one exact dimension level", async () => {
  const test = await sortedForestRuntime();
  await expect(
    launchQualificationDimensionLevels({
      env: test.env,
      levels: [test.built],
      payload: test.payload,
      step: test.step,
    }),
  ).resolves.toMatchObject({ status: "COMPLETE" });
  const settled = await settleQualificationDimensionLevel({
    env: test.env,
    level: test.built,
    payload: test.payload,
    step: test.step,
  });
  expect(settled).toMatchObject({ status: "COMPLETE", descriptor: { nodeCount: 1 } });
  await expect(
    launchQualificationDimensionLevels({
      env: test.env,
      levels: [test.built],
      payload: test.payload,
      step: test.step,
    }),
  ).resolves.toMatchObject({ status: "COMPLETE" });
});

it("executes a two-level tree whose fan-in crosses an index-segment boundary", async () => {
  const test = await sortedForestRuntime({ leafCount: 51 });
  expect(test.index.count).toBe(2);
  expect(test.built.nodeCount).toBe(4);
  await expect(
    launchQualificationDimensionLevels({
      env: test.env,
      levels: [test.built],
      payload: test.payload,
      step: test.step,
    }),
  ).resolves.toMatchObject({ status: "COMPLETE" });
  const firstLevel = await settleQualificationDimensionLevel({
    env: test.env,
    level: test.built,
    payload: test.payload,
    step: test.step,
  });
  if (firstLevel.status !== "COMPLETE") throw new Error("Expected settled first level");
  const secondLevel = await buildQualificationDimensionLevel({
    dimension: test.dimensionInventory,
    env: test.env,
    index: test.index,
    level: 2,
    payload: test.payload,
    previous: firstLevel.descriptor,
    step: test.step,
  });
  if (secondLevel.status !== "COMPLETE") throw new Error("Expected built second level");
  expect(secondLevel.descriptor.nodeCount).toBe(1);
  await launchQualificationDimensionLevels({
    env: test.env,
    levels: [secondLevel.descriptor],
    payload: test.payload,
    step: test.step,
  });
  await expect(
    settleQualificationDimensionLevel({
      env: test.env,
      level: secondLevel.descriptor,
      payload: test.payload,
      step: test.step,
    }),
  ).resolves.toMatchObject({ status: "COMPLETE", descriptor: { nodeCount: 1 } });
});

it.each(["partial", "wrong"] as const)(
  "rejects a %s dimension create response",
  async (createResponse) => {
    const test = await sortedForestRuntime({ createResponse });
    await expect(
      launchQualificationDimensionLevels({
        env: test.env,
        levels: [test.built],
        payload: test.payload,
        step: test.step,
      }),
    ).resolves.toEqual({ status: "FAIL" });
  },
);

it("classifies a still queued reducer without a receipt as MISSING", async () => {
  const test = await sortedForestRuntime({ skipReducer: true });
  await launchQualificationDimensionLevels({
    env: test.env,
    levels: [test.built],
    payload: test.payload,
    step: test.step,
  });
  await expect(
    settleQualificationDimensionLevel({
      env: test.env,
      level: test.built,
      payload: test.payload,
      step: test.step,
    }),
  ).resolves.toEqual({ status: "MISSING" });
});

it("distinguishes absent launch material from extra or malformed retained launch material", async () => {
  const missing = await sortedForestRuntime();
  const launchKey = [...missing.retained.entries()].find(
    ([, value]) => value.customMetadata["osfo-kind"] === "qualification-dimension-launch-page-v1",
  )?.[0];
  if (launchKey === undefined) throw new Error("Expected launch page");
  missing.retained.delete(launchKey);
  await expect(
    launchQualificationDimensionLevels({
      env: missing.env,
      levels: [missing.built],
      payload: missing.payload,
      step: missing.step,
    }),
  ).resolves.toEqual({ status: "MISSING" });

  const extra = await sortedForestRuntime();
  const extraLaunchKey = [...extra.retained.entries()].find(
    ([, value]) => value.customMetadata["osfo-kind"] === "qualification-dimension-launch-page-v1",
  )?.[0];
  if (extraLaunchKey === undefined) throw new Error("Expected launch page");
  extra.retained.set(
    `${extraLaunchKey.slice(0, extraLaunchKey.lastIndexOf("/") + 1)}99999999.json`,
    {
      customMetadata: {},
      value: "{}",
    },
  );
  await expect(
    launchQualificationDimensionLevels({
      env: extra.env,
      levels: [extra.built],
      payload: extra.payload,
      step: extra.step,
    }),
  ).resolves.toEqual({ status: "FAIL" });

  const malformed = await sortedForestRuntime();
  const malformedEntry = [...malformed.retained.entries()].find(
    ([, value]) => value.customMetadata["osfo-kind"] === "qualification-dimension-launch-page-v1",
  );
  if (malformedEntry === undefined) throw new Error("Expected launch page");
  malformed.retained.set(malformedEntry[0], {
    customMetadata: malformedEntry[1].customMetadata,
    value: "{}",
  });
  await expect(
    launchQualificationDimensionLevels({
      env: malformed.env,
      levels: [malformed.built],
      payload: malformed.payload,
      step: malformed.step,
    }),
  ).resolves.toEqual({ status: "FAIL" });
});

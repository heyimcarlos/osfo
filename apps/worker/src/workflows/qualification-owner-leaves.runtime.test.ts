/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Promise fakes model ordered Cloudflare Workflow and R2 boundaries. */
import { expect, it } from "@effect/vitest";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationEvaluationLeafWorkflowPayload } from "../workflow-contracts";
import {
  qualificationLeafCompletionHorizonMs,
  runQualificationOwnerLeafFanout,
} from "./qualification-owner-leaves";

const executionId = "owner-leaf-fanout";
const manifestChecksum = "manifest-checksum";
const planChecksum = "plan-checksum";
const requestArtifactChecksum = "request-checksum";
const requestArtifactId = `qualification/executions/${executionId}/owner-request.json`;

const sha256 = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return new Uint8Array(digest);
};

const sha256Hex = async (encoded: string) =>
  Array.from(await sha256(encoded), (byte) => byte.toString(16).padStart(2, "0")).join("");

const runtime = async (
  options: {
    readonly completePartitions?: ReadonlyArray<number>;
    readonly createBatchResponse?: "partial" | "wrong";
    readonly extraCompletionPartition?: number;
    readonly loseCreateResponse?: boolean;
    readonly omitPartitions?: ReadonlyArray<number>;
    readonly partitionCount?: number;
    readonly reverseInventory?: boolean;
    readonly replay?: boolean;
    readonly tamperCompletion?: "execution" | "manifest" | "plan" | "run";
    readonly tamperLeafInputPartition?: number;
  } = {},
) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const put = async (key: string, value: string, customMetadata: Record<string, string>) => {
    retained.set(key, { customMetadata, value });
  };
  const partitionCount = options.partitionCount ?? 2;
  const launchInputs = Array.from({ length: partitionCount }, (_, partitionIndex) => ({
    leafInputArtifactId: `qualification/executions/${executionId}/evaluation-leaf-inputs/${partitionIndex.toString().padStart(8, "0")}.json`,
    leafInputChecksum: `leaf-input-${partitionIndex}`,
    partitionIndex,
    runId: "run-1",
  }));
  let previousLaunchPageChecksum = "NONE";
  let terminalLaunchPageChecksum = "NONE";
  const launchPageCount = Math.ceil(partitionCount / 50);
  for (let pageIndex = 0; pageIndex < launchPageCount; pageIndex += 1) {
    const inputs = launchInputs.slice(pageIndex * 50, (pageIndex + 1) * 50);
    const launchArtifactId = `qualification/executions/${executionId}/evaluation-leaf-launch-pages/${pageIndex.toString().padStart(8, "0")}.json`;
    const launchContent = {
      artifactId: launchArtifactId,
      executionId,
      firstPartitionIndex: inputs[0]?.partitionIndex ?? 0,
      inputs,
      lastPartitionIndex: inputs.at(-1)?.partitionIndex ?? 0,
      manifestChecksum,
      pageIndex,
      planChecksum,
      previousPageChecksum: previousLaunchPageChecksum,
      version: "qualification-evaluation-leaf-launch-page-v1" as const,
    };
    const launchPage = { ...launchContent, checksum: qualificationChecksum(launchContent) };
    const launchEncoded = canonicalQualificationJson(launchPage);
    await put(launchArtifactId, launchEncoded, {
      "osfo-artifact-checksum": launchPage.checksum,
      "osfo-body-sha256": await sha256Hex(launchEncoded),
      "osfo-execution-id": executionId,
      "osfo-first-partition-index": String(launchPage.firstPartitionIndex),
      "osfo-index": String(pageIndex),
      "osfo-kind": "qualification-evaluation-leaf-launch-page-v1",
      "osfo-last-partition-index": String(launchPage.lastPartitionIndex),
      "osfo-manifest-checksum": manifestChecksum,
      "osfo-plan-checksum": planChecksum,
      "osfo-previous-checksum": previousLaunchPageChecksum,
      "osfo-record-count": String(inputs.length),
    });
    previousLaunchPageChecksum = launchPage.checksum;
    terminalLaunchPageChecksum = launchPage.checksum;
  }

  const created = new Array<QualificationEvaluationLeafWorkflowPayload>();
  let createResponseLost = false;
  const createBatch = async (
    batch: ReadonlyArray<{
      readonly id: string;
      readonly params: QualificationEvaluationLeafWorkflowPayload;
    }>,
  ) => {
    for (const { id, params } of batch) {
      created.push(params);
      if (options.omitPartitions?.includes(params.partitionIndex) === true) continue;
      let outcome;
      if (options.completePartitions?.includes(params.partitionIndex) === true) {
        const rootArtifactId = `qualification/executions/${executionId}/evaluation-leaves/${params.partitionIndex.toString().padStart(8, "0")}/roots.json`;
        const rootContent = {
          acceptedCount: "0",
          artifactId: rootArtifactId,
          executionId,
          partitionIndex: params.partitionIndex,
          planChecksum,
          rootCount: "0",
          roots: [],
          version: "qualification-evaluation-leaf-roots-v1" as const,
        };
        const rootAccumulator = { ...rootContent, checksum: qualificationChecksum(rootContent) };
        const rootEncoded = canonicalQualificationJson(rootAccumulator);
        await put(rootArtifactId, rootEncoded, {
          "osfo-artifact-checksum": rootAccumulator.checksum,
          "osfo-body-sha256": await sha256Hex(rootEncoded),
          "osfo-execution-id": executionId,
          "osfo-kind": "qualification-evaluation-leaf-roots-v1",
          "osfo-plan-checksum": planChecksum,
          "osfo-record-count": "0",
        });
        const receiptArtifactId = `qualification/executions/${executionId}/evaluation-leaves/${params.partitionIndex.toString().padStart(8, "0")}/receipt.json`;
        const receiptContent = {
          artifactId: receiptArtifactId,
          dimensions: [],
          executionId,
          failCount: "0",
          findingExemplars: [],
          findingFirstShardChecksum: "ZERO",
          findingShardCount: "0",
          findingShardPrefix: `qualification/executions/${executionId}/evaluation-leaves/${params.partitionIndex.toString().padStart(8, "0")}/findings`,
          findingTerminalShardChecksum: "ZERO",
          leafInputChecksum: params.leafInputChecksum,
          missingCount: "0",
          partitionIndex: params.partitionIndex,
          planChecksum,
          rootAccumulatorChecksum: rootAccumulator.checksum,
          rootAccumulatorId: rootArtifactId,
          rootCount: "0",
          streamChunkIndex: params.partitionIndex,
          verdict: "PASS" as const,
          version: "qualification-evaluation-leaf-v1" as const,
        };
        const receipt = { ...receiptContent, checksum: qualificationChecksum(receiptContent) };
        const receiptEncoded = canonicalQualificationJson(receipt);
        await put(receiptArtifactId, receiptEncoded, {
          "osfo-artifact-checksum": receipt.checksum,
          "osfo-body-sha256": await sha256Hex(receiptEncoded),
          "osfo-execution-id": executionId,
          "osfo-kind": "qualification-evaluation-leaf-v1",
          "osfo-plan-checksum": planChecksum,
          "osfo-record-count": "0",
          "osfo-verdict": "PASS",
        });
        outcome = { receipt, status: "COMPLETE" as const };
      } else {
        outcome =
          params.partitionIndex === 0
            ? {
                artifactId: params.leafInputArtifactId,
                code: "qualificationEvaluationAuthorityMissing" as const,
                source: "worker_admission_receipts" as const,
                status: "MISSING" as const,
              }
            : {
                artifactId: params.leafInputArtifactId,
                code: "qualificationEvaluationAuthorityConflict" as const,
                source: "worker_admission_receipts" as const,
                status: "FAIL" as const,
              };
      }
      const artifactId = `qualification/executions/${executionId}/evaluation-leaf-completions/${params.partitionIndex.toString().padStart(8, "0")}.json`;
      const content = {
        artifactId,
        executionId: options.tamperCompletion === "execution" ? "foreign-execution" : executionId,
        leafInputArtifactId: params.leafInputArtifactId,
        leafInputChecksum:
          options.tamperLeafInputPartition === params.partitionIndex
            ? `${params.leafInputChecksum}-substituted`
            : params.leafInputChecksum,
        manifestChecksum:
          options.tamperCompletion === "manifest" ? "foreign-manifest" : manifestChecksum,
        outcome,
        partitionIndex: params.partitionIndex,
        planChecksum: options.tamperCompletion === "plan" ? "foreign-plan" : planChecksum,
        runId: options.tamperCompletion === "run" ? "foreign-run" : params.runId,
        version: "qualification-evaluation-leaf-completion-v1" as const,
      };
      const completion = { ...content, checksum: qualificationChecksum(content) };
      const encoded = canonicalQualificationJson(completion);
      await put(artifactId, encoded, {
        "osfo-artifact-checksum": completion.checksum,
        "osfo-body-sha256": await sha256Hex(encoded),
        "osfo-execution-id": completion.executionId,
        "osfo-kind": "qualification-evaluation-leaf-completion-v1",
        "osfo-leaf-input-checksum": params.leafInputChecksum,
        "osfo-outcome": outcome.status,
        "osfo-partition-index": String(params.partitionIndex),
        "osfo-plan-checksum": completion.planChecksum,
        "osfo-record-count": "0",
        "osfo-run-id": completion.runId,
      });
      expect(id).toBe(`${executionId}:evaluation-leaf:${params.partitionIndex}`);
    }
    if (options.loseCreateResponse === true && !createResponseLost) {
      createResponseLost = true;
      throw new Error("lost createBatch response");
    }
    const createdResponse = batch.map(({ id }) => ({ id }));
    if (options.createBatchResponse === "partial") return createdResponse.slice(1);
    if (options.createBatchResponse === "wrong") return [{ id: "foreign-leaf-instance" }];
    return createdResponse;
  };
  if (options.extraCompletionPartition !== undefined) {
    const partitionIndex = options.extraCompletionPartition;
    retained.set(
      `qualification/executions/${executionId}/evaluation-leaf-completions/${partitionIndex.toString().padStart(8, "0")}.json`,
      {
        customMetadata: {
          "osfo-body-sha256": "extra",
          "osfo-execution-id": executionId,
          "osfo-kind": "qualification-evaluation-leaf-completion-v1",
          "osfo-partition-index": String(partitionIndex),
          "osfo-plan-checksum": planChecksum,
        },
        value: "{}",
      },
    );
  }
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
    list: async (listOptions: {
      readonly cursor?: string;
      readonly limit: number;
      readonly prefix: string;
    }) => {
      const objects = [...retained.entries()].filter(([key]) => key.startsWith(listOptions.prefix));
      if (options.reverseInventory === true && listOptions.prefix.endsWith("/")) objects.reverse();
      const start = Number(listOptions.cursor ?? "0");
      const page = objects.slice(start, start + listOptions.limit);
      const next = start + page.length;
      const result = {
        objects: page.map(([key, value]) => ({
          checksums: {},
          customMetadata: value.customMetadata,
          key,
        })),
        truncated: next < objects.length,
      };
      return next < objects.length ? { ...result, cursor: String(next) } : result;
    },
    put: (
      key: string,
      value: string,
      putOptions: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: putOptions.customMetadata ?? {}, value });
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  };
  const sleeps = new Array<number>();
  const fanoutInput = {
    env: {
      ARTIFACTS: bucket,
      QUALIFICATION_EVALUATION_LEAF_WORKFLOW: {
        createBatch,
        get: (id: string) => Promise.resolve({ id }),
      },
    },
    launch: {
      pageCount: launchPageCount,
      partitionCount,
      terminalPageChecksum: terminalLaunchPageChecksum,
    },
    payload: {
      executionId,
      manifestChecksum,
      planChecksum,
      requestArtifactChecksum,
      requestArtifactId,
    },
    step: {
      do: async <Value>(_name: string, callback: () => Promise<Value>) =>
        structuredClone(await callback()),
      sleepUntil: (_name: string, timestamp: Date | number) => {
        sleeps.push(Number(timestamp));
        return Promise.resolve();
      },
    },
  } as const;
  const result = await runQualificationOwnerLeafFanout(fanoutInput);
  const firstJoinBytes = [...retained.entries()]
    .filter(([key]) => key.includes("/evaluation-leaf-completion-pages/"))
    .map(([key, value]) => [key, value.value] as const);
  const replayResult =
    options.replay === true ? await runQualificationOwnerLeafFanout(fanoutInput) : null;
  return { created, firstJoinBytes, replayResult, result, retained, sleeps };
};

it("fans out exact leaf payloads and retains closed MISSING and FAIL completions", async () => {
  const result = await runtime();
  expect(result.created).toHaveLength(2);
  expect(result.result).toMatchObject({
    completeOutcomeCount: 0,
    completionCount: 2,
    failOutcomeCount: 1,
    missingCompletionCount: 0,
    outcomeMissingCount: 1,
    pageCount: 1,
    status: "COMPLETE",
  });
  expect(result.sleeps).toHaveLength(1);
  expect(result.sleeps[0]).toBe(
    result.result.lastBatchLaunchedAtEpochMs + qualificationLeafCompletionHorizonMs,
  );
  const join = result.retained.get(
    `qualification/executions/${executionId}/evaluation-leaf-completion-pages/00000000.json`,
  );
  expect(join?.value).toContain('"missingCompletionCount":0');
  expect(join?.value).toContain('"outcomeMissingCount":1');
});

it("retains a missing-material join when an expected non-trailing completion is absent", async () => {
  const result = await runtime({ omitPartitions: [0] });
  expect(result.result).toMatchObject({
    completionCount: 1,
    missingCompletionCount: 1,
    status: "MISSING",
  });
  const join = result.retained.get(
    `qualification/executions/${executionId}/evaluation-leaf-completion-pages/00000000.json`,
  );
  expect(join?.value).toContain('"missingCompletionCount":1');
  expect(join?.value).toContain('"partitionIndex":1');
});

it("authenticates a COMPLETE nested leaf receipt and root accumulator", async () => {
  const result = await runtime({ completePartitions: [0] });
  expect(result.result).toMatchObject({
    completeOutcomeCount: 1,
    completionCount: 2,
    missingCompletionCount: 0,
    status: "COMPLETE",
  });
});

it("keeps launch-page authority when a sparse first page shifts later listing results", async () => {
  const result = await runtime({ omitPartitions: [0], partitionCount: 51 });
  expect(result.result).toMatchObject({
    completionCount: 50,
    failOutcomeCount: 50,
    missingCompletionCount: 1,
    pageCount: 2,
    status: "MISSING",
  });
  const firstJoin = result.retained.get(
    `qualification/executions/${executionId}/evaluation-leaf-completion-pages/00000000.json`,
  );
  const secondJoin = result.retained.get(
    `qualification/executions/${executionId}/evaluation-leaf-completion-pages/00000001.json`,
  );
  expect(firstJoin?.value).toContain('"missingCompletionCount":1');
  expect(firstJoin?.value).toContain('"observedFirstPartitionIndex":1');
  expect(firstJoin?.value).not.toContain('"partitionIndex":50');
  expect(secondJoin?.value).toContain('"missingCompletionCount":0');
  expect(secondJoin?.value).toContain('"partitionIndex":50');
});

it("retains an empty join page when every expected completion is absent", async () => {
  const result = await runtime({
    omitPartitions: Array.from({ length: 50 }, (_, partitionIndex) => partitionIndex),
    partitionCount: 50,
  });
  expect(result.result).toMatchObject({
    completionCount: 0,
    missingCompletionCount: 50,
    status: "MISSING",
  });
  const join = result.retained.get(
    `qualification/executions/${executionId}/evaluation-leaf-completion-pages/00000000.json`,
  );
  expect(join?.value).toContain('"observedFirstPartitionIndex":null');
  expect(join?.value).toContain('"observedLastPartitionIndex":null');
  expect(join?.value).toContain('"references":[]');
});

it("reconciles a lost createBatch response through the exact deterministic instance IDs", async () => {
  const result = await runtime({ loseCreateResponse: true });
  expect(result.result).toMatchObject({
    completionCount: 2,
    missingCompletionCount: 0,
    status: "COMPLETE",
  });
});

it("replays the exact immutable join-page bytes", async () => {
  const result = await runtime({ replay: true });
  expect(result.replayResult).toMatchObject({
    completionCount: result.result.completionCount,
    terminalPageChecksum: result.result.terminalPageChecksum,
  });
  expect(
    result.firstJoinBytes.map(([key, value]) => [key, result.retained.get(key)?.value ?? value]),
  ).toEqual(result.firstJoinBytes);
});

it.each([
  ["an out-of-range completion", { extraCompletionPartition: 2 }],
  ["reordered inventory", { reverseInventory: true }],
  ["a substituted leaf input", { tamperLeafInputPartition: 0 }],
  ["a cross-execution completion", { tamperCompletion: "execution" }],
  ["a cross-manifest completion", { tamperCompletion: "manifest" }],
  ["a cross-plan completion", { tamperCompletion: "plan" }],
  ["a cross-run completion", { tamperCompletion: "run" }],
  ["a partial createBatch response", { createBatchResponse: "partial" }],
  ["a wrong-ID createBatch response", { createBatchResponse: "wrong" }],
] as const)("rejects %s", async (_, options) => {
  await expect(runtime(options)).rejects.toThrow(/conflicts|extra/);
});

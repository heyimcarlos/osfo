/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Promise fakes model ordered Cloudflare Workflow and R2 durable boundaries. */
import { expect, it } from "vitest";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationEvaluationCorrectnessReducerWorkflowPayload } from "../workflow-contracts";
import { runQualificationEvaluationCorrectnessReducer } from "./qualification-evaluation-correctness-reducer";
import {
  createOrReconcileQualificationWorkflowBatch,
  runQualificationOwnerCorrectnessForest,
} from "./qualification-owner-correctness";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const runtime = async (options?: {
  readonly createResponse?: "partial" | "wrong";
  readonly extraCorrectnessCompletionPage?: boolean;
  readonly extraCorrectnessLaunchPage?: boolean;
  readonly extraJoinPage?: boolean;
  readonly leafCount?: number;
  readonly loseCreateResponse?: boolean;
  readonly missingJoinPage?: boolean;
  readonly replay?: boolean;
  readonly reorderJoinPage?: boolean;
  readonly skipReducer?: boolean;
  readonly status?: "complete" | "errored" | "queued" | "queuedThenComplete" | "terminated";
  readonly tamperReceipt?: boolean;
}) => {
  const executionId = "owner-correctness-runtime";
  const manifestChecksum = "manifest-checksum";
  const planChecksum = "plan-checksum";
  const leafCount = options?.leafCount ?? 17;
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const putObject = async (
    artifactId: string,
    body: { readonly checksum: string },
    metadata: Record<string, string>,
  ) => {
    const encoded = canonicalQualificationJson(body);
    retained.set(artifactId, {
      customMetadata: {
        "osfo-artifact-checksum": body.checksum,
        "osfo-body-sha256": await sha256Hex(encoded),
        "osfo-execution-id": executionId,
        "osfo-plan-checksum": planChecksum,
        ...metadata,
      },
      value: encoded,
    });
  };
  const references = [];
  for (let partitionIndex = 0; partitionIndex < leafCount; partitionIndex += 1) {
    const artifactId = `qualification/executions/${executionId}/evaluation-leaf-completions/${partitionIndex.toString().padStart(8, "0")}.json`;
    const outcomeStatus = partitionIndex === 0 ? ("FAIL" as const) : ("MISSING" as const);
    const outcome = {
      artifactId: `authority/${partitionIndex}.json`,
      code:
        outcomeStatus === "FAIL"
          ? ("qualificationEvaluationAuthorityConflict" as const)
          : ("qualificationEvaluationAuthorityMissing" as const),
      source: "worker_admission_receipts" as const,
      status: outcomeStatus,
    };
    const content = {
      artifactId,
      executionId,
      leafInputArtifactId: `leaf-input/${partitionIndex}.json`,
      leafInputChecksum: `leaf-input-${partitionIndex}`,
      manifestChecksum,
      outcome,
      partitionIndex,
      planChecksum,
      runId: `run-${partitionIndex}`,
      version: "qualification-evaluation-leaf-completion-v1" as const,
    };
    const completion = { ...content, checksum: qualificationChecksum(content) };
    await putObject(artifactId, completion, {
      "osfo-kind": "qualification-evaluation-leaf-completion-v1",
      "osfo-leaf-input-checksum": completion.leafInputChecksum,
      "osfo-outcome": outcomeStatus,
      "osfo-partition-index": String(partitionIndex),
      "osfo-record-count": "0",
      "osfo-run-id": completion.runId,
    });
    references.push({
      acceptedCount: 0,
      artifactId,
      checksum: completion.checksum,
      leafInputArtifactId: completion.leafInputArtifactId,
      leafInputChecksum: completion.leafInputChecksum,
      outcome: outcomeStatus,
      partitionIndex,
      rootCount: 0,
      runId: completion.runId,
    });
  }
  const joinPageCount = Math.ceil(leafCount / 50);
  let previousJoinChecksum = "NONE";
  for (let pageIndex = 0; pageIndex < joinPageCount; pageIndex += 1) {
    if (options?.missingJoinPage === true && pageIndex === 0) continue;
    const pageReferences = references.slice(pageIndex * 50, (pageIndex + 1) * 50);
    const first = pageIndex * 50;
    const last = Math.min(leafCount, (pageIndex + 1) * 50) - 1;
    const artifactId = `qualification/executions/${executionId}/evaluation-leaf-completion-pages/${pageIndex.toString().padStart(8, "0")}.json`;
    const content = {
      acceptedCount: 0,
      artifactId,
      completeOutcomeCount: 0,
      executionId,
      expectedFirstPartitionIndex: first,
      expectedLastPartitionIndex: last,
      failOutcomeCount: pageReferences.filter(({ outcome }) => outcome === "FAIL").length,
      launchPageChecksum: `leaf-launch-${pageIndex}`,
      manifestChecksum,
      missingCompletionCount: 0,
      observedFirstPartitionIndex: first,
      observedLastPartitionIndex: last,
      outcomeMissingCount: pageReferences.filter(({ outcome }) => outcome === "MISSING").length,
      pageIndex,
      planChecksum,
      previousPageChecksum:
        options?.reorderJoinPage === true && pageIndex === 1
          ? "foreign-previous-checksum"
          : previousJoinChecksum,
      references: pageReferences,
      rootCount: 0,
      version: "qualification-evaluation-leaf-completion-page-v1" as const,
    };
    const page = { ...content, checksum: qualificationChecksum(content) };
    await putObject(artifactId, page, {
      "osfo-expected-first-partition-index": String(first),
      "osfo-expected-last-partition-index": String(last),
      "osfo-index": String(pageIndex),
      "osfo-kind": "qualification-evaluation-leaf-completion-page-v1",
      "osfo-launch-page-checksum": content.launchPageChecksum,
      "osfo-manifest-checksum": manifestChecksum,
      "osfo-missing-completion-count": "0",
      "osfo-previous-checksum": content.previousPageChecksum,
      "osfo-record-count": String(pageReferences.length),
    });
    previousJoinChecksum = page.checksum;
  }
  if (options?.extraJoinPage === true) {
    retained.set(
      `qualification/executions/${executionId}/evaluation-leaf-completion-pages/99999999.json`,
      { customMetadata: {}, value: "{}" },
    );
  }
  let extraCorrectnessLaunchInserted = false;
  let extraCorrectnessCompletionInserted = false;
  const bucket = {
    get: (key: string) => {
      const value = retained.get(key);
      return Promise.resolve(
        value === undefined
          ? null
          : {
              customMetadata: value.customMetadata,
              text: () => Promise.resolve(value.value),
            },
      );
    },
    list: async (input: {
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
      return next < objects.length ? { ...result, cursor: String(next) } : result;
    },
    put: (
      key: string,
      value: string,
      input: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: input.customMetadata ?? {}, value });
      if (
        options?.extraCorrectnessLaunchPage === true &&
        !extraCorrectnessLaunchInserted &&
        input.customMetadata?.["osfo-kind"] === "qualification-correctness-launch-page-v1"
      ) {
        extraCorrectnessLaunchInserted = true;
        retained.set(`${key.slice(0, key.lastIndexOf("/") + 1)}99999999.json`, {
          customMetadata: {},
          value: "{}",
        });
      }
      if (
        options?.extraCorrectnessCompletionPage === true &&
        !extraCorrectnessCompletionInserted &&
        input.customMetadata?.["osfo-kind"] === "qualification-correctness-completion-page-v1"
      ) {
        extraCorrectnessCompletionInserted = true;
        retained.set(`${key.slice(0, key.lastIndexOf("/") + 1)}99999999.json`, {
          customMetadata: {},
          value: "{}",
        });
      }
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  };
  const payloads = new Array<QualificationEvaluationCorrectnessReducerWorkflowPayload>();
  const instances = new Map<
    string,
    {
      readonly id: string;
      readonly status: () => Promise<{
        readonly status: "complete" | "errored" | "queued" | "terminated";
      }>;
    }
  >();
  const statusCalls = new Map<string, number>();
  let lostResponse = false;
  const createBatch = async (
    batch: ReadonlyArray<{
      readonly id: string;
      readonly params: QualificationEvaluationCorrectnessReducerWorkflowPayload;
    }>,
  ) => {
    for (const { id, params } of batch) {
      payloads.push(params);
      if (
        options?.skipReducer !== true &&
        (options?.status ?? "complete") !== "errored" &&
        options?.status !== "terminated"
      ) {
        await runQualificationEvaluationCorrectnessReducer({
          env: { ARTIFACTS: bucket },
          payload: params,
          step: { do: async (_name, callback) => structuredClone(await callback()) },
        });
      }
      const instance = {
        id,
        status: () => {
          const calls = (statusCalls.get(id) ?? 0) + 1;
          statusCalls.set(id, calls);
          const configured = options?.status ?? "complete";
          const status: "complete" | "errored" | "queued" | "terminated" =
            configured === "queuedThenComplete"
              ? calls === 1
                ? "queued"
                : "complete"
              : configured;
          return Promise.resolve({
            status,
          });
        },
      };
      instances.set(id, instance);
    }
    if (options?.tamperReceipt === true) {
      const artifact = [...retained.entries()].find(
        ([, value]) =>
          value.customMetadata["osfo-kind"] === "qualification-evaluation-correctness-receipt-v1",
      );
      if (artifact !== undefined) artifact[1].customMetadata["osfo-verdict"] = "PASS";
    }
    if (options?.loseCreateResponse === true && !lostResponse) {
      lostResponse = true;
      throw new Error("lost create response");
    }
    const result = batch.map(({ id }) => {
      const instance = instances.get(id);
      if (instance === undefined) throw new Error("Correctness instance missing");
      return instance;
    });
    if (options?.createResponse === "partial") return result.slice(1);
    if (options?.createResponse === "wrong") {
      const first = result[0];
      if (first === undefined) throw new Error("Correctness create result is empty");
      return [{ ...first, id: "foreign-instance" }];
    }
    return result;
  };
  const input = {
    env: {
      ARTIFACTS: bucket,
      QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW: {
        createBatch,
        get: (id: string) => {
          const instance = instances.get(id);
          return instance === undefined
            ? Promise.reject(new Error("Correctness instance missing"))
            : Promise.resolve(instance);
        },
      },
    },
    leaf: {
      acceptedCount: 0,
      completeOutcomeCount: 0,
      completionCount: leafCount,
      failOutcomeCount: 1,
      lastBatchLaunchedAtEpochMs: 0,
      missingCompletionCount: 0,
      outcomeMissingCount: leafCount - 1,
      pageCount: joinPageCount,
      rootCount: 0,
      status: "COMPLETE" as const,
      terminalPageChecksum: previousJoinChecksum,
    },
    payload: {
      executionId,
      manifestChecksum,
      planChecksum,
      requestArtifactChecksum: "request-checksum",
      requestArtifactId: "owner-request.json",
    },
    step: {
      do: async <Value>(_name: string, callback: () => Promise<Value>) =>
        structuredClone(await callback()),
      sleepUntil: () => Promise.resolve(),
    },
  } as const;
  const result = await runQualificationOwnerCorrectnessForest(input);
  const firstCompletionPages = [...retained.entries()]
    .filter(([key]) => key.includes("/owner-completion-pages/"))
    .map(([key, value]) => [key, value.value] as const);
  const replay =
    options?.replay === true ? await runQualificationOwnerCorrectnessForest(input) : null;
  return { firstCompletionPages, payloads, replay, result, retained, statusCalls };
};

it("reduces mixed closed leaf outcomes through an authenticated multi-level root", async () => {
  const result = await runtime({ status: "queuedThenComplete" });
  expect(result.payloads.map(({ level, index, inputs }) => [level, index, inputs.length])).toEqual([
    [1, 0, 16],
    [1, 1, 1],
    [2, 0, 2],
  ]);
  expect(result.result).toMatchObject({ levelCount: 2, status: "COMPLETE", verdict: "FAIL" });
  expect([...result.statusCalls.values()].every((count) => count >= 2)).toBe(true);
});

it("reconciles a lost create response and replays byte-identical join pages", async () => {
  const result = await runtime({ loseCreateResponse: true, replay: true });
  expect(result.replay).toEqual(result.result);
  expect(
    [...result.retained.entries()]
      .filter(([key]) => key.includes("/owner-completion-pages/"))
      .map(([key, value]) => [key, value.value] as const),
  ).toEqual(result.firstCompletionPages);
});

it.each(["partial", "wrong"] as const)(
  "fails a %s createBatch response",
  async (createResponse) => {
    await expect(runtime({ createResponse })).resolves.toMatchObject({
      result: { code: "qualificationCorrectnessLaunchConflict", status: "FAIL" },
    });
  },
);

it.each(["errored", "terminated"] as const)(
  "classifies %s child status as FAIL",
  async (status) => {
    await expect(runtime({ status })).resolves.toMatchObject({
      result: { code: "qualificationCorrectnessWorkflowFailed", status: "FAIL" },
    });
  },
);

it("classifies unfinished children as MISSING", async () => {
  await expect(runtime({ status: "queued" })).resolves.toMatchObject({
    result: { code: "qualificationCorrectnessWorkflowUnsettled", status: "MISSING" },
  });
});

it("classifies a completed child with no retained output as MISSING", async () => {
  await expect(runtime({ skipReducer: true })).resolves.toMatchObject({
    result: { code: "qualificationCorrectnessReceiptMaterial", status: "MISSING" },
  });
});

it("rejects tampered correctness receipt metadata", async () => {
  await expect(runtime({ tamperReceipt: true })).resolves.toMatchObject({
    result: { code: "qualificationCorrectnessReceiptMaterial", status: "FAIL" },
  });
});

it("distinguishes missing and extra leaf join pages", async () => {
  await expect(runtime({ missingJoinPage: true })).resolves.toMatchObject({
    result: { code: "qualificationEvaluationLeafJoinMaterial", status: "MISSING" },
  });
  await expect(runtime({ extraJoinPage: true })).resolves.toMatchObject({
    result: { code: "qualificationEvaluationLeafJoinMaterial", status: "FAIL" },
  });
});

it("rejects a reordered chained leaf join page", async () => {
  await expect(runtime({ leafCount: 51, reorderJoinPage: true })).resolves.toMatchObject({
    result: { code: "qualificationEvaluationLeafJoinMaterial", status: "FAIL" },
  });
});

it("rejects extra correctness launch and completion pages", async () => {
  await expect(runtime({ extraCorrectnessLaunchPage: true })).resolves.toMatchObject({
    result: { code: "qualificationCorrectnessLaunchMaterial", status: "FAIL" },
  });
  await expect(runtime({ extraCorrectnessCompletionPage: true })).resolves.toMatchObject({
    result: { code: "qualificationCorrectnessCompletionMaterial", status: "FAIL" },
  });
});

it("reconciles fifty ambiguous Workflow creations sequentially", async () => {
  let active = 0;
  let maximumActive = 0;
  const batch = Array.from({ length: 50 }, (_, index) => ({
    id: `partition-${index}`,
    params: index,
  }));
  const result = await createOrReconcileQualificationWorkflowBatch({
    batch,
    createBatch: () => Promise.reject(new Error("lost create response")),
    get: async (id) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return { id };
    },
  });
  expect(result.status).toBe("COMPLETE");
  expect(maximumActive).toBe(1);
});

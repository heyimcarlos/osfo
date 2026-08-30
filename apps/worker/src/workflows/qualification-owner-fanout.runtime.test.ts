/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Promise fakes model ordered Cloudflare Workflow and R2 boundaries. */
import { expect, it } from "@effect/vitest";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type {
  QualificationEvaluationCorrectnessReducerWorkflowPayload,
  QualificationEvaluationLeafWorkflowPayload,
  QualificationOwnerPartitionWorkflowPayload,
} from "../workflow-contracts";
import { runQualificationOwnerWorkflow } from "./qualification-owner";
import { runQualificationEvaluationCorrectnessReducer } from "./qualification-evaluation-correctness-reducer";

const executionId = "owner-leaf-integration";
const manifestChecksum = "manifest-checksum";
const planChecksum = "plan-checksum";
const requestArtifactId = `qualification/executions/${executionId}/owner-request.json`;

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const runtime = async (
  omitLeafCompletion: boolean,
  partitionCreateResponse?: "partial" | "wrong",
) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const retain = async <Value extends object>(
    artifactId: string,
    value: Value,
    metadata: Record<string, string>,
  ) => {
    const encoded = canonicalQualificationJson(value);
    retained.set(artifactId, {
      customMetadata: { ...metadata, "osfo-body-sha256": await sha256Hex(encoded) },
      value: encoded,
    });
    return value;
  };
  const startsAtEpochMs = Date.parse("2099-08-29T17:00:00.000Z");
  const requestContent = {
    authoritySources: [...qualificationAuthoritySources],
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: "qualification/cohort.json",
    executionId,
    manifest: { sourceVersion: "source-version" },
    manifestChecksum,
    plan: { startsAtEpochMs },
    planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const ownerRequest = {
    ...requestContent,
    artifactChecksum: qualificationChecksum(requestContent),
  };
  await retain(requestArtifactId, ownerRequest, {});
  const payload = {
    executionId,
    manifestChecksum,
    planChecksum,
    requestArtifactChecksum: ownerRequest.artifactChecksum,
    requestArtifactId,
  };
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
    list: async (options: {
      readonly cursor?: string;
      readonly limit: number;
      readonly prefix: string;
    }) => {
      const objects = [...retained.entries()].filter(([key]) => key.startsWith(options.prefix));
      const start = Number(options.cursor ?? "0");
      const page = objects.slice(start, start + options.limit);
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
      options: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: options.customMetadata ?? {}, value });
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  };
  const partitionPayloads = new Array<QualificationOwnerPartitionWorkflowPayload>();
  const leafPayloads = new Array<QualificationEvaluationLeafWorkflowPayload>();
  const correctnessPayloads = new Array<QualificationEvaluationCorrectnessReducerWorkflowPayload>();
  const correctnessInstances = new Map<
    string,
    { readonly id: string; readonly status: () => Promise<{ readonly status: "complete" }> }
  >();
  const result = await runQualificationOwnerWorkflow({
    env: {
      ARTIFACTS: bucket,
      PRODUCT_AUTHORITY: {
        fetch: () =>
          Promise.resolve(
            Response.json({
              runs: [
                {
                  arrivalCount: 1,
                  chunkCount: 1,
                  chunkStartsAtEpochMs: [startsAtEpochMs],
                  firstStreamChunkIndex: 0,
                  runId: "run-1",
                },
              ],
              sources: [...qualificationAuthoritySources],
              status: "READY",
              totalArrivalChunks: 1,
            }),
          ),
      },
      QUALIFICATION_EVALUATION_LEAF_WORKFLOW: {
        createBatch: async (batch) => {
          for (const { id, params } of batch) {
            expect(id).toBe(`${executionId}:evaluation-leaf:0`);
            leafPayloads.push(params);
            if (omitLeafCompletion) continue;
            const artifactId = `qualification/executions/${executionId}/evaluation-leaf-completions/00000000.json`;
            const outcome = {
              artifactId: params.leafInputArtifactId,
              code: "qualificationEvaluationAuthorityMissing" as const,
              source: "worker_admission_receipts" as const,
              status: "MISSING" as const,
            };
            const content = {
              artifactId,
              executionId,
              leafInputArtifactId: params.leafInputArtifactId,
              leafInputChecksum: params.leafInputChecksum,
              manifestChecksum,
              outcome,
              partitionIndex: 0,
              planChecksum,
              runId: "run-1",
              version: "qualification-evaluation-leaf-completion-v1" as const,
            };
            const completion = { ...content, checksum: qualificationChecksum(content) };
            await retain(artifactId, completion, {
              "osfo-artifact-checksum": completion.checksum,
              "osfo-execution-id": executionId,
              "osfo-kind": "qualification-evaluation-leaf-completion-v1",
              "osfo-leaf-input-checksum": params.leafInputChecksum,
              "osfo-outcome": "MISSING",
              "osfo-partition-index": "0",
              "osfo-plan-checksum": planChecksum,
              "osfo-record-count": "0",
              "osfo-run-id": "run-1",
            });
          }
          return batch.map(({ id }) => ({ id }));
        },
        get: (id) => Promise.resolve({ id }),
      },
      QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW: {
        createBatch: async (batch) => {
          for (const { id, params } of batch) {
            correctnessPayloads.push(params);
            await runQualificationEvaluationCorrectnessReducer({
              env: { ARTIFACTS: bucket },
              payload: params,
              step: { do: async (_name, callback) => structuredClone(await callback()) },
            });
            correctnessInstances.set(id, {
              id,
              status: () => Promise.resolve({ status: "complete" }),
            });
          }
          return batch.map(({ id }) => {
            const instance = correctnessInstances.get(id);
            if (instance === undefined) throw new Error("Correctness instance is missing");
            return instance;
          });
        },
        get: (id) => {
          const instance = correctnessInstances.get(id);
          return instance === undefined
            ? Promise.reject(new Error("Correctness instance is missing"))
            : Promise.resolve(instance);
        },
      },
      QUALIFICATION_OWNER_PARTITION_WORKFLOW: {
        createBatch: async (batch) => {
          for (const { id, params } of batch) {
            expect(id).toBe(`${executionId}:partition:0`);
            partitionPayloads.push(params);
            const sourceChecksums = qualificationAuthoritySources.map((source) => ({
              checksum: qualificationChecksum({ source }),
              recordCount: 0,
              source,
            }));
            const leafInputArtifactId = `qualification/executions/${executionId}/evaluation-leaf-inputs/00000000.json`;
            const leafContent = {
              artifactId: leafInputArtifactId,
              arrivalChecksum: "arrival-checksum",
              arrivalRecordCount: 1,
              authorityInputs: sourceChecksums,
              executionId,
              partitionAuthorityChecksum: qualificationChecksum({
                arrivalChecksum: "arrival-checksum",
                executionId,
                partitionIndex: 0,
                planChecksum,
                sourceChecksums,
                streamChunkIndex: 0,
              }),
              partitionIndex: 0,
              planChecksum,
              streamChunkIndex: 0,
              version: "qualification-evaluation-leaf-input-v1" as const,
            };
            const leafInput = { ...leafContent, checksum: qualificationChecksum(leafContent) };
            await retain(leafInputArtifactId, leafInput, {
              "osfo-artifact-checksum": leafInput.checksum,
              "osfo-execution-id": executionId,
              "osfo-index": "0",
              "osfo-kind": "qualification-evaluation-leaf-input-v1",
              "osfo-plan-checksum": planChecksum,
              "osfo-record-count": "1",
            });
            const artifactId = `qualification/executions/${executionId}/owner-partitions/00000000.json`;
            const content = {
              arrivalArtifactChecksum: "arrival-checksum",
              arrivalArtifactId: "qualification/arrival.json",
              artifactId,
              chunkIndex: 0,
              executionId,
              failureCode: null,
              leafInputArtifactChecksum: leafInput.checksum,
              leafInputArtifactId,
              missingSources: [],
              outcome: "COMPLETE" as const,
              partitionIndex: 0,
              planChecksum,
              recordCount: 1,
              runId: "run-1",
              sourceChecksums,
              streamChunkIndex: 0,
              version: "qualification-owner-partition-v1" as const,
            };
            const receipt = { ...content, checksum: qualificationChecksum(content) };
            await retain(artifactId, receipt, {
              "osfo-artifact-checksum": receipt.checksum,
              "osfo-execution-id": executionId,
              "osfo-index": "0",
              "osfo-kind": "qualification-owner-partition-v1",
              "osfo-outcome": "COMPLETE",
              "osfo-plan-checksum": planChecksum,
              "osfo-record-count": "1",
            });
          }
          const created = batch.map(({ id }) => ({ id }));
          if (partitionCreateResponse === "partial") return created.slice(1);
          if (partitionCreateResponse === "wrong") return [{ id: "foreign-partition-instance" }];
          return created;
        },
        get: (id) => Promise.resolve({ id }),
      },
    },
    payload,
    step: {
      do: async (_name, callback) => structuredClone(await callback()),
      sleepUntil: () => Promise.resolve(),
    },
  });
  return { correctnessPayloads, leafPayloads, partitionPayloads, result, retained };
};

it("fans authenticated partition inputs into leaves before stopping at the missing reducer", async () => {
  const result = await runtime(false);
  expect(result.partitionPayloads).toHaveLength(1);
  expect(result.leafPayloads).toHaveLength(1);
  expect(result.correctnessPayloads).toHaveLength(1);
  expect(result.result).toEqual({ status: "MISSING" });
  expect(
    result.retained.get(`qualification/executions/${executionId}/owner-response.json`)?.value,
  ).toContain('"missingSources":["bounded_qualification_reducer"]');
});

it("reports absent leaf completion material distinctly from the unbuilt reducer", async () => {
  const result = await runtime(true);
  expect(result.result).toEqual({ status: "MISSING" });
  expect(
    result.retained.get(`qualification/executions/${executionId}/owner-response.json`)?.value,
  ).toContain('"missingSources":["qualification_evaluation_leaf_completions"]');
});

it.each(["partial", "wrong"] as const)(
  "rejects a %s partition createBatch response",
  async (partitionCreateResponse) => {
    await expect(runtime(false, partitionCreateResponse)).rejects.toThrow(
      "Qualification partition create response conflicts",
    );
  },
);

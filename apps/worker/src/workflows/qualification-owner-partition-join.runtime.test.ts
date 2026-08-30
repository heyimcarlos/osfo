/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Promise fakes model ordered Cloudflare Workflow and R2 boundaries. */
import { expect, it } from "@effect/vitest";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { verifyPartitionCompletionPages } from "./qualification-owner";

const executionId = "partition-join-execution";
const manifestChecksum = "manifest-checksum";
const planChecksum = "plan-checksum";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const runtime = async (omitted: ReadonlyArray<number>) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const retain = async <Value extends object>(
    artifactId: string,
    value: Value,
    customMetadata: Record<string, string>,
  ) => {
    const encoded = canonicalQualificationJson(value);
    retained.set(artifactId, {
      customMetadata: { ...customMetadata, "osfo-body-sha256": await sha256Hex(encoded) },
      value: encoded,
    });
    return value;
  };
  const partitions = Array.from({ length: 51 }, (_, partitionIndex) => ({
    chunkIndex: 0,
    firstOfferedAtEpochMs: partitionIndex,
    partitionIndex,
    runId: "run-1",
    streamChunkIndex: partitionIndex,
  }));
  for (const partition of partitions) {
    if (omitted.includes(partition.partitionIndex)) continue;
    const sourceChecksums = qualificationAuthoritySources.map((source) => ({
      checksum: qualificationChecksum({ partitionIndex: partition.partitionIndex, source }),
      recordCount: 0,
      source,
    }));
    const leafArtifactId = `qualification/executions/${executionId}/evaluation-leaf-inputs/${partition.partitionIndex.toString().padStart(8, "0")}.json`;
    const leafContent = {
      artifactId: leafArtifactId,
      arrivalChecksum: `arrival-${partition.partitionIndex}`,
      arrivalRecordCount: 1,
      authorityInputs: sourceChecksums,
      executionId,
      partitionAuthorityChecksum: qualificationChecksum({
        arrivalChecksum: `arrival-${partition.partitionIndex}`,
        executionId,
        partitionIndex: partition.partitionIndex,
        planChecksum,
        sourceChecksums,
        streamChunkIndex: partition.streamChunkIndex,
      }),
      partitionIndex: partition.partitionIndex,
      planChecksum,
      streamChunkIndex: partition.streamChunkIndex,
      version: "qualification-evaluation-leaf-input-v1" as const,
    };
    const leaf = { ...leafContent, checksum: qualificationChecksum(leafContent) };
    await retain(leafArtifactId, leaf, {
      "osfo-artifact-checksum": leaf.checksum,
      "osfo-execution-id": executionId,
      "osfo-index": String(partition.streamChunkIndex),
      "osfo-kind": "qualification-evaluation-leaf-input-v1",
      "osfo-plan-checksum": planChecksum,
      "osfo-record-count": "1",
    });
    const artifactId = `qualification/executions/${executionId}/owner-partitions/${partition.streamChunkIndex.toString().padStart(8, "0")}.json`;
    const content = {
      arrivalArtifactChecksum: `arrival-${partition.partitionIndex}`,
      arrivalArtifactId: `qualification/arrivals/${partition.partitionIndex}`,
      artifactId,
      chunkIndex: partition.chunkIndex,
      executionId,
      failureCode: null,
      leafInputArtifactChecksum: leaf.checksum,
      leafInputArtifactId: leafArtifactId,
      missingSources: [],
      outcome: "COMPLETE" as const,
      partitionIndex: partition.partitionIndex,
      planChecksum,
      recordCount: 1,
      runId: partition.runId,
      sourceChecksums,
      streamChunkIndex: partition.streamChunkIndex,
      version: "qualification-owner-partition-v1" as const,
    };
    const receipt = { ...content, checksum: qualificationChecksum(content) };
    await retain(artifactId, receipt, {
      "osfo-artifact-checksum": receipt.checksum,
      "osfo-execution-id": executionId,
      "osfo-index": String(partition.streamChunkIndex),
      "osfo-kind": "qualification-owner-partition-v1",
      "osfo-outcome": "COMPLETE",
      "osfo-plan-checksum": planChecksum,
      "osfo-record-count": "1",
    });
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
  const result = await verifyPartitionCompletionPages({
    bucket,
    executionId,
    manifestChecksum,
    partitions,
    planChecksum,
    step: {
      do: async (_name, callback) => structuredClone(await callback()),
      sleepUntil: () => Promise.resolve(),
    },
  });
  return { result, retained };
};

it("authenticates complete partition pages when R2 listing has no SHA-256", async () => {
  const result = await runtime([]);
  expect(result.result).toMatchObject({
    launch: { pageCount: 2, partitionCount: 51 },
    missingPartitionCount: 0,
  });
  expect(
    result.retained.get(
      `qualification/executions/${executionId}/evaluation-leaf-launch-pages/00000001.json`,
    ),
  ).toBeDefined();
});

it("classifies a sparse first-page partition as missing without shifting page-two authority", async () => {
  const result = await runtime([0]);
  expect(result.result).toMatchObject({ launch: null, missingPartitionCount: 1 });
  const secondPage = result.result.pages[1];
  expect(secondPage).toMatchObject({ firstStreamChunkIndex: 50, lastStreamChunkIndex: 50 });
  expect(secondPage?.failureCodes).toEqual([]);
  expect(
    result.retained.has(
      `qualification/executions/${executionId}/evaluation-leaf-launch-pages/00000001.json`,
    ),
  ).toBe(false);
});

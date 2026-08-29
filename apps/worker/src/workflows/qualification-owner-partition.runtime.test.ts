/* oxlint-disable effecttsgo/async-function -- Runtime fakes model Promise-native Workflow, service-binding, and R2 boundaries. */
import { expect, it } from "vitest";
import { Schema } from "effect";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationOwnerPartitionWorkflowPayload } from "../workflow-contracts";
import { runQualificationOwnerPartition } from "./qualification-owner-partition";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const payload: QualificationOwnerPartitionWorkflowPayload = {
  chunks: [
    {
      chunkIndex: 0,
      firstOfferedAtEpochMs: Date.parse("2026-08-29T17:00:00.000Z"),
      runId: "run-1",
      streamChunkIndex: 0,
    },
  ],
  executionId: "partition-execution",
  firstStreamChunkIndex: 0,
  lastStreamChunkIndex: 0,
  manifestChecksum: "manifest-checksum",
  partitionIndex: 0,
  planChecksum: "plan-checksum",
  requestArtifactChecksum: "request-checksum",
  requestArtifactId: "qualification/executions/partition-execution/owner-request.json",
  sourceVersion: "source-version",
};

const runtime = async (
  tamper: "bundleCount" | "duplicateSource" | "metadata" | "missing" | null = null,
) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
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
      options: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: options.customMetadata ?? {}, value });
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  };
  let arrivalEffects = 0;
  let sourceCollections = 0;
  const fetcher = {
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(new Request(input).url).pathname;
      if (path.endsWith("/arrival-chunks")) {
        const bodyContent = {
          chunkIndex: 0,
          executionId: payload.executionId,
          planChecksum: payload.planChecksum,
          previousArtifactChecksum: "NONE" as const,
          records: [{ rootId: "root-1" }],
          runId: "run-1",
          streamChunkIndex: 0,
        };
        const body = { ...bodyContent, bodyChecksum: qualificationChecksum(bodyContent) };
        const encoded = canonicalQualificationJson(body);
        const bodySha256 = await sha256Hex(encoded);
        const artifactId =
          "qualification/executions/partition-execution/authority-streams/arrivals/partitions/00000000/00000000.json";
        if (!retained.has(artifactId)) arrivalEffects += 1;
        const descriptor = {
          bodySha256,
          component: "arrivals",
          executionId: payload.executionId,
          index: 0,
          planChecksum: payload.planChecksum,
          previousArtifactChecksum: "NONE",
          recordCount: 1,
          sourceVersion: payload.sourceVersion,
        };
        const artifactChecksum = qualificationChecksum(descriptor);
        retained.set(artifactId, {
          customMetadata: {
            "osfo-artifact-checksum": artifactChecksum,
            "osfo-body-sha256": bodySha256,
            "osfo-component": "arrivals",
            "osfo-execution-id": payload.executionId,
            "osfo-index": "0",
            "osfo-plan-checksum": payload.planChecksum,
            "osfo-previous-checksum": "NONE",
            "osfo-record-count": "1",
            "osfo-stream-chunk-index": "0",
          },
          value: encoded,
        });
        return Response.json({
          artifactChecksum,
          artifactId,
          chunkIndex: 0,
          firstArrivalIndex: 0,
          recordCount: 1,
          runId: "run-1",
          status: "COMPLETE",
          streamChunkIndex: 0,
        });
      }
      sourceCollections += 1;
      if (tamper === "missing") {
        return Response.json(
          {
            missingSources: [
              { detail: "provider evidence unavailable", source: "provider_delivery_receipts" },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const recordCounts = new Array<{ recordCount: number; source: string }>();
      for (const [index, source] of qualificationAuthoritySources.entries()) {
        const artifactId = `qualification/executions/partition-execution/producer-authority/${source}/partitions/00000000/00000000.json`;
        const content = {
          artifactId,
          authority: source,
          executionId: payload.executionId,
          exportedAtUtc: "2026-08-29T17:00:01.000Z",
          index: 0,
          planChecksum: payload.planChecksum,
          previousArtifactChecksum: "NONE" as const,
          recordCount: 1,
          records: [{ occurredAt: "2026-08-29T17:00:01.000Z", rootId: "root-1" }],
          sourceVersion: payload.sourceVersion,
          streamChunkIndex: 0,
        };
        const shard = { ...content, checksum: qualificationChecksum(content) };
        const encoded = canonicalQualificationJson(shard);
        // oxlint-disable-next-line eslint/no-await-in-loop -- The fake retains deterministic source bodies in canonical authority order.
        const bodySha256 = await sha256Hex(encoded);
        retained.set(artifactId, {
          customMetadata: {
            "osfo-artifact-checksum": shard.checksum,
            "osfo-body-sha256": bodySha256,
            "osfo-execution-id": payload.executionId,
            "osfo-index": "0",
            "osfo-plan-checksum": payload.planChecksum,
            "osfo-previous-checksum": "NONE",
            "osfo-record-count": "1",
            "osfo-source": source,
            "osfo-source-version": payload.sourceVersion,
            "osfo-stream-chunk-index": tamper === "metadata" && index === 0 ? "7" : "0",
          },
          value: encoded,
        });
        recordCounts.push({
          recordCount: tamper === "bundleCount" && index === 0 ? 2 : 1,
          source,
        });
      }
      if (tamper === "duplicateSource") {
        recordCounts[1] = { recordCount: 1, source: recordCounts[0]?.source ?? "" };
      }
      return Response.json({ recordCounts, status: "COMPLETE", streamChunkIndex: 0 });
    },
  };
  const step = {
    do: <Value>(_name: string, callback: () => Promise<Value>) => callback(),
    sleepUntil: () => Promise.resolve(),
  };
  const env = { ARTIFACTS: bucket, PRODUCT_AUTHORITY: fetcher };
  const first = await runQualificationOwnerPartition({ env, payload, step });
  const firstBytes = retained.get(
    "qualification/executions/partition-execution/owner-partitions/00000000.json",
  )?.value;
  const second = await runQualificationOwnerPartition({ env, payload, step });
  return {
    arrivalEffects,
    first,
    firstBytes,
    retained,
    second,
    sourceCollections,
  };
};

it("retains byte-identical COMPLETE once and replays no arrival or provider effect", async () => {
  const result = await runtime();
  expect(result.first).toMatchObject({ outcome: "COMPLETE" });
  expect(result.second).toEqual(result.first);
  expect(result.arrivalEffects).toBe(1);
  expect(result.sourceCollections).toBe(2);
  expect(result.firstBytes).toBe(
    result.retained.get(
      "qualification/executions/partition-execution/owner-partitions/00000000.json",
    )?.value,
  );
});

it("retains named MISSING instead of leaving the coordinator waiting", async () => {
  const result = await runtime("missing");
  expect(result.first).toMatchObject({
    missingSources: ["provider_delivery_receipts"],
    outcome: "MISSING",
  });
  expect(result.second).toEqual(result.first);
});

it.each(["bundleCount", "duplicateSource", "metadata"] as const)(
  "retains deterministic FAIL for %s authority conflict",
  async (tamper) => {
    const result = await runtime(tamper);
    expect(result.first).toMatchObject({
      failureCode: "qualificationPartitionAuthorityConflict",
      outcome: "FAIL",
    });
    expect(result.second).toEqual(result.first);
  },
);

it("decodes the retained completion as a closed outcome contract", async () => {
  const result = await runtime();
  const encoded = result.firstBytes;
  if (encoded === undefined) throw new Error("Expected completion bytes");
  expect(
    Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          checksum: Schema.String,
          outcome: Schema.Literals(["COMPLETE", "FAIL", "MISSING"]),
          sourceChecksums: Schema.Array(Schema.Unknown),
        }),
      ),
    )(encoded),
  ).toMatchObject({ outcome: "COMPLETE", sourceChecksums: expect.any(Array) });
});

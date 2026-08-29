/* oxlint-disable effecttsgo/async-function -- Promise fakes model Cloudflare Workflow steps and service bindings. */
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

import type { QualificationProductAuthorityInvocation } from "../qualification/product-authority-contract";
import { collectQualificationSourceChunk } from "./qualification-owner";

const invocation: QualificationProductAuthorityInvocation = {
  executionId: "qualification-execution-1",
  manifestChecksum: "manifest-checksum-1",
  planChecksum: "plan-checksum-1",
  requestArtifactChecksum: "request-checksum-1",
  requestArtifactId: "qualification/request-1.json",
};

it("durably waits through provisional source evidence and retains the exact frozen shard identity", async () => {
  const responses = [
    Response.json(
      {
        retryAtEpochMs: Date.parse("2026-08-29T17:05:00.000Z"),
        source: "provider_delivery_receipts",
        status: "PENDING",
      },
      { status: 202 },
    ),
    Response.json(
      {
        retryAtEpochMs: Date.parse("2026-08-29T17:06:00.000Z"),
        source: "provider_delivery_receipts",
        status: "PENDING",
      },
      { status: 202 },
    ),
    Response.json({
      recordCount: 12,
      source: "provider_delivery_receipts",
      status: "COMPLETE",
      streamChunkIndex: 7,
    }),
  ];
  const requests = new Array<unknown>();
  const stepNames = new Array<string>();
  const sleeps = new Array<Date | number>();
  const outcome = await collectQualificationSourceChunk({
    chunkIndex: 3,
    fetcher: {
      fetch: async (_input, init) => {
        requests.push(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(init?.body));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected source collection call");
        return response;
      },
    },
    invocation,
    runId: "qualification-run-1",
    source: "provider_delivery_receipts",
    step: {
      do: async (name, callback) => {
        stepNames.push(name);
        return structuredClone(await callback());
      },
      sleepUntil: async (_name, timestamp) => {
        sleeps.push(timestamp);
      },
    },
    streamChunkIndex: 7,
  });

  expect(outcome).toEqual({
    recordCount: 12,
    source: "provider_delivery_receipts",
    status: "COMPLETE",
    streamChunkIndex: 7,
  });
  expect(requests).toEqual([
    {
      ...invocation,
      chunkIndex: 3,
      runId: "qualification-run-1",
      source: "provider_delivery_receipts",
    },
    {
      ...invocation,
      chunkIndex: 3,
      runId: "qualification-run-1",
      source: "provider_delivery_receipts",
    },
    {
      ...invocation,
      chunkIndex: 3,
      runId: "qualification-run-1",
      source: "provider_delivery_receipts",
    },
  ]);
  expect(stepNames).toEqual([
    "collect provider_delivery_receipts chunk 3 attempt 1",
    "collect provider_delivery_receipts chunk 3 attempt 2",
    "collect provider_delivery_receipts chunk 3 attempt 3",
  ]);
  expect(sleeps).toEqual([
    Date.parse("2026-08-29T17:05:00.000Z"),
    Date.parse("2026-08-29T17:06:00.000Z"),
  ]);
});

it("preserves the exact attempted missing source instead of fabricating a terminal outcome", async () => {
  const outcome = await collectQualificationSourceChunk({
    chunkIndex: 0,
    fetcher: {
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              missingSources: [
                {
                  detail:
                    "Scheduled Email provider evidence did not settle by its authority horizon",
                  source: "provider_delivery_receipts",
                },
              ],
              status: "MISSING",
            },
            { status: 424 },
          ),
        ),
    },
    invocation,
    runId: "qualification-run-1",
    source: "provider_delivery_receipts",
    step: {
      do: (_name, callback) => callback(),
      sleepUntil: () => Promise.reject(new Error("MISSING must not poll")),
    },
    streamChunkIndex: 0,
  });

  expect(outcome).toMatchObject({
    missingSources: [{ source: "provider_delivery_receipts" }],
    status: "MISSING",
  });
});

it("rejects a replayed or regressing source retry timestamp", async () => {
  const retryAtEpochMs = Date.parse("2026-08-29T17:05:00.000Z");
  const fetcher = {
    fetch: () =>
      Promise.resolve(
        Response.json(
          {
            retryAtEpochMs,
            source: "provider_delivery_receipts",
            status: "PENDING",
          },
          { status: 202 },
        ),
      ),
  };
  await expect(
    collectQualificationSourceChunk({
      chunkIndex: 0,
      fetcher,
      invocation,
      runId: "qualification-run-1",
      source: "provider_delivery_receipts",
      step: {
        do: (_name, callback) => callback(),
        sleepUntil: () => Promise.resolve(),
      },
      streamChunkIndex: 0,
    }),
  ).rejects.toThrow("retry conflicts");
});

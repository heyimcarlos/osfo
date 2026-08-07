import { prepareMessageAdmissionFixture, readMessageAuthorityCounts } from "@osfo/db/testing";
import { seedReferenceClientAuthority } from "@osfo/db/reference-client";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { startCompiledIngress } from "../src/testing.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "browser-composition-session";

describe("Osfo ingress composition", () => {
  it.live("accepts one authenticated Thread message durably", () =>
    Effect.gen(function* () {
      yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });

      const ingress = yield* startCompiledIngress({
        databaseUrl,
        executionProfileRef: "oz.composition-test.v1",
      });

      const idempotencyKey = crypto.randomUUID();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${ingress.origin}/v1/threads/${threadId}/messages`).pipe(
          HttpClientRequest.bearerToken(authenticationToken),
          HttpClientRequest.bodyJsonUnsafe({
            protocolVersion: 1,
            idempotencyKey,
            message: { content: "Hello through HTTP" },
          }),
        ),
      );

      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject({
        protocolVersion: 1,
        idempotencyKey,
        threadId,
        threadPosition: "1",
      });

      const reconciled = yield* readMessageAuthorityCounts(databaseUrl);
      expect(reconciled).toEqual({ receipts: "1", messages: "1", runs: "1", outbox: "1" });

      const snapshotResponse = yield* client.execute(
        HttpClientRequest.get(`${ingress.origin}/v1/threads/${threadId}/snapshot`).pipe(
          HttpClientRequest.bearerToken(authenticationToken),
        ),
      );
      expect(snapshotResponse.status).toBe(200);
      expect(yield* snapshotResponse.json).toMatchObject({
        throughPosition: "1",
        timeline: [
          {
            type: "userMessage",
            content: [{ type: "text", text: "Hello through HTTP" }],
          },
        ],
      });
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});

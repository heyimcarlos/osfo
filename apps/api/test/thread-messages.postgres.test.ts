import { prepareMessageAdmissionFixture, readMessageAuthorityCounts } from "@osfo/db/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { startApiProcess } from "./api-process";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "browser-composition-session";

describe("Osfo API composition", () => {
  it("accepts one authenticated Thread message durably", async () => {
    await Effect.runPromise(
      prepareMessageAdmissionFixture(databaseUrl, {
        principals: [{ principalId, authenticationToken, threadIds: [threadId] }],
      }),
    );

    const api = await startApiProcess({
      databaseUrl,
      executionProfileRef: "oz.composition-test.v1",
    });

    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.execute(
            HttpClientRequest.post(
              `http://127.0.0.1:${api.port}/v1/threads/${threadId}/messages`,
            ).pipe(
              HttpClientRequest.bearerToken(authenticationToken),
              HttpClientRequest.bodyJsonUnsafe({
                protocolVersion: 1,
                idempotencyKey,
                message: { content: "Hello through HTTP" },
              }),
            ),
          );
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      );

      expect(response.status).toBe(200);
      expect(await Effect.runPromise(response.json)).toMatchObject({
        protocolVersion: 1,
        idempotencyKey,
        threadId,
        threadPosition: "1",
      });

      const reconciled = await Effect.runPromise(readMessageAuthorityCounts(databaseUrl));
      expect(reconciled).toEqual({ receipts: "1", messages: "1", runs: "1", outbox: "1" });
    } finally {
      await api.stop();
    }
  });
});

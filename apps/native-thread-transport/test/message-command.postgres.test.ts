import { prepareMessageAdmissionFixture, readMessageAuthorityCounts } from "@osfo/db/testing";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { startTransportProcess } from "./transport-process";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "browser-composition-session";

describe("Native Thread Transport composition", () => {
  it("accepts one authenticated browser-compatible HTTP command durably", async () => {
    await Effect.runPromise(
      prepareMessageAdmissionFixture(databaseUrl, {
        principals: [{ principalId, authenticationToken, threadIds: [threadId] }],
      }),
    );

    const transport = await startTransportProcess({
      databaseUrl,
      executionProfileRef: "oz.composition-test.v1",
    });

    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch(
        `http://127.0.0.1:${transport.port}/v1/threads/${threadId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${authenticationToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: 1,
            idempotencyKey,
            message: { content: "Hello through HTTP" },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        protocolVersion: 1,
        idempotencyKey,
        threadId,
        threadPosition: "1",
      });

      const reconciled = await Effect.runPromise(readMessageAuthorityCounts(databaseUrl));
      expect(reconciled).toEqual({ receipts: "1", messages: "1", runs: "1", outbox: "1" });
    } finally {
      await transport.stop();
    }
  });
});

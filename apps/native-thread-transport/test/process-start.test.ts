import { describe, expect, it } from "vitest";
import { startTransportProcess } from "./transport-process";

describe("Native Thread Transport process role", () => {
  it("serves the closed browser command boundary under Node", async () => {
    const transport = await startTransportProcess({
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:1/unavailable",
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${transport.port}/v1/threads/6ef239bd-3f04-4c77-8976-1171e75ea0ab/messages`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer browser-session",
            "content-type": "application/json",
          },
          body: JSON.stringify({ protocolVersion: 2 }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        protocolVersion: 1,
        type: "malformed_request",
        title: "Malformed request",
        retryable: false,
      });
    } finally {
      await transport.stop();
    }
  });
});

import { AgentRunWorker, encodeRunnableDeliveryData } from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { makePubSubPushRoutes } from "../src/push-handler.js";

const delivery = {
  version: 1,
  deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
} as const;

const pushBody = {
  message: {
    data: encodeRunnableDeliveryData(delivery),
    messageId: "pubsub-message-1",
  },
  subscription: "projects/osfo/subscriptions/agent-runs",
};

const request = (body: unknown, authorization = "Bearer push-test-token") =>
  new Request("http://worker.test/v1/pubsub/agent-runs:push", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeHarness = (outcome: "acknowledge" | "retry") => {
  const deliveries: Array<unknown> = [];
  const worker = AgentRunWorker.of({
    handle: (value) =>
      Effect.sync(() => {
        deliveries.push(value);
        return outcome === "acknowledge"
          ? ({ type: "acknowledge", outcome: "succeeded" } as const)
          : ({ type: "retry" } as const);
      }),
  });
  const web = HttpRouter.toWebHandler(
    makePubSubPushRoutes({ authorizationToken: "push-test-token" }).pipe(
      Layer.provide(Layer.succeed(AgentRunWorker)(worker)),
      Layer.provideMerge(HttpServer.layerServices),
    ),
  );
  const context = Context.make(AgentRunWorker, worker);
  return {
    deliveries,
    dispose: web.dispose,
    handler: (input: Request) => web.handler(input, context),
  };
};

describe("authenticated Pub/Sub push contract", () => {
  it("passes only a decoded delivery identity to the worker", async () => {
    const harness = makeHarness("acknowledge");
    try {
      const response = await harness.handler(request(pushBody));

      expect(response.status).toBe(204);
      expect(harness.deliveries).toEqual([delivery]);
    } finally {
      await harness.dispose();
    }
  });

  it("rejects invalid authentication before worker execution", async () => {
    const harness = makeHarness("acknowledge");
    try {
      const response = await harness.handler(request(pushBody, "Bearer wrong-token"));

      expect(response.status).toBe(401);
      expect(harness.deliveries).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("fails malformed delivery data closed", async () => {
    const harness = makeHarness("acknowledge");
    try {
      const response = await harness.handler(
        request({ ...pushBody, message: { ...pushBody.message, data: "not-a-delivery" } }),
      );

      expect(response.status).toBe(400);
      expect(harness.deliveries).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("requests redelivery while another claim remains authoritative", async () => {
    const harness = makeHarness("retry");
    try {
      const response = await harness.handler(request(pushBody));

      expect(response.status).toBe(503);
      expect(harness.deliveries).toEqual([delivery]);
    } finally {
      await harness.dispose();
    }
  });
});

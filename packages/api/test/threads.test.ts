import {
  AcceptanceReceipt,
  IdempotencyConflict,
  MessageAdmission,
  type MessageAdmissionError,
  type SubmitMessageCommand,
} from "../src/index";
import { CommitUnknown, makeApiClient, submitThreadMessage } from "../src/client";
import { OsfoApiLive } from "../src/server";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const idempotencyKey = "51b93c36-6a91-45d2-b25e-aaf249dc5208";

const receipt = new AcceptanceReceipt({
  protocolVersion: 1,
  receiptId: "14414c25-1559-4697-9172-15f170101fc1",
  idempotencyKey,
  threadId,
  userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  threadPosition: "1",
  acceptedAt: "2026-08-06T12:00:00.000Z",
});

const makeHarness = (
  accept: (
    command: SubmitMessageCommand,
  ) => Effect.Effect<AcceptanceReceipt, MessageAdmissionError>,
) => {
  const admission = Layer.succeed(MessageAdmission)(MessageAdmission.of({ accept }));
  const web = HttpRouter.toWebHandler(
    OsfoApiLive.pipe(Layer.provide(admission), Layer.provideMerge(HttpServer.layerServices)),
  );
  // All handler services are provided above, but the conditional helper type retains a required
  // context parameter. The built web handler only needs the Request at this test boundary.
  const handler = web.handler as (request: Request) => Promise<Response>;
  const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpClientRequest.toWeb(request, { signal });
        const webResponse = yield* Effect.promise(() => handler(webRequest));
        return HttpClientResponse.fromWeb(request, webResponse);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.EncodeError({ request, cause }),
            }),
        ),
      ),
    ),
  );
  return {
    httpClientLayer,
    request: handler,
    dispose: web.dispose,
  };
};

describe("Osfo Threads API", () => {
  it("generates a typed client from the same contract used by the server", async () => {
    let observed: unknown;
    const harness = makeHarness((command) => {
      observed = command;
      return Effect.succeed(receipt);
    });

    try {
      const accepted = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeApiClient({
            baseUrl: "http://osfo.test",
            authenticationToken: "session-token",
            httpClientLayer: harness.httpClientLayer,
          });
          return yield* client.threads.submitMessage({
            params: { threadId },
            payload: {
              protocolVersion: 1,
              idempotencyKey,
              message: { content: "Hello, Oz" },
            },
          });
        }),
      );

      expect(accepted).toEqual(receipt);
      expect(observed).toEqual({
        protocolVersion: 1,
        authenticationToken: "session-token",
        threadId,
        idempotencyKey,
        message: { content: "Hello, Oz" },
      });
    } finally {
      await harness.dispose();
    }
  });

  it("rejects malformed commands through Effect Schema before admission", async () => {
    let called = false;
    const harness = makeHarness(() => {
      called = true;
      return Effect.succeed(receipt);
    });

    try {
      const response = await harness.request(
        new Request(`http://osfo.test/v1/threads/${threadId}/messages`, {
          method: "POST",
          headers: {
            authorization: "Bearer session-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: 1,
            idempotencyKey,
            message: { content: "Hello" },
            unexpected: true,
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ _tag: "MalformedRequest" });
      expect(called).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("preserves declared domain failures in the generated client", async () => {
    const harness = makeHarness(() => Effect.fail(new IdempotencyConflict()));

    try {
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            const client = yield* makeApiClient({
              baseUrl: "http://osfo.test",
              authenticationToken: "session-token",
              httpClientLayer: harness.httpClientLayer,
            });
            return yield* client.threads.submitMessage({
              params: { threadId },
              payload: {
                protocolVersion: 1,
                idempotencyKey,
                message: { content: "Changed" },
              },
            });
          }),
        ),
      );

      expect(error).toEqual(new IdempotencyConflict());
    } finally {
      await harness.dispose();
    }
  });

  it("rejects a missing bearer credential before admission", async () => {
    let called = false;
    const harness = makeHarness(() => {
      called = true;
      return Effect.succeed(receipt);
    });

    try {
      const response = await harness.request(
        new Request(`http://osfo.test/v1/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: 1,
            idempotencyKey,
            message: { content: "Hello" },
          }),
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ _tag: "AuthenticationRejected" });
      expect(called).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("classifies a lost or malformed successful response as unknown commit", async () => {
    const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ accepted: true }))),
      ),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        submitThreadMessage({
          baseUrl: "http://osfo.test",
          authenticationToken: "session-token",
          threadId,
          idempotencyKey,
          message: { content: "Hello" },
          httpClientLayer,
        }),
      ),
    );

    expect(error).toEqual(new CommitUnknown());
  });

  it("serves OpenAPI from the same composed contract", async () => {
    const harness = makeHarness(() => Effect.succeed(receipt));
    try {
      const response = await harness.request(new Request("http://osfo.test/openapi.json"));
      const document = (await response.json()) as { readonly paths: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(document.paths).toHaveProperty("/v1/threads/{threadId}/messages");
    } finally {
      await harness.dispose();
    }
  });
});

import {
  AcceptanceReceipt,
  AdmissionCommitUnknown,
  AdmissionUnavailable,
  AgentRunCancellation,
  AgentRunCancellationUnavailable,
  CapacityRejected,
  IdempotencyConflict,
  MessageAdmission,
  SnapshotUnavailable,
  ThreadResume,
  ThreadResumeUnavailable,
  ThreadStreamLifecycle,
  type MessageAdmissionError,
  type MessageAdmissionReconciliationError,
  type SubmitMessageCommand,
} from "../src/index";
import { CommitUnknown, makeApiClient, submitThreadMessage } from "../src/client";
import { OsfoApiLive } from "../src/server";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { makeTestThreadStreamLifecycle } from "./thread-stream-lifecycle-harness.js";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const idempotencyKey = "51b93c36-6a91-45d2-b25e-aaf249dc5208";
const OpenApiDocument = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Unknown),
});

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
  reconcile: (
    command: SubmitMessageCommand,
  ) => Effect.Effect<AcceptanceReceipt, MessageAdmissionReconciliationError> = () =>
    Effect.succeed(receipt),
) => {
  const admission = MessageAdmission.of({
    accept,
    reconcile,
    reconcileCapacity: () => Effect.fail(new AdmissionUnavailable()),
  });
  const cancellation = AgentRunCancellation.of({
    cancel: () => Effect.fail(new AgentRunCancellationUnavailable()),
  });
  const resume = ThreadResume.of({
    snapshot: () => Effect.fail(new SnapshotUnavailable()),
    history: () => Effect.fail(new ThreadResumeUnavailable()),
    stream: () => Effect.fail(new ThreadResumeUnavailable()),
  });
  const testLifecycle = makeTestThreadStreamLifecycle(100);
  const lifecycle = testLifecycle.lifecycle;
  const web = HttpRouter.toWebHandler(
    OsfoApiLive.pipe(
      Layer.provide(Layer.succeed(AgentRunCancellation)(cancellation)),
      Layer.provide(Layer.succeed(MessageAdmission)(admission)),
      Layer.provide(Layer.succeed(ThreadResume)(resume)),
      Layer.provide(Layer.succeed(ThreadStreamLifecycle)(lifecycle)),
      Layer.provideMerge(HttpServer.layerServices),
    ),
  );
  const context = Context.make(AgentRunCancellation, cancellation).pipe(
    Context.add(MessageAdmission, admission),
    Context.add(ThreadResume, resume),
    Context.add(ThreadStreamLifecycle, lifecycle),
  );
  const handler = (request: Request) => web.handler(request, context);
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
    dispose: async () => {
      await web.dispose();
      await testLifecycle.dispose();
    },
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

  it("does not attach the stream retry policy to message admission limits", async () => {
    const harness = makeHarness(() => Effect.fail(new CapacityRejected({ scope: "global" })));

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
            message: { content: "At capacity" },
          }),
        }),
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toEqual({ _tag: "CapacityRejected", scope: "global" });
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
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(called).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("reconciles a lost successful response with one idempotent retry", async () => {
    let requests = 0;
    const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(requests === 1 ? { accepted: true } : receipt),
          ),
        );
      }),
    );
    const reconciled = await Effect.runPromise(
      submitThreadMessage({
        baseUrl: "http://osfo.test",
        authenticationToken: "session-token",
        threadId,
        idempotencyKey,
        message: { content: "Hello" },
        httpClientLayer,
      }),
    );

    expect(reconciled).toEqual(receipt);
    expect(requests).toBe(2);
  });

  it("returns a typed pre-acceptance rejection without retrying", async () => {
    let attempts = 0;
    const harness = makeHarness(() => {
      attempts += 1;
      return attempts === 1 ? Effect.fail(new AdmissionUnavailable()) : Effect.succeed(receipt);
    });

    try {
      const rejected = await Effect.runPromise(
        Effect.flip(
          submitThreadMessage({
            baseUrl: "http://osfo.test",
            authenticationToken: "session-token",
            threadId,
            idempotencyKey,
            message: { content: "Hello" },
            httpClientLayer: harness.httpClientLayer,
          }),
        ),
      );

      expect(rejected).toEqual(new AdmissionUnavailable());
      expect(attempts).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("resolves repeated ambiguous submissions through the durable receipt operation", async () => {
    let requests = 0;
    const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(request.url.endsWith("/reconcile") ? receipt : { accepted: true }),
          ),
        );
      }),
    );
    const reconciled = await Effect.runPromise(
      submitThreadMessage({
        baseUrl: "http://osfo.test",
        authenticationToken: "session-token",
        threadId,
        idempotencyKey,
        message: { content: "Hello" },
        httpClientLayer,
      }),
    );

    expect(reconciled).toEqual(receipt);
    expect(requests).toBe(3);
  });

  it("preserves unknown state when the authenticated receipt lookup also fails", async () => {
    let requests = 0;
    const harness = makeHarness(
      () => {
        requests += 1;
        return Effect.fail(new AdmissionCommitUnknown());
      },
      () => {
        requests += 1;
        return Effect.fail(new AdmissionCommitUnknown());
      },
    );

    try {
      const error = await Effect.runPromise(
        Effect.flip(
          submitThreadMessage({
            baseUrl: "http://osfo.test",
            authenticationToken: "session-token",
            threadId,
            idempotencyKey,
            message: { content: "Hello" },
            httpClientLayer: harness.httpClientLayer,
          }),
        ),
      );

      expect(error).toEqual(new CommitUnknown());
      expect(requests).toBe(3);
    } finally {
      await harness.dispose();
    }
  });

  it("preserves unknown when authentication prevents reconciliation", async () => {
    let requests = 0;
    const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/reconcile")
              ? Response.json({ _tag: "AuthenticationRejected" }, { status: 401 })
              : Response.json({ accepted: true }),
          ),
        );
      }),
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
    expect(requests).toBe(3);
  });

  it("serves OpenAPI from the same composed contract", async () => {
    const harness = makeHarness(() => Effect.succeed(receipt));
    try {
      const response = await harness.request(new Request("http://osfo.test/openapi.json"));
      const document = await Effect.runPromise(
        Schema.decodeUnknownEffect(OpenApiDocument)(await response.json()),
      );

      expect(response.status).toBe(200);
      expect(document.paths).toHaveProperty("/v1/threads/{threadId}/messages");
      expect(document.paths).toHaveProperty("/v1/threads/{threadId}/messages/reconcile");
    } finally {
      await harness.dispose();
    }
  });
});

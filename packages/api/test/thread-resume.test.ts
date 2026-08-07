import {
  AcceptanceReceipt,
  AdmissionUnavailable,
  AgentRunCancellation,
  AgentRunCancellationUnavailable,
  MessageAdmission,
  ThreadNotFound,
  ThreadResume,
  ThreadResumeUnavailable,
  ThreadStreamLifecycle,
  type ThreadResumeService,
  type MessageAdmissionError,
  type SubmitMessageCommand,
} from "../src/index";
import { OsfoApiLive } from "../src/server";
import { getThreadSnapshot, streamThreadEvents } from "../src/client";
import { describe, expect, it } from "@effect/vitest";
import {
  applyThreadEvent,
  makeEmptyThreadSnapshot,
  makeToolCallProgressRecorded,
  makeToolCallRequested,
  makeToolCallResultRecorded,
  makeUserMessageAppended,
  type ThreadEventEnvelope,
} from "@osfo/session";
import { Context, Effect, Layer, Stream } from "effect";
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
const otherThreadId = "81373af4-ace8-47d1-a084-1e83bc3b6077";
const event = Effect.runSync(
  makeUserMessageAppended({
    eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
    threadId,
    threadPosition: "1",
    userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
    agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
    occurredAt: "2026-08-06T12:00:00.000Z",
    content: "Hello, Oz",
  }),
);
const envelope: ThreadEventEnvelope = { ...event, cursor: "cursor-position-1" };
const snapshot = Effect.runSync(
  applyThreadEvent(
    Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" })),
    envelope,
  ),
);

const receipt = new AcceptanceReceipt({
  protocolVersion: 1,
  receiptId: "14414c25-1559-4697-9172-15f170101fc1",
  idempotencyKey: "51b93c36-6a91-45d2-b25e-aaf249dc5208",
  threadId,
  userMessageId: event.payload.userMessageId,
  agentRunId: event.payload.agentRunId,
  threadPosition: "1",
  acceptedAt: event.occurredAt,
});

const makeHarness = (resume: ThreadResumeService) => {
  const admission = MessageAdmission.of({
    accept: (
      _command: SubmitMessageCommand,
    ): Effect.Effect<AcceptanceReceipt, MessageAdmissionError> => Effect.succeed(receipt),
    reconcile: () => Effect.succeed(receipt),
    reconcileCapacity: () => Effect.fail(new AdmissionUnavailable()),
  });
  const testLifecycle = makeTestThreadStreamLifecycle(1);
  const lifecycle = testLifecycle.lifecycle;
  const cancellation = AgentRunCancellation.of({
    cancel: () => Effect.fail(new AgentRunCancellationUnavailable()),
  });
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
    dispose: async () => {
      await web.dispose();
      await testLifecycle.dispose();
    },
    handler,
    httpClientLayer,
  };
};

const resume = ThreadResume.of({
  snapshot: () => Effect.succeed(snapshot),
  history: ({ afterPosition, throughPosition }) =>
    Effect.succeed({
      threadId,
      afterPosition,
      throughPosition: throughPosition ?? "1",
      events: [envelope],
      nextAfterPosition: "1",
      hasMore: false,
    }),
  stream: () =>
    Effect.succeed(
      Stream.make(
        { event: "thread_event" as const, data: envelope },
        {
          event: "caught_up" as const,
          data: { throughPosition: "1", throughCursor: envelope.cursor },
        },
      ),
    ),
});

const authorized = (url: string, accept: string) =>
  new Request(url, {
    headers: { accept, authorization: "Bearer reference-session" },
  });

describe("Thread resume API", () => {
  it("exposes snapshot and event replay through the generated client contract", async () => {
    const harness = makeHarness(resume);
    try {
      const loaded = await Effect.runPromise(
        getThreadSnapshot({
          authenticationToken: "reference-session",
          baseUrl: "http://osfo.test",
          httpClientLayer: harness.httpClientLayer,
          threadId,
        }),
      );
      const stream = await Effect.runPromise(
        streamThreadEvents({
          after: "cursor-origin",
          authenticationToken: "reference-session",
          baseUrl: "http://osfo.test",
          httpClientLayer: harness.httpClientLayer,
          threadId,
        }),
      );

      expect(loaded).toEqual(snapshot);
      expect(Array.from(await Effect.runPromise(Stream.runCollect(stream)))).toEqual([
        { event: "thread_event", data: envelope },
        {
          event: "caught_up",
          data: { throughPosition: "1", throughCursor: envelope.cursor },
        },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("transports the client-safe non-Action ToolCall lifecycle without raw input or result", async () => {
    const presentation = {
      version: 1,
      title: "Search reference documents",
      description: "Find relevant public references for this answer.",
    } as const;
    const toolCallId = "tool_86290831-b9ca-414a-abf1-4055b5347133";
    const toolEvents = [
      envelope,
      {
        ...Effect.runSync(
          makeToolCallRequested({
            eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
            threadId,
            threadPosition: "2",
            occurredAt: event.occurredAt,
            agentRunId: event.payload.agentRunId,
            toolCallId,
            memberIndex: 0,
            presentation,
          }),
        ),
        cursor: "cursor-position-2",
      },
      {
        ...Effect.runSync(
          makeToolCallProgressRecorded({
            eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
            threadId,
            threadPosition: "3",
            occurredAt: event.occurredAt,
            agentRunId: event.payload.agentRunId,
            toolCallId,
            presentation,
            progress: { message: "Searching references" },
          }),
        ),
        cursor: "cursor-position-3",
      },
      {
        ...Effect.runSync(
          makeToolCallResultRecorded({
            eventId: "269787db-071e-4478-806f-1d85d00b7337",
            threadId,
            threadPosition: "4",
            occurredAt: event.occurredAt,
            agentRunId: event.payload.agentRunId,
            toolCallId,
            presentation,
            outcome: { type: "succeeded" },
          }),
        ),
        cursor: "cursor-position-4",
      },
    ] satisfies ReadonlyArray<ThreadEventEnvelope>;
    const toolSnapshot = toolEvents.reduce(
      (state, current) => Effect.runSync(applyThreadEvent(state, current)),
      Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" })),
    );
    const toolResume = ThreadResume.of({
      snapshot: () => Effect.succeed(toolSnapshot),
      history: ({ afterPosition, throughPosition }) =>
        Effect.succeed({
          threadId,
          afterPosition,
          throughPosition: throughPosition ?? "4",
          events: toolEvents,
          nextAfterPosition: "4",
          hasMore: false,
        }),
      stream: () =>
        Effect.succeed(
          Stream.fromIterable(
            toolEvents.map((data) => ({ event: "thread_event" as const, data })),
          ).pipe(
            Stream.concat(
              Stream.make({
                event: "caught_up" as const,
                data: { throughPosition: "4", throughCursor: "cursor-position-4" },
              }),
            ),
          ),
        ),
    });
    const harness = makeHarness(toolResume);
    try {
      const stream = await Effect.runPromise(
        streamThreadEvents({
          after: "cursor-origin",
          authenticationToken: "reference-session",
          baseUrl: "http://osfo.test",
          httpClientLayer: harness.httpClientLayer,
          threadId,
        }),
      );
      const transported = Array.from(await Effect.runPromise(Stream.runCollect(stream)));

      expect(transported.slice(0, -1)).toEqual(
        toolEvents.map((data) => ({ event: "thread_event", data })),
      );
      expect(JSON.stringify(transported)).not.toContain('"input"');
      expect(JSON.stringify(transported)).not.toContain('"result"');
      expect(JSON.stringify(transported)).not.toContain("private raw argument");
      expect(JSON.stringify(transported)).not.toContain("private raw result");
    } finally {
      await harness.dispose();
    }
  });

  it("bootstraps from a complete authenticated snapshot", async () => {
    const harness = makeHarness(resume);
    try {
      const response = await harness.handler(
        authorized(`http://osfo.test/v1/threads/${threadId}/snapshot`, "application/json"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(snapshot);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      await harness.dispose();
    }
  });

  it("traverses one frozen canonical history head", async () => {
    const harness = makeHarness(resume);
    try {
      const response = await harness.handler(
        authorized(
          `http://osfo.test/v1/threads/${threadId}/events?afterPosition=0&limit=100`,
          "application/json",
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        threadId,
        afterPosition: "0",
        throughPosition: "1",
        events: [envelope],
        nextAfterPosition: "1",
        hasMore: false,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("replays canonical events before entering live delivery", async () => {
    const harness = makeHarness(resume);
    try {
      const response = await harness.handler(
        authorized(
          `http://osfo.test/v1/threads/${threadId}/events?after=cursor-origin`,
          "text/event-stream",
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const frames = (await response.text()).trim().split("\n\n");
      expect(frames.map((frame) => frame.split("\n")[0])).toEqual([
        "event: thread_event",
        "event: caught_up",
      ]);
      expect(JSON.parse(frames[0]!.split("\n")[1]!.slice("data: ".length))).toEqual(envelope);
      expect(JSON.parse(frames[1]!.split("\n")[1]!.slice("data: ".length))).toEqual({
        throughPosition: "1",
        throughCursor: envelope.cursor,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("encodes reserved SSE failures and decodes them through the generated client", async () => {
    const unavailableResume = ThreadResume.of({
      ...resume,
      stream: () =>
        Effect.succeed(
          Stream.make({
            event: "caught_up" as const,
            data: { throughPosition: "1", throughCursor: envelope.cursor },
          }).pipe(Stream.concat(Stream.fail(new ThreadResumeUnavailable()))),
        ),
    });
    const harness = makeHarness(unavailableResume);
    try {
      const response = await harness.handler(
        authorized(
          `http://osfo.test/v1/threads/${threadId}/events?after=cursor-origin`,
          "text/event-stream",
        ),
      );
      expect(await response.text()).toContain("event: effect/httpapi/stream/failure");

      const stream = await Effect.runPromise(
        streamThreadEvents({
          after: "cursor-origin",
          authenticationToken: "reference-session",
          baseUrl: "http://osfo.test",
          httpClientLayer: harness.httpClientLayer,
          threadId,
        }),
      );
      const failure = await Effect.runPromise(Stream.runDrain(stream).pipe(Effect.flip));
      expect(failure).toEqual(new ThreadResumeUnavailable());
    } finally {
      await harness.dispose();
    }
  });

  it("keeps resource non-disclosure ahead of typed connection-limit rejection", async () => {
    const heldResume = ThreadResume.of({
      ...resume,
      stream: ({ threadId: requestedThreadId }) =>
        requestedThreadId === threadId
          ? Effect.succeed(
              Stream.make({
                event: "caught_up" as const,
                data: { throughPosition: "1", throughCursor: envelope.cursor },
              }).pipe(Stream.concat(Stream.never)),
            )
          : Effect.fail(new ThreadNotFound()),
    });
    const harness = makeHarness(heldResume);
    try {
      const first = await harness.handler(
        authorized(
          `http://osfo.test/v1/threads/${threadId}/events?after=cursor-origin`,
          "text/event-stream",
        ),
      );
      expect(first.status).toBe(200);
      const reader = first.body!.getReader();
      await reader.read();

      const hidden = await harness.handler(
        authorized(
          `http://osfo.test/v1/threads/${otherThreadId}/events?after=cursor-origin`,
          "text/event-stream",
        ),
      );
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ _tag: "ThreadNotFound" });

      const limited = await harness.handler(
        authorized(
          `http://osfo.test/v1/threads/${threadId}/events?after=cursor-origin`,
          "text/event-stream",
        ),
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("5");
      expect(await limited.json()).toEqual({
        _tag: "ConnectionLimitExceeded",
        retryAfterSeconds: 5,
      });

      await reader.cancel();
    } finally {
      await harness.dispose();
    }
  });
});

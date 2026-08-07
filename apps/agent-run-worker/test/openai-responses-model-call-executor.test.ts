import {
  modelCallObservationTextMaxLength,
  ModelCallExecutor,
  type ModelCallAttempt,
} from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { liveOpenAIExecutionProfile } from "../src/execution-profile.js";
import { makeOpenAIResponsesModelCallExecutorLayer } from "../src/openai-responses-model-call-executor.js";

const attempt = {
  assistantOutputId: "fe147f93-9553-4f56-bab2-7505533d4ad1",
  attemptNumber: 1,
  modelBinding: liveOpenAIExecutionProfile.modelBinding,
  modelCallAttemptId: "dd0496f6-c20f-4c86-bc69-e3138b699f06",
  modelCallId: "0f60df64-c87c-4878-8340-001f23623491",
  prompt: "Say hello",
  usage: { type: "unknown" },
} as const satisfies ModelCallAttempt;

const execute = (executor: ModelCallExecutor["Service"]) =>
  Stream.unwrap(executor.execute(attempt));

const layer = makeOpenAIResponsesModelCallExecutorLayer({
  apiKey: "test-api-key",
  profile: liveOpenAIExecutionProfile,
});

const successfulTextSse = (text: string, suffix: string) => {
  const responseId = `resp_${suffix}`;
  const messageId = `msg_${suffix}`;
  const events = [
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: messageId, type: "message", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        model: "gpt-4.1-mini-2025-04-14",
        store: false,
        output: [
          {
            id: messageId,
            type: "message",
            content: [{ type: "output_text", text }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n`).join("\n");
};

describe("OpenAI Responses ModelCall executor", () => {
  it.effect("sends the pinned non-stored streaming request and normalizes text and usage", () =>
    Effect.gen(function* () {
      let observedRequest: HttpClientRequest.HttpClientRequest | undefined;
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_123"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_123","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_123","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_123","output_index":0,"content_index":0,"delta":" world","sequence_number":4}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_123","output_index":0,"content_index":0,"text":"Hello world","sequence_number":5}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_123","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello world","annotations":[]},"sequence_number":6}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_123","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}]},"sequence_number":7}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"output":[{"id":"msg_123","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}],"usage":{"input_tokens":4,"output_tokens":2}}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) => {
        observedRequest = request;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        );
      });

      const [observations, outcome] = yield* ModelCallExecutor.use((executor) =>
        Effect.gen(function* () {
          const output = yield* Stream.runCollect(execute(executor));
          const completed = yield* executor.outcome(attempt);
          return [output, completed] as const;
        }),
      ).pipe(Effect.provide(layer), Effect.provideService(HttpClient.HttpClient, http));

      expect(Array.from(observations)).toEqual([{ fragmentIndex: 0, text: "Hello world" }]);
      expect(outcome).toEqual({
        dispatchEvidence: { type: "confirmed", providerRequestId: "resp_123" },
        usage: { type: "reported", inputUnits: 4, outputUnits: 2 },
      });
      expect(observedRequest?.url).toBe("https://api.openai.com/v1/responses");
      expect(observedRequest?.headers.authorization).toBe("Bearer test-api-key");
      expect(observedRequest?.headers.accept).toBe("text/event-stream");
      const webRequest = yield* HttpClientRequest.toWeb(observedRequest!);
      const requestBody = yield* Effect.promise(() => webRequest.json());
      expect(requestBody).toEqual({
        input: "Say hello",
        max_output_tokens: 1_024,
        model: "gpt-4.1-mini-2025-04-14",
        store: false,
        stream: true,
      });
    }),
  );

  it.effect("keeps one observation at the durable text boundary", () =>
    Effect.gen(function* () {
      const text = "a".repeat(modelCallObservationTextMaxLength);
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(successfulTextSse(text, "boundary"), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const observations = yield* ModelCallExecutor.use((executor) =>
        Stream.runCollect(execute(executor)),
      ).pipe(Effect.provide(layer), Effect.provideService(HttpClient.HttpClient, http));

      expect(Array.from(observations)).toEqual([{ fragmentIndex: 0, text }]);
    }),
  );

  it.effect("splits one oversized provider delta at the durable text boundary", () =>
    Effect.gen(function* () {
      const text = "b".repeat(modelCallObservationTextMaxLength + 1);
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(successfulTextSse(text, "oversized"), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const observations = yield* ModelCallExecutor.use((executor) =>
        Stream.runCollect(execute(executor)),
      ).pipe(Effect.provide(layer), Effect.provideService(HttpClient.HttpClient, http));

      expect(Array.from(observations)).toEqual([
        { fragmentIndex: 0, text: text.slice(0, modelCallObservationTextMaxLength) },
        { fragmentIndex: 1, text: text.slice(modelCallObservationTextMaxLength) },
      ]);
    }),
  );

  it.effect("does not split an astral character at the durable text boundary", () =>
    Effect.gen(function* () {
      const prefix = "c".repeat(modelCallObservationTextMaxLength - 1);
      const text = `${prefix}😀`;
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(successfulTextSse(text, "astral"), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const observations = yield* ModelCallExecutor.use((executor) =>
        Stream.runCollect(execute(executor)),
      ).pipe(Effect.provide(layer), Effect.provideService(HttpClient.HttpClient, http));

      expect(Array.from(observations)).toEqual([
        { fragmentIndex: 0, text: prefix },
        { fragmentIndex: 1, text: "😀" },
      ]);
    }),
  );

  it.effect("rejects a duplicate created event with the same provider identity", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_duplicate"}}',
        "",
        'data: {"type":"response.created","response":{"id":"resp_duplicate"}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted duplicate response.created",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_duplicate" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects a duplicate created event with a changed provider identity", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_original"}}',
        "",
        'data: {"type":"response.created","response":{"id":"resp_replacement"}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted duplicate response.created",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_original" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects output before the provider identity is established", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_early","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted response.output_item.added before response.created",
              dispatchEvidence: { type: "confirmed" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects every event after response.completed", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_terminal_event"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_terminal_event","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_terminal_event","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_terminal_event","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_terminal_event","output_index":0,"content_index":0,"text":"Hello","sequence_number":4}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_terminal_event","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello","annotations":[]},"sequence_number":5}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_terminal_event","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]} ,"sequence_number":6}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_terminal_event","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"output":[{"id":"msg_terminal_event","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]}],"usage":{"input_tokens":4,"output_tokens":1}}}',
        "",
        'data: {"type":"response.in_progress"}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted response.in_progress after response.completed",
              dispatchEvidence: {
                type: "confirmed",
                providerRequestId: "resp_terminal_event",
              },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects finalized text that does not match the streamed deltas", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_mismatch"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_mismatch","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_mismatch","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_mismatch","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_mismatch","output_index":0,"content_index":0,"text":"Hello!","sequence_number":4}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider finalized text that differs from streamed output",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_mismatch" },
              usage: { type: "unknown" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects multiple text output items", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_multiple"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_first","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_second","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":2}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted multiple text output items",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_multiple" },
              usage: { type: "unknown" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects a text delta whose output identity changed", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_identity"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_identity","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_identity","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_other","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted text delta for an unknown or finalized content part",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_identity" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects multiple text content parts", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_parts"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_parts","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_parts","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_parts","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":3}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted multiple text content parts",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_parts" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects duplicate content-part finalization", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_part_done"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_part_done","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_part_done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_part_done","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_part_done","output_index":0,"content_index":0,"text":"Hello","sequence_number":4}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_part_done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello","annotations":[]},"sequence_number":5}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_part_done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello","annotations":[]},"sequence_number":6}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider finalized content part twice",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_part_done" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects duplicate output-item finalization", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_item_done"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_item_done","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_item_done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_item_done","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_item_done","output_index":0,"content_index":0,"text":"Hello","sequence_number":4}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_item_done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello","annotations":[]},"sequence_number":5}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_item_done","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]} ,"sequence_number":6}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_item_done","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]} ,"sequence_number":7}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider finalized output item twice",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_item_done" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects a text lifecycle that starts at nonzero indexes", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_index"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_index","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_index","output_index":1,"content_index":1,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_index","output_index":1,"content_index":1,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_index","output_index":1,"content_index":1,"text":"Hello","sequence_number":4}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_index","output_index":1,"content_index":1,"part":{"type":"output_text","text":"Hello","annotations":[]},"sequence_number":5}',
        "",
        'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_index","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]} ,"sequence_number":6}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_index","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"output":[{"id":"msg_index","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]}],"usage":{"input_tokens":4,"output_tokens":1}}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects terminal output that differs from the streamed message", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_terminal"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_terminal","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":1}',
        "",
        'data: {"type":"response.content_part.added","item_id":"msg_terminal","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]},"sequence_number":2}',
        "",
        'data: {"type":"response.output_text.delta","item_id":"msg_terminal","output_index":0,"content_index":0,"delta":"Hello","sequence_number":3}',
        "",
        'data: {"type":"response.output_text.done","item_id":"msg_terminal","output_index":0,"content_index":0,"text":"Hello","sequence_number":4}',
        "",
        'data: {"type":"response.content_part.done","item_id":"msg_terminal","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello","annotations":[]},"sequence_number":5}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_terminal","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]} ,"sequence_number":6}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_terminal","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"output":[{"id":"msg_terminal","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Goodbye","annotations":[]}]}],"usage":{"input_tokens":4,"output_tokens":1}}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider completed with inconsistent output",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_terminal" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects a completed response without streamed text output", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_empty"}}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_empty","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"output":[],"usage":{"input_tokens":4,"output_tokens":0}}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider completed without text output",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_empty" },
              usage: { type: "unknown" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("rejects non-text-only output item events", () =>
    Effect.gen(function* () {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_tool"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_123","type":"function_call","status":"in_progress","call_id":"call_123","name":"lookup","arguments":""},"sequence_number":1}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_123","type":"function_call","status":"completed","call_id":"call_123","name":"lookup","arguments":"{}"},"sequence_number":2}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"usage":{"input_tokens":4,"output_tokens":2}}}',
        "",
      ].join("\n");
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      );
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              cause: "Provider emitted unsupported output item function_call",
              dispatchEvidence: { type: "confirmed", providerRequestId: "resp_tool" },
              usage: { type: "unknown" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("makes one request and reports confirmed dispatch on an HTTP failure", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const http = HttpClient.make((request) => {
        requestCount += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
        );
      });
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(requestCount).toBe(1);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              dispatchEvidence: { type: "confirmed" },
              usage: { type: "unknown" },
            }),
          }),
        );
      }
    }),
  );

  it.effect("makes one request and reports uncertain dispatch on a transport failure", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const http = HttpClient.make((request) => {
        requestCount += 1;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: "connection reset before response headers",
            }),
          }),
        );
      });
      const result = yield* ModelCallExecutor.use((executor) =>
        Stream.runDrain(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
      );

      expect(requestCount).toBe(1);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ModelCallExecutionError",
              dispatchEvidence: { type: "uncertain" },
              usage: { type: "unknown" },
            }),
          }),
        );
      }
    }),
  );
});

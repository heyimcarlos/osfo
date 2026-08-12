import {
  modelCallObservationTextMaxLength,
  ModelCallExecutor,
  type ModelCallAttempt,
} from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { liveOpenRouterExecutionProfile } from "../src/execution-profile.js";
import { makeOpenRouterChatCompletionsModelCallExecutorLayer } from "../src/openrouter-chat-completions-model-call-executor.js";

const attempt = {
  assistantOutputId: "fe147f93-9553-4f56-bab2-7505533d4ad1",
  attemptNumber: 1,
  modelBinding: liveOpenRouterExecutionProfile.modelBinding,
  modelCallAttemptId: "dd0496f6-c20f-4c86-bc69-e3138b699f06",
  modelCallId: "0f60df64-c87c-4878-8340-001f23623491",
  prompt: "Say hello",
  usage: { type: "unknown" },
} as const satisfies ModelCallAttempt;

const execute = (executor: ModelCallExecutor["Service"]) =>
  Stream.unwrap(executor.execute(attempt));

const layer = makeOpenRouterChatCompletionsModelCallExecutorLayer({
  apiKey: "test-api-key",
  profile: liveOpenRouterExecutionProfile,
});

const chunk = (choices: ReadonlyArray<Schema.Json>, overrides: Schema.JsonObject = {}) => ({
  id: "gen-123",
  model: "minimax/minimax-m3",
  object: "chat.completion.chunk",
  provider: "Minimax",
  choices,
  ...overrides,
});

const terminalUsage = {
  prompt_tokens: 4,
  completion_tokens: 5,
  total_tokens: 9,
  completion_tokens_details: { reasoning_tokens: 7 },
};

const isString = Schema.is(Schema.String);

const sse = (...events: ReadonlyArray<Schema.Json>) =>
  events.map((event) => (isString(event) ? event : `data: ${JSON.stringify(event)}\n`)).join("\n");

const successfulTextSse = (text: string) =>
  sse(
    chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
    "data: [DONE]\n",
  );

const httpWithBody = (body: string) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  );

const runExit = (body: string) =>
  ModelCallExecutor.use((executor) => Stream.runDrain(execute(executor))).pipe(
    Effect.provide(layer),
    Effect.provideService(HttpClient.HttpClient, httpWithBody(body)),
    Effect.exit,
  );

const failureReasons = <A, E>(result: Exit.Exit<A, E>) =>
  Exit.isFailure(result) ? result.cause.reasons : [];

describe("OpenRouter Chat Completions ModelCall executor", () => {
  it.effect("sends the pinned request and normalizes text, identity, and usage", () =>
    Effect.gen(function* () {
      let observedRequest: HttpClientRequest.HttpClientRequest | undefined;
      const body = sse(
        ": OPENROUTER PROCESSING\n",
        "data: : OPENROUTER PROCESSING\n",
        chunk([{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }]),
        chunk([{ index: 0, delta: { content: " world" }, finish_reason: null }]),
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
        "data: [DONE]\n",
      );
      const http = HttpClient.make((request) => {
        observedRequest = request;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, {
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
        dispatchEvidence: { type: "confirmed", providerRequestId: "gen-123" },
        usage: {
          type: "reported",
          inputUnits: 4,
          outputUnits: 5,
          reasoningUnits: 7,
        },
      });
      expect(observedRequest?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(observedRequest?.headers.authorization).toBe("Bearer test-api-key");
      expect(observedRequest?.headers.accept).toBe("text/event-stream");
      const webRequest = yield* HttpClientRequest.toWeb(observedRequest!);
      const requestBody = yield* Effect.promise(() => webRequest.json());
      expect(requestBody).toEqual({
        messages: [{ role: "user", content: "Say hello" }],
        model: "minimax/minimax-m3",
        stream: true,
        max_tokens: 1_024,
        temperature: 0,
        reasoning: { enabled: true, exclude: true },
        provider: {
          only: ["minimax"],
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: "deny",
        },
      });
    }),
  );

  it.effect("keeps one observation at the durable text boundary", () =>
    Effect.gen(function* () {
      const text = "a".repeat(modelCallObservationTextMaxLength);
      const observations = yield* ModelCallExecutor.use((executor) =>
        Stream.runCollect(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, httpWithBody(successfulTextSse(text))),
      );

      expect(Array.from(observations)).toEqual([{ fragmentIndex: 0, text }]);
    }),
  );

  it.effect("splits one oversized provider delta at the durable text boundary", () =>
    Effect.gen(function* () {
      const text = "b".repeat(modelCallObservationTextMaxLength + 1);
      const observations = yield* ModelCallExecutor.use((executor) =>
        Stream.runCollect(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, httpWithBody(successfulTextSse(text))),
      );

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
      const observations = yield* ModelCallExecutor.use((executor) =>
        Stream.runCollect(execute(executor)),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, httpWithBody(successfulTextSse(text))),
      );

      expect(Array.from(observations)).toEqual([
        { fragmentIndex: 0, text: prefix },
        { fragmentIndex: 1, text: "😀" },
      ]);
    }),
  );

  it.effect("rejects a changed generation identity", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
            id: "gen-replacement",
            usage: terminalUsage,
          }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(failureReasons(result)).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ModelCallExecutionError",
            cause: "Provider generation identity changed",
            dispatchEvidence: { type: "confirmed", providerRequestId: "gen-123" },
          }),
        }),
      );
    }),
  );

  it.effect("rejects a changed model or provider", () =>
    Effect.gen(function* () {
      const wrongModel = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([], { model: "another/model" }),
        ),
      );
      const wrongProvider = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([], { provider: "Fallback" }),
        ),
      );

      expect(Exit.isFailure(wrongModel)).toBe(true);
      expect(Exit.isFailure(wrongProvider)).toBe(true);
    }),
  );

  it.effect("rejects terminal success without text output", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects tool calls alongside text output", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([
            {
              index: 0,
              delta: {
                content: "I will call a tool",
                tool_calls: [{ index: 0, id: "call-1", type: "function" }],
              },
              finish_reason: null,
            },
          ]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects a tool-only completion", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call-1", type: "function" }],
              },
              finish_reason: "tool_calls",
            },
          ]),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects nonempty excluded reasoning output", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([
            {
              index: 0,
              delta: { content: "Hello", reasoning: "hidden chain of thought" },
              finish_reason: null,
            },
          ]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects an unknown output key alongside valid text", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([
            {
              index: 0,
              delta: { content: "Hello", future_output: { value: "unsupported" } },
              finish_reason: null,
            },
          ]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects an unsupported terminal finish reason", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: "length" }], { usage: terminalUsage }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("accepts a separate final usage chunk", () =>
    Effect.gen(function* () {
      const body = sse(
        chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
        chunk([], { usage: terminalUsage }),
        "data: [DONE]\n",
      );
      const [observations, outcome] = yield* ModelCallExecutor.use((executor) =>
        Effect.gen(function* () {
          const output = yield* Stream.runCollect(execute(executor));
          return [output, yield* executor.outcome(attempt)] as const;
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, httpWithBody(body)),
      );

      expect(Array.from(observations)).toEqual([{ fragmentIndex: 0, text: "Hello" }]);
      expect(outcome.usage).toEqual({
        type: "reported",
        inputUnits: 4,
        outputUnits: 5,
        reasoningUnits: 7,
      });
    }),
  );

  it.effect("accepts OpenRouter's repeated terminal choice on the usage chunk", () =>
    Effect.gen(function* () {
      const body = sse(
        chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
        chunk([
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: "stop",
          },
        ]),
        chunk(
          [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          { usage: terminalUsage },
        ),
        "data: [DONE]\n",
      );
      const [observations, outcome] = yield* ModelCallExecutor.use((executor) =>
        Effect.gen(function* () {
          const output = yield* Stream.runCollect(execute(executor));
          return [output, yield* executor.outcome(attempt)] as const;
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.HttpClient, httpWithBody(body)),
      );

      expect(Array.from(observations)).toEqual([{ fragmentIndex: 0, text: "Hello" }]);
      expect(outcome.usage).toEqual({
        type: "reported",
        inputUnits: 4,
        outputUnits: 5,
        reasoningUnits: 7,
      });
    }),
  );

  it.effect("rejects nonempty output on a repeated terminal usage chunk", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
          chunk(
            [
              {
                index: 0,
                delta: { role: "assistant", content: "unexpected" },
                finish_reason: "stop",
              },
            ],
            { usage: terminalUsage },
          ),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects missing final usage", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects final usage without reasoning-token evidence", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
            usage: {
              prompt_tokens: 4,
              completion_tokens: 2,
              total_tokens: 6,
              completion_tokens_details: null,
            },
          }),
          "data: [DONE]\n",
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects a stream that ends without the terminal envelope", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(
          chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: terminalUsage }),
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(failureReasons(result)).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ModelCallExecutionError",
            dispatchEvidence: { type: "confirmed", providerRequestId: "gen-123" },
            usage: {
              type: "reported",
              inputUnits: 4,
              outputUnits: 5,
              reasoningUnits: 7,
            },
          }),
        }),
      );
    }),
  );

  it.effect("rejects every event after the terminal envelope", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        `${successfulTextSse("Hello")}\ndata: ${JSON.stringify(chunk([]))}\n`,
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects a top-level provider stream error", () =>
    Effect.gen(function* () {
      const result = yield* runExit(
        sse(chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]), {
          error: { code: 502, message: "provider unavailable" },
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(failureReasons(result)).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ModelCallExecutionError",
            cause: "Provider emitted a stream error",
            dispatchEvidence: { type: "confirmed", providerRequestId: "gen-123" },
          }),
        }),
      );
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
      expect(failureReasons(result)).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ModelCallExecutionError",
            dispatchEvidence: { type: "confirmed" },
            usage: { type: "unknown" },
          }),
        }),
      );
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
      expect(failureReasons(result)).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ModelCallExecutionError",
            dispatchEvidence: { type: "uncertain" },
            usage: { type: "unknown" },
          }),
        }),
      );
    }),
  );
});

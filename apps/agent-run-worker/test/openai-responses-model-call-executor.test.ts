import { ModelCallExecutor, type ModelCallAttempt } from "@osfo/agent-run";
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

describe("OpenAI Responses ModelCall executor", () => {
  it.effect("sends the pinned non-stored streaming request and normalizes text and usage", () =>
    Effect.gen(function* () {
      let observedRequest: HttpClientRequest.HttpClientRequest | undefined;
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp_123"}}',
        "",
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        "",
        'data: {"type":"response.output_text.delta","delta":" world"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","model":"gpt-4.1-mini-2025-04-14","store":false,"usage":{"input_tokens":4,"output_tokens":2}}}',
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

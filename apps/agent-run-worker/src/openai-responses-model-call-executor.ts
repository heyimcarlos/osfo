import {
  ModelCallExecutionError,
  ModelCallExecutor,
  type ModelCallAttempt,
  type ModelCallAttemptOutcome,
  type ModelCallDispatchEvidence,
  type ModelCallObservation,
} from "@osfo/agent-run";
import { Deferred, Effect, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { type liveOpenAIExecutionProfile } from "./execution-profile.js";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

const CreatedEventSchema = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Schema.Struct({ id: NonEmptyText }),
});

const OutputTextDeltaEventSchema = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  delta: Schema.String,
});

const CompletedEventSchema = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.Struct({
    id: NonEmptyText,
    status: Schema.Literal("completed"),
    model: NonEmptyText,
    store: Schema.Literal(false),
    usage: Schema.Struct({
      input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
});

const ProviderFailureEventSchema = Schema.Struct({
  type: Schema.Literals(["error", "response.failed", "response.incomplete"]),
});

const IgnoredEventSchema = Schema.Struct({
  type: Schema.Literals([
    "response.queued",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.done",
    "response.content_part.added",
    "response.content_part.done",
    "response.output_text.done",
  ]),
});

const ResponsesEventSchema = Schema.Union([
  CreatedEventSchema,
  OutputTextDeltaEventSchema,
  CompletedEventSchema,
  ProviderFailureEventSchema,
  IgnoredEventSchema,
]);

const ResponsesEventFromJson = Schema.fromJsonString(ResponsesEventSchema);
type ResponsesEvent = typeof ResponsesEventSchema.Type;

interface OpenAIResponsesSession {
  readonly attempt: ModelCallAttempt;
  readonly cancellation: Deferred.Deferred<never, ModelCallExecutionError>;
  readonly outcome: Deferred.Deferred<ModelCallAttemptOutcome, ModelCallExecutionError>;
  dispatchEvidence: ModelCallDispatchEvidence;
}

export interface OpenAIResponsesModelCallExecutorConfig {
  readonly apiKey: string;
  readonly profile: typeof liveOpenAIExecutionProfile;
}

const responsesUrl = "https://api.openai.com/v1/responses";

const executorLayer = (config: OpenAIResponsesModelCallExecutorConfig) =>
  Layer.effect(
    ModelCallExecutor,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const sessions = new Map<string, OpenAIResponsesSession>();

      const executionError = (
        session: OpenAIResponsesSession,
        cause: unknown,
      ): ModelCallExecutionError =>
        new ModelCallExecutionError({
          cause,
          dispatchEvidence: session.dispatchEvidence,
          usage: { type: "unknown" },
        });

      const decodeEvent = (session: OpenAIResponsesSession, data: string) =>
        Schema.decodeUnknownEffect(ResponsesEventFromJson)(data).pipe(
          Effect.mapError((cause) => executionError(session, cause)),
        );

      const makeOutputStream = (session: OpenAIResponsesSession) => {
        let completed = false;
        let fragmentIndex = 0;
        let pendingDeltas: Array<string> = [];
        let providerRequestId: string | undefined;

        const flush = (): ReadonlyArray<ModelCallObservation> => {
          if (pendingDeltas.length === 0) return [];
          const observation = {
            fragmentIndex,
            text: pendingDeltas.join(""),
          } satisfies ModelCallObservation;
          fragmentIndex += 1;
          pendingDeltas = [];
          return [observation];
        };

        const handleEvent = (event: ResponsesEvent) =>
          Effect.gen(function* () {
            switch (event.type) {
              case "response.created":
                providerRequestId = event.response.id;
                session.dispatchEvidence = {
                  type: "confirmed",
                  providerRequestId,
                };
                return [];
              case "response.output_text.delta":
                if (completed) {
                  return yield* executionError(session, "Output arrived after response.completed");
                }
                if (event.delta.length === 0) return [];
                pendingDeltas.push(event.delta);
                return pendingDeltas.length >=
                  config.profile.permittedAdaptations.coalesceUpToDeltas
                  ? flush()
                  : [];
              case "response.completed": {
                if (completed) {
                  return yield* executionError(session, "Duplicate response.completed event");
                }
                if (event.response.model !== config.profile.model) {
                  return yield* executionError(session, "Provider completed with another model");
                }
                if (providerRequestId !== undefined && providerRequestId !== event.response.id) {
                  return yield* executionError(session, "Provider response identity changed");
                }
                completed = true;
                providerRequestId = event.response.id;
                session.dispatchEvidence = {
                  type: "confirmed",
                  providerRequestId,
                };
                const outcome = {
                  dispatchEvidence: session.dispatchEvidence,
                  usage: {
                    type: "reported" as const,
                    inputUnits: event.response.usage.input_tokens,
                    outputUnits: event.response.usage.output_tokens,
                  },
                } satisfies ModelCallAttemptOutcome;
                yield* Deferred.succeed(session.outcome, outcome);
                return flush();
              }
              case "error":
              case "response.failed":
              case "response.incomplete":
                return yield* executionError(session, `Provider emitted ${event.type}`);
              default:
                return [];
            }
          });

        const request = HttpClientRequest.post(responsesUrl).pipe(
          HttpClientRequest.bearerToken(config.apiKey),
          HttpClientRequest.setHeader("accept", "text/event-stream"),
          HttpClientRequest.bodyJson({
            input: session.attempt.prompt,
            max_output_tokens: config.profile.request.maxOutputTokens,
            model: config.profile.model,
            store: config.profile.request.store,
            stream: config.profile.request.stream,
          }),
          Effect.mapError((cause) => executionError(session, cause)),
        );

        const response = request.pipe(
          Effect.flatMap((prepared) => {
            session.dispatchEvidence = { type: "uncertain" };
            return http.execute(prepared).pipe(
              Effect.timeoutOrElse({
                duration: config.profile.deadlines.responseHeadersMs,
                orElse: () =>
                  Effect.fail(executionError(session, "Response headers deadline exceeded")),
              }),
              Effect.mapError((cause) =>
                cause instanceof ModelCallExecutionError ? cause : executionError(session, cause),
              ),
            );
          }),
          Effect.flatMap((received) => {
            session.dispatchEvidence = { type: "confirmed" };
            return received.status >= 200 && received.status < 300
              ? Effect.succeed(received)
              : Effect.fail(executionError(session, `Provider returned HTTP ${received.status}`));
          }),
        );

        const body = HttpClientResponse.stream(response).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.startsWith("data:")),
          Stream.map((line) => line.slice("data:".length).trimStart()),
          Stream.filter((data) => data.length > 0 && data !== "[DONE]"),
          Stream.mapEffect((data) => decodeEvent(session, data)),
          Stream.mapEffect(handleEvent),
          Stream.flatMap(Stream.fromIterable),
          Stream.interruptWhen(
            Effect.sleep(config.profile.deadlines.responseStreamMs).pipe(
              Effect.andThen(
                Effect.fail(executionError(session, "Response stream deadline exceeded")),
              ),
            ),
          ),
          Stream.interruptWhen(Deferred.await(session.cancellation)),
          Stream.mapError((cause) =>
            cause instanceof ModelCallExecutionError ? cause : executionError(session, cause),
          ),
        );

        const requireCompletion = Stream.fromEffectDrain(
          Effect.suspend(() =>
            completed
              ? Effect.void
              : Effect.fail(
                  executionError(session, "Response stream ended without response.completed"),
                ),
          ),
        );

        return body.pipe(Stream.concat(requireCompletion));
      };

      const execute: ModelCallExecutor["Service"]["execute"] = Effect.fn(
        "OpenAIResponsesModelCallExecutor.execute",
      )(function* (attempt) {
        if (attempt.attemptNumber !== 1 || attempt.modelBinding !== config.profile.modelBinding) {
          return yield* new ModelCallExecutionError({
            cause: "ModelCallAttempt does not match the immutable live profile",
            dispatchEvidence: { type: "notDispatched" },
            usage: { type: "unknown" },
          });
        }
        if (sessions.has(attempt.modelCallAttemptId)) {
          return yield* new ModelCallExecutionError({
            cause: "ModelCallAttempt is already executing",
            dispatchEvidence: { type: "notDispatched" },
            usage: { type: "unknown" },
          });
        }
        const cancellation = yield* Deferred.make<never, ModelCallExecutionError>();
        const outcome = yield* Deferred.make<ModelCallAttemptOutcome, ModelCallExecutionError>();
        const session: OpenAIResponsesSession = {
          attempt,
          cancellation,
          outcome,
          dispatchEvidence: { type: "notDispatched" },
        };
        sessions.set(attempt.modelCallAttemptId, session);
        return makeOutputStream(session);
      });

      const stop = (attempt: ModelCallAttempt) =>
        Effect.suspend(() => {
          const session = sessions.get(attempt.modelCallAttemptId);
          if (session === undefined) return Effect.void;
          return Deferred.fail(
            session.cancellation,
            executionError(session, "ModelCallAttempt execution was stopped"),
          ).pipe(Effect.asVoid);
        });

      return ModelCallExecutor.of({
        execute,
        cancel: (attempt) => stop(attempt).pipe(Effect.as({ type: "mayContinue" as const })),
        outcome: (attempt) =>
          Effect.suspend(() => {
            const session = sessions.get(attempt.modelCallAttemptId);
            if (session === undefined) {
              return Effect.fail(
                new ModelCallExecutionError({
                  cause: "ModelCallAttempt outcome is unavailable",
                  dispatchEvidence: { type: "uncertain" },
                  usage: { type: "unknown" },
                }),
              );
            }
            return Deferred.await(session.outcome).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  sessions.delete(attempt.modelCallAttemptId);
                }),
              ),
            );
          }),
        terminate: (attempt) =>
          stop(attempt).pipe(
            Effect.andThen(
              Effect.sync(() => {
                sessions.delete(attempt.modelCallAttemptId);
              }),
            ),
          ),
      });
    }),
  );

export const makeOpenAIResponsesModelCallExecutorLayer = (
  config: OpenAIResponsesModelCallExecutorConfig,
) => executorLayer(config);

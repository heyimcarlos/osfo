import {
  modelCallObservationTextMaxLength,
  ModelCallExecutionError,
  ModelCallExecutor,
  type ModelCallAttempt,
  type ModelCallAttemptOutcome,
  type ModelCallDispatchEvidence,
  type ModelCallObservation,
} from "@osfo/agent-run";
import { Deferred, Effect, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { type liveOpenRouterExecutionProfile } from "./execution-profile.js";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const UnsupportedDeltaKey = Schema.String.check(
  Schema.isPattern(/^(?!(?:role|content|reasoning|reasoning_details|refusal|tool_calls|audio)$)/),
);

const UsageSchema = Schema.StructWithRest(
  Schema.Struct({
    prompt_tokens: NonNegativeInt,
    completion_tokens: NonNegativeInt,
    total_tokens: NonNegativeInt,
    completion_tokens_details: Schema.optional(
      Schema.NullOr(
        Schema.StructWithRest(
          Schema.Struct({
            reasoning_tokens: Schema.optional(NonNegativeInt),
          }),
          [Schema.Record(Schema.String, Schema.Unknown)],
        ),
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const DeltaSchema = Schema.StructWithRest(
  Schema.Struct({
    role: Schema.optional(Schema.Literal("assistant")),
    content: Schema.optional(Schema.NullOr(Schema.String)),
    reasoning: Schema.optional(Schema.NullOr(Schema.String)),
    reasoning_details: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    refusal: Schema.optional(Schema.NullOr(Schema.String)),
    tool_calls: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    audio: Schema.optional(Schema.NullOr(Schema.Unknown)),
  }),
  [Schema.Record(UnsupportedDeltaKey, Schema.Never)],
);

const ChoiceSchema = Schema.Struct({
  index: Schema.Literal(0),
  delta: DeltaSchema,
  finish_reason: Schema.NullOr(NonEmptyText),
  native_finish_reason: Schema.optional(Schema.NullOr(NonEmptyText)),
  logprobs: Schema.optional(Schema.Null),
});

const ChatCompletionChunkSchema = Schema.StructWithRest(
  Schema.Struct({
    id: NonEmptyText,
    model: NonEmptyText,
    object: Schema.Literal("chat.completion.chunk"),
    provider: NonEmptyText,
    choices: Schema.Array(ChoiceSchema),
    usage: Schema.optional(Schema.NullOr(UsageSchema)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ProviderErrorSchema = Schema.StructWithRest(
  Schema.Struct({
    error: Schema.StructWithRest(
      Schema.Struct({
        code: Schema.Union([Schema.Number, Schema.String]),
        message: NonEmptyText,
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const OpenRouterEventSchema = Schema.Union([ChatCompletionChunkSchema, ProviderErrorSchema]);
const OpenRouterEventFromJson = Schema.fromJsonString(OpenRouterEventSchema);
type ChatCompletionChunk = typeof ChatCompletionChunkSchema.Type;
type OpenRouterEvent = typeof OpenRouterEventSchema.Type;

type StreamEnvelope =
  | { readonly type: "ignored" }
  | { readonly type: "done" }
  | { readonly type: "event"; readonly event: OpenRouterEvent };

type ChatCompletionsProtocolPhase =
  | { readonly type: "awaitingChunk" }
  | { readonly type: "streaming"; readonly providerRequestId: string }
  | { readonly type: "awaitingUsage"; readonly providerRequestId: string }
  | {
      readonly type: "awaitingDone";
      readonly providerRequestId: string;
      readonly usage: typeof UsageSchema.Type;
    }
  | { readonly type: "completed"; readonly providerRequestId: string };

interface OpenRouterChatCompletionsSession {
  readonly attempt: ModelCallAttempt;
  readonly cancellation: Deferred.Deferred<never, ModelCallExecutionError>;
  readonly outcome: Deferred.Deferred<ModelCallAttemptOutcome, ModelCallExecutionError>;
  dispatchEvidence: ModelCallDispatchEvidence;
}

export interface OpenRouterChatCompletionsModelCallExecutorConfig {
  readonly apiKey: string;
  readonly profile: typeof liveOpenRouterExecutionProfile;
}

const executorLayer = (config: OpenRouterChatCompletionsModelCallExecutorConfig) =>
  Layer.effect(
    ModelCallExecutor,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const sessions = new Map<string, OpenRouterChatCompletionsSession>();

      const executionError = (
        session: OpenRouterChatCompletionsSession,
        cause: unknown,
      ): ModelCallExecutionError =>
        new ModelCallExecutionError({
          cause,
          dispatchEvidence: session.dispatchEvidence,
          usage: { type: "unknown" },
        });

      const decodeEvent = (session: OpenRouterChatCompletionsSession, data: string) =>
        Schema.decodeUnknownEffect(OpenRouterEventFromJson, { onExcessProperty: "error" })(
          data,
        ).pipe(Effect.mapError((cause) => executionError(session, cause)));

      const decodeLine = (
        session: OpenRouterChatCompletionsSession,
        line: string,
      ): Effect.Effect<StreamEnvelope, ModelCallExecutionError> => {
        if (line.length === 0 || line.startsWith(":")) {
          return Effect.succeed({ type: "ignored" } as const satisfies StreamEnvelope);
        }
        if (!line.startsWith("data:")) {
          return Effect.fail(executionError(session, "Provider emitted an invalid SSE field"));
        }
        const data = line.slice("data:".length).trimStart();
        if (data.length === 0 || data.startsWith(":")) {
          return Effect.succeed({ type: "ignored" } as const satisfies StreamEnvelope);
        }
        if (data === config.profile.requiredSemantics.terminalEnvelope) {
          return Effect.succeed({ type: "done" } as const satisfies StreamEnvelope);
        }
        return decodeEvent(session, data).pipe(
          Effect.map((event) => ({ type: "event", event }) as const satisfies StreamEnvelope),
        );
      };

      const makeOutputStream = (session: OpenRouterChatCompletionsSession) => {
        let phase: ChatCompletionsProtocolPhase = { type: "awaitingChunk" };
        let fragmentIndex = 0;
        let pendingDeltas: Array<string> = [];
        let textOutputObserved = false;

        const flush = (): ReadonlyArray<ModelCallObservation> => {
          if (pendingDeltas.length === 0) return [];
          const text = pendingDeltas.join("");
          pendingDeltas = [];
          const observations: Array<ModelCallObservation> = [];
          let output = "";
          let outputLength = 0;
          const emitOutput = () => {
            observations.push({ fragmentIndex, text: output });
            fragmentIndex += 1;
            output = "";
            outputLength = 0;
          };
          for (const character of text) {
            if (outputLength + character.length > modelCallObservationTextMaxLength) emitOutput();
            output += character;
            outputLength += character.length;
          }
          if (outputLength > 0) emitOutput();
          return observations;
        };

        const providerRequestId = () =>
          phase.type === "awaitingChunk" ? undefined : phase.providerRequestId;

        const validateIdentity = (chunk: ChatCompletionChunk) => {
          if (chunk.model !== config.profile.model || chunk.provider !== config.profile.provider) {
            return Effect.fail(
              executionError(session, "Provider completed with another model or provider"),
            );
          }
          const existingId = providerRequestId();
          if (existingId !== undefined && existingId !== chunk.id) {
            return Effect.fail(executionError(session, "Provider generation identity changed"));
          }
          if (existingId === undefined) {
            phase = { type: "streaming", providerRequestId: chunk.id };
            session.dispatchEvidence = {
              type: "confirmed",
              providerRequestId: chunk.id,
            };
          }
          return Effect.void;
        };

        const validateUsage = (usage: typeof UsageSchema.Type) => {
          const reasoningUnits = usage.completion_tokens_details?.reasoning_tokens;
          if (
            usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
            (reasoningUnits !== undefined && reasoningUnits > usage.completion_tokens)
          ) {
            return Effect.fail(executionError(session, "Provider reported inconsistent usage"));
          }
          return Effect.succeed(usage);
        };

        const handleChunk = (chunk: ChatCompletionChunk) =>
          Effect.gen(function* () {
            if (phase.type === "completed") {
              return yield* executionError(session, "Provider emitted an event after [DONE]");
            }
            yield* validateIdentity(chunk);
            const identity = providerRequestId();
            if (identity === undefined) {
              return yield* executionError(session, "Provider identity is unavailable");
            }
            const usage = chunk.usage ?? undefined;

            if (phase.type === "awaitingUsage") {
              if (chunk.choices.length !== 0 || usage === undefined) {
                return yield* executionError(
                  session,
                  "Provider emitted output after terminal finish",
                );
              }
              const validatedUsage = yield* validateUsage(usage);
              phase = { type: "awaitingDone", providerRequestId: identity, usage: validatedUsage };
              return [];
            }
            if (phase.type === "awaitingDone") {
              return yield* executionError(session, "Provider emitted an event after final usage");
            }
            if (chunk.choices.length !== 1) {
              return yield* executionError(session, "Provider emitted an invalid choices shape");
            }
            const choice = chunk.choices[0];
            if (choice === undefined) {
              return yield* executionError(session, "Provider emitted an invalid choices shape");
            }
            if (usage !== undefined && choice.finish_reason === null) {
              return yield* executionError(
                session,
                "Provider reported usage before terminal finish",
              );
            }
            const content = choice.delta.content;
            const unsupportedOutput =
              (choice.delta.tool_calls?.length ?? 0) > 0 ||
              choice.delta.audio != null ||
              (choice.delta.refusal?.length ?? 0) > 0 ||
              (choice.delta.reasoning?.length ?? 0) > 0 ||
              (choice.delta.reasoning_details?.length ?? 0) > 0;
            if (unsupportedOutput) {
              return yield* executionError(
                session,
                "Provider emitted output outside the text-only profile",
              );
            }
            if (content !== undefined && content !== null && content.length > 0) {
              textOutputObserved = true;
              pendingDeltas.push(content);
            }
            if (choice.finish_reason === null) {
              return pendingDeltas.length >= config.profile.permittedAdaptations.coalesceUpToDeltas
                ? flush()
                : [];
            }
            if (choice.finish_reason !== config.profile.requiredSemantics.finishReason) {
              return yield* executionError(
                session,
                "Provider emitted an unsupported finish reason",
              );
            }
            if (!textOutputObserved) {
              return yield* executionError(session, "Provider completed without text output");
            }
            if (usage === undefined) {
              phase = { type: "awaitingUsage", providerRequestId: identity };
              return [];
            }
            const validatedUsage = yield* validateUsage(usage);
            phase = { type: "awaitingDone", providerRequestId: identity, usage: validatedUsage };
            return [];
          });

        const handleEnvelope = (envelope: StreamEnvelope) =>
          Effect.gen(function* () {
            if (envelope.type === "ignored") return [];
            if (envelope.type === "event") {
              if (phase.type === "completed") {
                return yield* executionError(session, "Provider emitted an event after [DONE]");
              }
              if ("error" in envelope.event) {
                return yield* executionError(session, "Provider emitted a stream error");
              }
              return yield* handleChunk(envelope.event);
            }
            if (phase.type === "completed") {
              return yield* executionError(session, "Provider emitted duplicate [DONE]");
            }
            if (phase.type !== "awaitingDone") {
              return yield* executionError(
                session,
                phase.type === "awaitingUsage"
                  ? "Provider ended without final usage"
                  : "Provider ended before terminal finish",
              );
            }
            const usage = phase.usage;
            const identity = phase.providerRequestId;
            const reasoningUnits = usage.completion_tokens_details?.reasoning_tokens;
            phase = { type: "completed", providerRequestId: identity };
            yield* Deferred.succeed(session.outcome, {
              dispatchEvidence: session.dispatchEvidence,
              usage: {
                type: "reported",
                inputUnits: usage.prompt_tokens,
                outputUnits: usage.completion_tokens,
                ...(reasoningUnits === undefined ? {} : { reasoningUnits }),
              },
            });
            return flush();
          });

        const request = HttpClientRequest.post(config.profile.endpoint).pipe(
          HttpClientRequest.bearerToken(config.apiKey),
          HttpClientRequest.setHeader("accept", "text/event-stream"),
          HttpClientRequest.bodyJson({
            messages: [{ role: "user", content: session.attempt.prompt }],
            model: config.profile.model,
            stream: config.profile.request.stream,
            max_tokens: config.profile.request.maxTokens,
            temperature: config.profile.request.temperature,
            reasoning: config.profile.request.reasoning,
            provider: {
              only: config.profile.request.provider.only,
              allow_fallbacks: config.profile.request.provider.allowFallbacks,
              require_parameters: config.profile.request.provider.requireParameters,
              data_collection: config.profile.request.provider.dataCollection,
            },
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
          Stream.mapEffect((line) => decodeLine(session, line)),
          Stream.mapEffect(handleEnvelope),
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
            phase.type === "completed"
              ? Effect.void
              : Effect.fail(executionError(session, "Response stream ended without [DONE]")),
          ),
        );

        return body.pipe(Stream.concat(requireCompletion));
      };

      const execute: ModelCallExecutor["Service"]["execute"] = Effect.fn(
        "OpenRouterChatCompletionsModelCallExecutor.execute",
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
        const session: OpenRouterChatCompletionsSession = {
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

export const makeOpenRouterChatCompletionsModelCallExecutorLayer = (
  config: OpenRouterChatCompletionsModelCallExecutorConfig,
) => executorLayer(config);

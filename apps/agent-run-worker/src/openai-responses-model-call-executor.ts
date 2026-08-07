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
import { type liveOpenAIExecutionProfile } from "./execution-profile.js";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const FirstOutputIndex = Schema.Literal(0);

const OutputContentPartSchema = Schema.Struct({
  type: NonEmptyText,
  text: Schema.optional(Schema.String),
});

const OutputItemSchema = Schema.Struct({
  id: NonEmptyText,
  type: NonEmptyText,
  content: Schema.optional(Schema.Array(OutputContentPartSchema)),
});

const CreatedEventSchema = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Schema.Struct({ id: NonEmptyText }),
});

const OutputTextDeltaEventSchema = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  item_id: NonEmptyText,
  output_index: FirstOutputIndex,
  content_index: FirstOutputIndex,
  delta: Schema.String,
});

const CompletedEventSchema = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.Struct({
    id: NonEmptyText,
    status: Schema.Literal("completed"),
    model: NonEmptyText,
    store: Schema.Literal(false),
    output: Schema.Array(OutputItemSchema),
    usage: Schema.Struct({
      input_tokens: NonNegativeInt,
      output_tokens: NonNegativeInt,
    }),
  }),
});

const ProviderFailureEventSchema = Schema.Struct({
  type: Schema.Literals(["error", "response.failed", "response.incomplete"]),
});

const OutputItemEventSchema = Schema.Struct({
  type: Schema.Literals(["response.output_item.added", "response.output_item.done"]),
  output_index: FirstOutputIndex,
  item: OutputItemSchema,
});

const ContentPartEventSchema = Schema.Struct({
  type: Schema.Literals(["response.content_part.added", "response.content_part.done"]),
  item_id: NonEmptyText,
  output_index: FirstOutputIndex,
  content_index: FirstOutputIndex,
  part: OutputContentPartSchema,
});

const OutputTextDoneEventSchema = Schema.Struct({
  type: Schema.Literal("response.output_text.done"),
  item_id: NonEmptyText,
  output_index: FirstOutputIndex,
  content_index: FirstOutputIndex,
  text: Schema.String,
});

const IgnoredEventSchema = Schema.Struct({
  type: Schema.Literals(["response.queued", "response.in_progress"]),
});

const ResponsesEventSchema = Schema.Union([
  CreatedEventSchema,
  OutputTextDeltaEventSchema,
  CompletedEventSchema,
  ProviderFailureEventSchema,
  OutputItemEventSchema,
  ContentPartEventSchema,
  OutputTextDoneEventSchema,
  IgnoredEventSchema,
]);

const ResponsesEventFromJson = Schema.fromJsonString(ResponsesEventSchema);
type ResponsesEvent = typeof ResponsesEventSchema.Type;

interface OutputItemIdentity {
  readonly itemId: string;
  readonly outputIndex: number;
}

interface TextPartState extends OutputItemIdentity {
  readonly contentIndex: number;
  streamedText: string;
  outputTextDone: boolean;
  contentPartDone: boolean;
}

type ResponsesProtocolPhase =
  | { readonly type: "awaitingCreated" }
  | { readonly type: "streaming"; readonly providerRequestId: string }
  | { readonly type: "completed"; readonly providerRequestId: string };

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
        let phase: ResponsesProtocolPhase = { type: "awaitingCreated" };
        let fragmentIndex = 0;
        let pendingDeltas: Array<string> = [];
        let textOutputObserved = false;
        let outputItem: (OutputItemIdentity & { done: boolean }) | undefined;
        let textPart: TextPartState | undefined;

        const matchesOutputItem = (
          identity: OutputItemIdentity,
          itemId: string,
          outputIndex: number,
        ) => identity.itemId === itemId && identity.outputIndex === outputIndex;

        const matchesTextPart = (
          part: TextPartState,
          itemId: string,
          outputIndex: number,
          contentIndex: number,
        ) => matchesOutputItem(part, itemId, outputIndex) && part.contentIndex === contentIndex;

        const flush = (): ReadonlyArray<ModelCallObservation> => {
          if (pendingDeltas.length === 0) return [];
          const text = pendingDeltas.join("");
          pendingDeltas = [];
          const observations: Array<ModelCallObservation> = [];
          let chunk = "";
          let chunkLength = 0;
          const emitChunk = () => {
            observations.push({ fragmentIndex, text: chunk });
            fragmentIndex += 1;
            chunk = "";
            chunkLength = 0;
          };
          for (const character of text) {
            if (chunkLength + character.length > modelCallObservationTextMaxLength) emitChunk();
            chunk += character;
            chunkLength += character.length;
          }
          if (chunkLength > 0) emitChunk();
          return observations;
        };

        const handleEvent = (event: ResponsesEvent) =>
          Effect.gen(function* () {
            if (phase.type === "completed") {
              return yield* executionError(
                session,
                `Provider emitted ${event.type} after response.completed`,
              );
            }
            if (
              phase.type === "awaitingCreated" &&
              event.type !== "response.created" &&
              event.type !== "error" &&
              event.type !== "response.failed" &&
              event.type !== "response.incomplete"
            ) {
              return yield* executionError(
                session,
                `Provider emitted ${event.type} before response.created`,
              );
            }
            switch (event.type) {
              case "response.created":
                if (phase.type !== "awaitingCreated") {
                  return yield* executionError(
                    session,
                    "Provider emitted duplicate response.created",
                  );
                }
                phase = {
                  type: "streaming",
                  providerRequestId: event.response.id,
                };
                session.dispatchEvidence = {
                  type: "confirmed",
                  providerRequestId: event.response.id,
                };
                return [];
              case "response.output_text.delta":
                if (
                  textPart === undefined ||
                  !matchesTextPart(
                    textPart,
                    event.item_id,
                    event.output_index,
                    event.content_index,
                  ) ||
                  textPart.outputTextDone
                ) {
                  return yield* executionError(
                    session,
                    "Provider emitted text delta for an unknown or finalized content part",
                  );
                }
                if (event.delta.length === 0) return [];
                textOutputObserved = true;
                textPart.streamedText += event.delta;
                pendingDeltas.push(event.delta);
                return pendingDeltas.length >=
                  config.profile.permittedAdaptations.coalesceUpToDeltas
                  ? flush()
                  : [];
              case "response.completed": {
                if (event.response.model !== config.profile.model) {
                  return yield* executionError(session, "Provider completed with another model");
                }
                if (phase.type !== "streaming" || phase.providerRequestId !== event.response.id) {
                  return yield* executionError(session, "Provider response identity changed");
                }
                if (!textOutputObserved) {
                  return yield* executionError(session, "Provider completed without text output");
                }
                if (
                  outputItem?.done !== true ||
                  textPart?.outputTextDone !== true ||
                  textPart.contentPartDone !== true
                ) {
                  return yield* executionError(
                    session,
                    "Provider completed before finalizing text output",
                  );
                }
                const [terminalOutput] = event.response.output;
                const terminalContent = terminalOutput?.content;
                if (
                  event.response.output.length !== 1 ||
                  terminalOutput?.type !== "message" ||
                  !matchesOutputItem(outputItem, terminalOutput.id, 0) ||
                  terminalContent === undefined ||
                  terminalContent.length !== 1 ||
                  terminalContent[0]?.type !== "output_text" ||
                  terminalContent[0].text !== textPart.streamedText
                ) {
                  return yield* executionError(
                    session,
                    "Provider completed with inconsistent output",
                  );
                }
                phase = {
                  type: "completed",
                  providerRequestId: event.response.id,
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
              case "response.output_item.added": {
                if (event.item.type !== "message") {
                  return yield* executionError(
                    session,
                    `Provider emitted unsupported output item ${event.item.type}`,
                  );
                }
                if (event.item.content === undefined) {
                  return yield* executionError(session, "Provider emitted invalid output message");
                }
                const unsupported = event.item.content.find((part) => part.type !== "output_text");
                if (unsupported !== undefined) {
                  return yield* executionError(
                    session,
                    `Provider emitted unsupported content part ${unsupported.type}`,
                  );
                }
                if (outputItem !== undefined) {
                  return yield* executionError(
                    session,
                    "Provider emitted multiple text output items",
                  );
                }
                outputItem = {
                  itemId: event.item.id,
                  outputIndex: event.output_index,
                  done: false,
                };
                return [];
              }
              case "response.output_item.done": {
                if (event.item.type !== "message") {
                  return yield* executionError(
                    session,
                    `Provider emitted unsupported output item ${event.item.type}`,
                  );
                }
                if (
                  outputItem === undefined ||
                  !matchesOutputItem(outputItem, event.item.id, event.output_index)
                ) {
                  return yield* executionError(session, "Provider output item identity changed");
                }
                if (outputItem.done) {
                  return yield* executionError(session, "Provider finalized output item twice");
                }
                const content = event.item.content;
                if (
                  textPart === undefined ||
                  !textPart.outputTextDone ||
                  !textPart.contentPartDone ||
                  content === undefined ||
                  content.length !== 1 ||
                  content[0]?.type !== "output_text" ||
                  content[0].text !== textPart.streamedText
                ) {
                  return yield* executionError(
                    session,
                    "Provider finalized an invalid output message",
                  );
                }
                outputItem.done = true;
                return [];
              }
              case "response.content_part.added":
                if (event.part.type !== "output_text" || event.part.text !== "") {
                  return yield* executionError(
                    session,
                    `Provider emitted unsupported content part ${event.part.type}`,
                  );
                }
                if (
                  outputItem === undefined ||
                  !matchesOutputItem(outputItem, event.item_id, event.output_index)
                ) {
                  return yield* executionError(session, "Provider content part identity changed");
                }
                if (textPart !== undefined) {
                  return yield* executionError(
                    session,
                    "Provider emitted multiple text content parts",
                  );
                }
                textPart = {
                  itemId: event.item_id,
                  outputIndex: event.output_index,
                  contentIndex: event.content_index,
                  streamedText: "",
                  outputTextDone: false,
                  contentPartDone: false,
                };
                return [];
              case "response.output_text.done":
                if (
                  textPart === undefined ||
                  !matchesTextPart(textPart, event.item_id, event.output_index, event.content_index)
                ) {
                  return yield* executionError(session, "Provider finalized an unknown text part");
                }
                if (textPart.outputTextDone) {
                  return yield* executionError(session, "Provider finalized text output twice");
                }
                if (event.text !== textPart.streamedText) {
                  return yield* executionError(
                    session,
                    "Provider finalized text that differs from streamed output",
                  );
                }
                textPart.outputTextDone = true;
                return [];
              case "response.content_part.done":
                if (event.part.type !== "output_text" || event.part.text === undefined) {
                  return yield* executionError(
                    session,
                    `Provider emitted unsupported content part ${event.part.type}`,
                  );
                }
                if (
                  textPart === undefined ||
                  !matchesTextPart(
                    textPart,
                    event.item_id,
                    event.output_index,
                    event.content_index,
                  ) ||
                  !textPart.outputTextDone ||
                  event.part.text !== textPart.streamedText
                ) {
                  return yield* executionError(
                    session,
                    "Provider finalized an invalid content part",
                  );
                }
                if (textPart.contentPartDone) {
                  return yield* executionError(session, "Provider finalized content part twice");
                }
                textPart.contentPartDone = true;
                return [];
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
            phase.type === "completed"
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

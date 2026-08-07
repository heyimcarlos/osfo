import {
  toolCallBatchSizeMax,
  toolCallResultTextMaxLength,
  type ToolCallBatchRequest,
} from "@osfo/agent-run";
import { Data, Effect, Schema } from "effect";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const ProviderToolCallId = NonEmptyText.check(Schema.isMaxLength(256));
const ToolName = NonEmptyText.check(Schema.isMaxLength(128));
const ArgumentFragment = Schema.String.check(Schema.isMaxLength(toolCallResultTextMaxLength));

const OpenRouterFunctionDeltaSchema = Schema.Struct({
  name: Schema.optional(ToolName),
  arguments: Schema.optional(ArgumentFragment),
});

export const OpenRouterToolCallDeltaSchema = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: Schema.optional(ProviderToolCallId),
  type: Schema.optional(Schema.Literal("function")),
  function: Schema.optional(OpenRouterFunctionDeltaSchema),
});

export const openRouterToolCallDeltaMax = toolCallBatchSizeMax * 256;

const EchoArgumentsSchema = Schema.Struct({
  text: NonEmptyText.check(Schema.isMaxLength(toolCallResultTextMaxLength)),
});

const EchoArgumentsFromJson = Schema.fromJsonString(EchoArgumentsSchema);

export const openRouterNonActionToolCatalog = [
  {
    type: "function" as const,
    function: {
      name: "echo",
      description: "Return the supplied text unchanged.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          text: {
            type: "string" as const,
            minLength: 1,
            maxLength: toolCallResultTextMaxLength,
          },
        },
        required: ["text"] as const,
      },
    },
  },
] as const;

export class OpenRouterToolCallNormalizationError extends Data.TaggedError(
  "OpenRouterToolCallNormalizationError",
)<{
  readonly cause: unknown;
}> {}

interface AccumulatedToolCall {
  readonly index: number;
  providerId?: string;
  functionTypeObserved: boolean;
  toolName?: string;
  argumentsJson: string;
}

const fail = (cause: unknown) => new OpenRouterToolCallNormalizationError({ cause });

export const normalizeOpenRouterNonActionToolCalls = Effect.fn(
  "OpenRouterNonActionToolCalls.normalize",
)(function* (modelCallId: string, rawDeltas: ReadonlyArray<unknown>) {
  if (rawDeltas.length === 0) return yield* fail("ToolCall completion contained no calls");
  if (rawDeltas.length > openRouterToolCallDeltaMax) {
    return yield* fail("ToolCall completion exceeded the bounded delta count");
  }

  const calls = new Map<number, AccumulatedToolCall>();
  const providerIds = new Set<string>();

  for (const rawDelta of rawDeltas) {
    const delta = yield* Schema.decodeUnknownEffect(OpenRouterToolCallDeltaSchema, {
      onExcessProperty: "error",
    })(rawDelta).pipe(Effect.mapError(() => fail("Provider emitted an invalid ToolCall delta")));
    if (delta.index >= toolCallBatchSizeMax) {
      return yield* fail("ToolCall index exceeds the bounded batch size");
    }

    const accumulated = calls.get(delta.index) ?? {
      index: delta.index,
      argumentsJson: "",
      functionTypeObserved: false,
    };
    if (delta.type === "function") accumulated.functionTypeObserved = true;
    if (delta.id !== undefined) {
      if (accumulated.providerId !== undefined && accumulated.providerId !== delta.id) {
        return yield* fail("ToolCall provider identity changed while streaming");
      }
      if (accumulated.providerId === undefined && providerIds.has(delta.id)) {
        return yield* fail("ToolCall provider identity was reused across the batch");
      }
      providerIds.add(delta.id);
      accumulated.providerId = delta.id;
    }
    const functionDelta = delta.function;
    if (functionDelta !== undefined) {
      if (functionDelta.name !== undefined) {
        if (accumulated.toolName !== undefined && accumulated.toolName !== functionDelta.name) {
          return yield* fail("ToolCall name changed while streaming");
        }
        accumulated.toolName = functionDelta.name;
      }
      if (functionDelta.arguments !== undefined) {
        if (
          accumulated.argumentsJson.length + functionDelta.arguments.length >
          toolCallResultTextMaxLength
        ) {
          return yield* fail("ToolCall arguments exceed the bounded input size");
        }
        accumulated.argumentsJson += functionDelta.arguments;
      }
    }
    calls.set(delta.index, accumulated);
  }

  const orderedCalls = Array.from(calls.values()).sort((left, right) => left.index - right.index);
  if (orderedCalls.length > toolCallBatchSizeMax) {
    return yield* fail("ToolCall batch exceeds the bounded batch size");
  }
  if (orderedCalls.some((call, index) => call.index !== index)) {
    return yield* fail("ToolCall indexes must be contiguous and zero-based");
  }

  const requests: Array<ToolCallBatchRequest["requests"][number]> = [];
  for (const call of orderedCalls) {
    if (call.providerId === undefined) {
      return yield* fail("ToolCall is missing its provider identity");
    }
    if (!call.functionTypeObserved) {
      return yield* fail("ToolCall is missing its function type");
    }
    if (call.toolName !== "echo") {
      return yield* fail("ToolCall requested a tool outside the bounded catalog");
    }
    const input = yield* Schema.decodeUnknownEffect(EchoArgumentsFromJson, {
      onExcessProperty: "error",
    })(call.argumentsJson).pipe(
      Effect.mapError(() => fail("ToolCall arguments do not match the bounded catalog")),
    );
    requests.push({
      executionMode: "nonAction",
      toolName: "echo",
      input: { type: "text", text: input.text },
    });
  }

  return {
    batchKey: `model-call:${modelCallId}`,
    attemptLimit: 2,
    requests,
  } satisfies ToolCallBatchRequest;
});

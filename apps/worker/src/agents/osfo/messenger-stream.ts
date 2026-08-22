import type { StreamCallback } from "@cloudflare/think";
import { Effect, Schema } from "effect";

const TextDelta = Schema.fromJsonString(
  Schema.Struct({ delta: Schema.String, type: Schema.Literal("text-delta") }),
);

const DeliveryOperation = Schema.Literals(["done", "error", "event", "interrupted", "start"]);

/** Safe delivery failure that never retains callback input or an untrusted cause. */
export class MessengerDeliveryUnavailable extends Schema.TaggedError<MessengerDeliveryUnavailable>()(
  "MessengerDeliveryUnavailable",
  {
    message: Schema.String,
    operation: DeliveryOperation,
  },
) {}

export const startStream = Effect.fn("MessengerStream.start")(
  (callback: StreamCallback, requestId: string) =>
    delivery("start", () => callback.onStart({ requestId })),
);

export const emitTextDelta = Effect.fn("MessengerStream.emitTextDelta")(
  (callback: StreamCallback, delta: string) =>
    emitStreamEvent(callback, Schema.encodeSync(TextDelta)({ delta, type: "text-delta" })),
);

export const emitStreamEvent = Effect.fn("MessengerStream.emitEvent")(
  (callback: StreamCallback, event: string) => delivery("event", () => callback.onEvent(event)),
);

export const finishStream = Effect.fn("MessengerStream.finish")((callback: StreamCallback) =>
  delivery("done", () => callback.onDone()),
);

export const failStream = Effect.fn("MessengerStream.fail")(
  (callback: StreamCallback, error: string) => delivery("error", () => callback.onError(error)),
);

export const interruptStream = Effect.fn("MessengerStream.interrupt")((callback: StreamCallback) =>
  callback.onInterrupted === undefined
    ? Effect.void
    : delivery("interrupted", () => callback.onInterrupted?.()),
);

export const streamTextReply = Effect.fn("MessengerStream.reply")(function* (
  callback: StreamCallback,
  requestId: string,
  text: string,
) {
  yield* startStream(callback, requestId);
  yield* emitTextDelta(callback, text);
  yield* finishStream(callback);
});

const delivery = <A>(
  operation: typeof DeliveryOperation.Type,
  run: () => A | PromiseLike<A>,
): Effect.Effect<A, MessengerDeliveryUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: () =>
      new MessengerDeliveryUnavailable({
        message: `Messenger delivery ${operation} failed`,
        operation,
      }),
  }).pipe(Effect.withSpan(`MessengerStream.${operation}`));

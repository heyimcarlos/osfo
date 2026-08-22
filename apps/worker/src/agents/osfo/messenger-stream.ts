import type { StreamCallback } from "@cloudflare/think";
import { Effect, Predicate, Schema } from "effect";

import { redactInviteUrls } from "./company-conversation";

const TextDelta = Schema.fromJsonString(
  Schema.Struct({ delta: Schema.String, type: Schema.Literal("text-delta") }),
);

const DeliveryOperation = Schema.Literals(["done", "error", "event", "interrupted", "start"]);

/** Safe delivery failure that never retains callback input or an untrusted cause. */
export class MessengerDeliveryUnavailable extends Schema.TaggedError<MessengerDeliveryUnavailable>()(
  "MessengerDeliveryUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: DeliveryOperation,
  },
) {}

/** Effect adapter around the existing Think callback without mirroring its API. */
export interface MessengerStream {
  readonly use: <A>(
    operation: typeof DeliveryOperation.Type,
    run: (callback: StreamCallback) => A | PromiseLike<A>,
  ) => Effect.Effect<A, MessengerDeliveryUnavailable>;
}

/** Give Effect code scoped access to one raw Think callback. */
export const makeMessengerStream = (callback: StreamCallback): MessengerStream => ({
  use: (operation, run) => delivery(operation, () => run(callback)),
});

export const emitTextDelta = Effect.fn("MessengerStream.emitTextDelta")(
  (stream: MessengerStream, delta: string) =>
    stream.use("event", (callback) =>
      callback.onEvent(Schema.encodeSync(TextDelta)({ delta, type: "text-delta" })),
    ),
);

export const streamTextReply = Effect.fn("MessengerStream.reply")(function* (
  callback: StreamCallback,
  requestId: string,
  text: string,
) {
  const stream = makeMessengerStream(callback);
  yield* stream.use("start", (raw) => raw.onStart({ requestId }));
  yield* emitTextDelta(stream, text);
  yield* stream.use("done", (raw) => raw.onDone());
});

const delivery = Effect.fn("MessengerStream.use")(function* <A>(
  operation: typeof DeliveryOperation.Type,
  run: () => A | PromiseLike<A>,
): Effect.fn.Return<A, MessengerDeliveryUnavailable> {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) =>
      new MessengerDeliveryUnavailable({
        cause: safeDeliveryCause(cause),
        message: `Messenger delivery ${operation} failed`,
        operation,
      }),
  }).pipe(Effect.annotateSpans("operation", operation));
});

/** Keep useful error identity while removing bearer material echoed by callbacks. */
const safeDeliveryCause = (cause: unknown): Error => {
  const message = Predicate.isError(cause)
    ? cause.message
    : Predicate.isString(cause)
      ? cause
      : "Non-Error messenger delivery failure";
  const error = new Error(redactInviteUrls(message));
  if (!Predicate.isError(cause)) return error;
  error.name = redactInviteUrls(cause.name);
  if (Predicate.isString(cause.stack)) error.stack = redactInviteUrls(cause.stack);
  return error;
};

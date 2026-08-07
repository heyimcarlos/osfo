import { PubSub, type Message, type Subscription } from "@google-cloud/pubsub";
import { AgentRunWorker, decodeRunnableDeliveryData } from "@osfo/agent-run";
import { Context, Data, Deferred, Effect, FiberMap, Layer, Schema, Semaphore } from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const GoogleStreamingPullConfigSchema = Schema.Struct({
  projectId: Schema.NonEmptyString,
  subscriptionId: Schema.NonEmptyString,
  streamCount: PositiveInteger,
  maxOutstandingMessages: PositiveInteger,
});

export type GoogleStreamingPullConfig = typeof GoogleStreamingPullConfigSchema.Type;

export class InvalidGoogleStreamingPullConfig extends Data.TaggedError(
  "InvalidGoogleStreamingPullConfig",
)<{ readonly cause: unknown }> {}

export class StreamingPullSourceUnavailable extends Data.TaggedError(
  "StreamingPullSourceUnavailable",
)<{ readonly cause: unknown; readonly operation: "create" | "receive" | "start" | "stop" }> {}

export class StreamingPullSettlementFailed extends Data.TaggedError(
  "StreamingPullSettlementFailed",
)<{ readonly action: "acknowledge" | "nack"; readonly cause: unknown }> {}

export interface StreamingPullMessage {
  readonly data: Uint8Array;
  readonly id: string;
  readonly orderingKey: string | undefined;
  readonly acknowledge: () => void;
  readonly nack: () => void;
}

export interface StreamingPullHandlers {
  readonly onError: (cause: unknown) => void;
  readonly onMessage: (message: StreamingPullMessage) => void;
}

export class StreamingPullSource extends Context.Service<
  StreamingPullSource,
  {
    readonly start: (
      handlers: StreamingPullHandlers,
    ) => Effect.Effect<void, StreamingPullSourceUnavailable>;
    readonly stop: () => Effect.Effect<void, StreamingPullSourceUnavailable>;
    readonly close: () => Effect.Effect<void, StreamingPullSourceUnavailable>;
  }
>()("@osfo/agent-run-worker/StreamingPullSource") {}

const adaptMessage = (message: Message): StreamingPullMessage => ({
  data: message.data,
  id: message.id,
  orderingKey: message.orderingKey,
  acknowledge: () => message.ack(),
  nack: () => message.nack(),
});

const makeGoogleSource = (config: GoogleStreamingPullConfig) =>
  Effect.gen(function* () {
    const client = yield* Effect.try({
      try: () => new PubSub({ projectId: config.projectId }),
      catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "create" }),
    });
    const subscription = yield* Effect.try({
      try: () =>
        client.subscription(config.subscriptionId, {
          flowControl: {
            allowExcessMessages: false,
            maxMessages: config.maxOutstandingMessages,
          },
          streamingOptions: { maxStreams: config.streamCount },
        }),
      catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "create" }),
    });
    let activeHandlers:
      | {
          readonly error: (cause: unknown) => void;
          readonly close: () => void;
          readonly message: (message: Message) => void;
        }
      | undefined;
    let intakeStopped = false;
    let closed = false;

    const start = (handlers: StreamingPullHandlers) =>
      Effect.try({
        try: () => {
          const message = (value: Message) => handlers.onMessage(adaptMessage(value));
          const error = (cause: unknown) => handlers.onError(cause);
          const close = () => handlers.onError("StreamingPull subscription closed");
          subscription.on("message", message);
          subscription.on("error", error);
          subscription.on("close", close);
          activeHandlers = { close, error, message };
        },
        catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "start" }),
      });

    const stop = () =>
      Effect.suspend(() => {
        if (intakeStopped) return Effect.void;
        intakeStopped = true;
        return Effect.sync(() => {
          if (activeHandlers !== undefined) {
            subscription.removeListener("message", activeHandlers.message);
            subscription.removeListener("error", activeHandlers.error);
            subscription.removeListener("close", activeHandlers.close);
          }
        });
      });

    const close = () =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        return stop().pipe(
          Effect.andThen(closeGoogleClient(subscription, client)),
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
        );
      });

    return StreamingPullSource.of({ close, start, stop });
  });

const closeGoogleClient = (subscription: Subscription, client: PubSub) =>
  Effect.tryPromise({
    try: async () => {
      await subscription.close();
      await client.close();
    },
    catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "stop" }),
  });

const googleSourceLayer = (config: GoogleStreamingPullConfig) =>
  Layer.effect(
    StreamingPullSource,
    Effect.acquireRelease(makeGoogleSource(config), (source) => source.close().pipe(Effect.ignore)),
  );

export const makeGoogleStreamingPullSourceLayer = (config: GoogleStreamingPullConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(GoogleStreamingPullConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidGoogleStreamingPullConfig({ cause })),
      Effect.map(googleSourceLayer),
    ),
  );

export const StreamingPullWorkerConfigSchema = Schema.Struct({
  executionSlots: PositiveInteger,
});

export type StreamingPullWorkerConfig = typeof StreamingPullWorkerConfigSchema.Type;

interface OrderingLane {
  pending: number;
  readonly semaphore: Semaphore.Semaphore;
}

const settle = (message: StreamingPullMessage, action: "acknowledge" | "nack") =>
  Effect.try({
    try: () => message[action](),
    catch: (cause) => new StreamingPullSettlementFailed({ action, cause }),
  });

const settleOrLog = (message: StreamingPullMessage, action: "acknowledge" | "nack") =>
  settle(message, action).pipe(
    Effect.catchTag("StreamingPullSettlementFailed", (cause) =>
      Effect.logError("StreamingPull message settlement failed", cause),
    ),
  );

const processMessage = (message: StreamingPullMessage) =>
  decodeRunnableDeliveryData(message.data).pipe(
    Effect.flatMap((delivery) =>
      AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.flatMap((disposition) =>
          settle(message, disposition.type === "acknowledge" ? "acknowledge" : "nack"),
        ),
      ),
    ),
    Effect.catchTag("InvalidRunnableDelivery", (cause) =>
      Effect.logWarning("StreamingPull delivery was invalid", cause).pipe(
        Effect.andThen(settle(message, "nack")),
      ),
    ),
    Effect.catchTag("StreamingPullSettlementFailed", (cause) =>
      Effect.logError("StreamingPull message settlement failed", cause),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("StreamingPull delivery processing failed", cause).pipe(
        Effect.andThen(settle(message, "nack").pipe(Effect.ignore)),
      ),
    ),
  );

export const runStreamingPullWorker = (
  config: StreamingPullWorkerConfig,
): Effect.Effect<void, StreamingPullSourceUnavailable, AgentRunWorker | StreamingPullSource> =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* StreamingPullSource;
      const execution = yield* Semaphore.make(config.executionSlots);
      const fibers = yield* FiberMap.make<string, void, never>();
      const run = yield* FiberMap.runtime(fibers)<AgentRunWorker>();
      const sourceFailure = yield* Deferred.make<void, StreamingPullSourceUnavailable>();
      const lanes = new Map<string, OrderingLane>();
      let accepting = true;
      let sequence = 0;

      const schedule = (message: StreamingPullMessage) => {
        const key = message.orderingKey ?? message.id;
        const lane = lanes.get(key) ?? {
          pending: 0,
          semaphore: Semaphore.makeUnsafe(1),
        };
        lane.pending += 1;
        lanes.set(key, lane);
        sequence += 1;

        const releaseLane = Effect.sync(() => {
          lane.pending -= 1;
          if (lane.pending === 0) lanes.delete(key);
        });
        const handle = execution.withPermit(
          Effect.suspend(() =>
            accepting ? processMessage(message) : settleOrLog(message, "nack"),
          ),
        );
        run(
          `${message.id}:${sequence}`,
          lane.semaphore.withPermit(handle).pipe(Effect.ensuring(releaseLane)),
        );
      };

      const handlers: StreamingPullHandlers = {
        onError: (cause) => {
          Deferred.doneUnsafe(
            sourceFailure,
            Effect.fail(new StreamingPullSourceUnavailable({ cause, operation: "receive" })),
          );
        },
        onMessage: schedule,
      };

      yield* Effect.acquireUseRelease(
        source.start(handlers),
        () =>
          Effect.logInfo(
            `OSFO_AGENT_RUN_WORKER_READY:streaming-pull:${config.executionSlots}`,
          ).pipe(Effect.andThen(Deferred.await(sourceFailure))),
        () =>
          Effect.gen(function* () {
            accepting = false;
            yield* source
              .stop()
              .pipe(
                Effect.catch((cause) => Effect.logError("StreamingPull source stop failed", cause)),
              );
            yield* FiberMap.awaitEmpty(fibers);
            yield* source
              .close()
              .pipe(
                Effect.catch((cause) =>
                  Effect.logError("StreamingPull source close failed", cause),
                ),
              );
          }),
      );
    }),
  );

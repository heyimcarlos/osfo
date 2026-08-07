import { PubSub, type Message } from "@google-cloud/pubsub";
import { AgentRunWorker, decodeRunnableDeliveryData } from "@osfo/agent-run";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const GoogleStreamingPullConfigSchema = Schema.Struct({
  closeTimeoutMs: PositiveInteger,
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
    let subscriptionClose: Promise<unknown> | undefined;

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
        return Effect.gen(function* () {
          subscriptionClose = yield* beginStreamingPullSubscriptionClose(subscription);
          intakeStopped = true;
          yield* Effect.try({
            try: () => {
              if (activeHandlers !== undefined) {
                subscription.removeListener("message", activeHandlers.message);
                subscription.removeListener("error", activeHandlers.error);
                subscription.removeListener("close", activeHandlers.close);
              }
            },
            catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "stop" }),
          });
        });
      });

    const close = () =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        return closeStreamingPullSource(
          stop(),
          { close: () => subscriptionClose ?? subscription.close() },
          client,
          config.closeTimeoutMs,
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
        );
      });

    return StreamingPullSource.of({ close, start, stop });
  });

interface StreamingPullCloseResource {
  readonly close: () => Promise<unknown>;
}

export const beginStreamingPullSubscriptionClose = (subscription: StreamingPullCloseResource) =>
  Effect.try({
    try: () => {
      const closePromise = subscription.close();
      void closePromise.then(undefined, () => undefined);
      return closePromise;
    },
    catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "stop" }),
  });

const closeStreamingPullResource = (
  resourceName: "client" | "subscription",
  resource: StreamingPullCloseResource,
  timeoutMs: number,
) =>
  Effect.tryPromise({
    try: () => resource.close(),
    catch: (cause) => new StreamingPullSourceUnavailable({ cause, operation: "stop" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new StreamingPullSourceUnavailable({
            cause: `${resourceName} close deadline exceeded`,
            operation: "stop",
          }),
        ),
    }),
  );

export const closeStreamingPullResources = (
  subscription: StreamingPullCloseResource,
  client: StreamingPullCloseResource,
  timeoutMs: number,
) =>
  Effect.all(
    [
      closeStreamingPullResource("subscription", subscription, timeoutMs).pipe(Effect.exit),
      closeStreamingPullResource("client", client, timeoutMs).pipe(Effect.exit),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap(([subscriptionExit, clientExit]) => {
      const failures = [
        ...(Exit.isFailure(subscriptionExit)
          ? [{ resource: "subscription" as const, cause: subscriptionExit.cause }]
          : []),
        ...(Exit.isFailure(clientExit)
          ? [{ resource: "client" as const, cause: clientExit.cause }]
          : []),
      ];
      return failures.length === 0
        ? Effect.void
        : Effect.fail(
            new StreamingPullSourceUnavailable({
              cause: { type: "StreamingPullCloseFailures", failures },
              operation: "stop",
            }),
          );
    }),
  );

export const closeStreamingPullSource = (
  stop: Effect.Effect<void, StreamingPullSourceUnavailable>,
  subscription: StreamingPullCloseResource,
  client: StreamingPullCloseResource,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const stopExit = yield* Effect.exit(stop);
    const closeExit = yield* Effect.exit(
      closeStreamingPullResources(subscription, client, timeoutMs),
    );
    if (Exit.isSuccess(stopExit) && Exit.isSuccess(closeExit)) return;
    return yield* new StreamingPullSourceUnavailable({
      cause: { type: "StreamingPullSourceCloseFailures", stopExit, closeExit },
      operation: "stop",
    });
  });

const googleSourceLayer = (config: GoogleStreamingPullConfig) =>
  Layer.effect(
    StreamingPullSource,
    Effect.acquireRelease(makeGoogleSource(config), (source) => source.close().pipe(Effect.orDie)),
  );

export const makeGoogleStreamingPullSourceLayer = (config: GoogleStreamingPullConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(GoogleStreamingPullConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidGoogleStreamingPullConfig({ cause })),
      Effect.map(googleSourceLayer),
    ),
  );

export const StreamingPullWorkerConfigSchema = Schema.Struct({
  drainTimeoutMs: PositiveInteger,
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

export interface StreamingPullWorkerController {
  readonly failStop: (cause: StreamingPullSourceUnavailable) => Effect.Effect<never>;
}

export const makeStreamingPullWorker =
  (controller: StreamingPullWorkerController) =>
  (
    config: StreamingPullWorkerConfig,
  ): Effect.Effect<void, StreamingPullSourceUnavailable, AgentRunWorker | StreamingPullSource> =>
    Effect.gen(function* () {
      const source = yield* StreamingPullSource;
      const execution = yield* Semaphore.make(config.executionSlots);
      const context = yield* Effect.context<AgentRunWorker>();
      const run = Effect.runForkWith(context);
      const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
      let empty = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(empty, Effect.void);
      const sourceFailure = yield* Deferred.make<void, StreamingPullSourceUnavailable>();
      const lanes = new Map<string, OrderingLane>();
      let accepting = true;
      let sequence = 0;

      const awaitEmpty = Effect.suspend(() => Deferred.await(empty));
      const interruptDeliveries = Effect.sync(() => {
        for (const fiber of fibers.values()) fiber.interruptUnsafe();
      });
      const observeSourceOperation = Effect.fn("StreamingPull.observeSourceOperation")(function* (
        operation: Effect.Effect<void, StreamingPullSourceUnavailable>,
        operationName: "close" | "stop",
      ) {
        const completed = Deferred.makeUnsafe<void, StreamingPullSourceUnavailable>();
        run(Effect.exit(operation).pipe(Effect.flatMap((exit) => Deferred.done(completed, exit))));
        const observed = yield* Deferred.await(completed).pipe(
          Effect.exit,
          Effect.timeoutOption(config.drainTimeoutMs),
        );
        if (Option.isNone(observed)) {
          return yield* controller.failStop(
            new StreamingPullSourceUnavailable({
              cause: `StreamingPull source ${operationName} deadline exceeded`,
              operation: "stop",
            }),
          );
        }
        return observed.value;
      });

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
        const fiberKey = `${message.id}:${sequence}`;
        const tracked: Effect.Effect<void, never, AgentRunWorker> = lane.semaphore
          .withPermit(handle)
          .pipe(
            Effect.ensuring(releaseLane),
            Effect.ensuring(
              Effect.sync(() => {
                fibers.delete(fiberKey);
                if (fibers.size === 0) Deferred.doneUnsafe(empty, Effect.void);
              }),
            ),
          );
        run<void, never>(tracked, {
          onFiberStart: (fiber) => {
            if (fibers.size === 0) empty = Deferred.makeUnsafe();
            fibers.set(fiberKey, fiber);
          },
        });
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
            const stopExit = yield* observeSourceOperation(source.stop(), "stop");
            const drained = yield* awaitEmpty.pipe(Effect.timeoutOption(config.drainTimeoutMs));
            let drainFailure: StreamingPullSourceUnavailable | undefined;
            if (Option.isNone(drained)) {
              const forced = yield* interruptDeliveries.pipe(
                Effect.andThen(awaitEmpty),
                Effect.timeoutOption(config.drainTimeoutMs),
              );
              if (Option.isNone(forced)) {
                drainFailure = new StreamingPullSourceUnavailable({
                  cause: "AgentRun delivery drain did not settle after forced interruption",
                  operation: "stop",
                });
              }
            }
            const closeExit = yield* observeSourceOperation(source.close(), "close");
            if (drainFailure !== undefined) return yield* controller.failStop(drainFailure);
            if (Exit.isFailure(stopExit) || Exit.isFailure(closeExit)) {
              return yield* controller.failStop(
                new StreamingPullSourceUnavailable({
                  cause: { type: "StreamingPullShutdownFailure", stopExit, closeExit },
                  operation: "stop",
                }),
              );
            }
          }),
      );
    });

const productionStreamingPullController: StreamingPullWorkerController = {
  failStop: (cause) =>
    Effect.logFatal("StreamingPull shutdown could not release owned resources", cause).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.abort();
        }),
      ),
    ),
};

export const runStreamingPullWorker = makeStreamingPullWorker(productionStreamingPullController);

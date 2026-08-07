import { NodeRuntime } from "@effect/platform-node";
import { AgentRunWorker } from "@osfo/agent-run";
import { Deferred, Effect, Layer } from "effect";
import { runStreamingPullWorker, StreamingPullSource } from "../../dist/streaming-pull.js";

const delivery = {
  version: 1,
  deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  threadId: "512e5093-0051-4f82-b452-78d907ead08c",
  executionProfileRef: "oz.deterministic.v1",
};
const handlerStarted = Deferred.makeUnsafe();
const sourceLayer = Layer.succeed(
  StreamingPullSource,
  StreamingPullSource.of({
    start: (handlers) =>
      Effect.sync(() => {
        handlers.onMessage({
          data: Buffer.from(JSON.stringify(delivery)),
          id: delivery.deliveryId,
          orderingKey: delivery.threadId,
          acknowledge: () => undefined,
          nack: () => undefined,
        });
      }),
    stop: () => Effect.void,
    close: () => Effect.void,
  }),
);
const workerLayer = Layer.succeed(
  AgentRunWorker,
  AgentRunWorker.of({
    handle: () =>
      Deferred.succeed(handlerStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.uninterruptible,
      ),
  }),
);
const ready = Deferred.await(handlerStarted).pipe(
  Effect.andThen(Effect.logInfo("STUCK_STREAMING_PULL_READY")),
  Effect.andThen(Effect.never),
);
const program = Effect.all(
  [runStreamingPullWorker({ drainTimeoutMs: 50, executionSlots: 1 }), ready],
  { concurrency: 2, discard: true },
).pipe(Effect.provide(workerLayer), Effect.provide(sourceLayer));

NodeRuntime.runMain(program);

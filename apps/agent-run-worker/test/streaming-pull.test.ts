import {
  AgentRunWorker,
  type AgentRunWorkerDisposition,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import {
  runStreamingPullWorker,
  StreamingPullSource,
  type StreamingPullHandlers,
  type StreamingPullMessage,
} from "../src/streaming-pull.js";

const deliveries = {
  completed: {
    version: 1,
    deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
    agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
    threadId: "512e5093-0051-4f82-b452-78d907ead08c",
    executionProfileRef: "oz.deterministic.v1",
  },
  retry: {
    version: 1,
    deliveryId: "c742c788-d93d-46da-bfdf-ddea5030ce03",
    agentRunId: "dd5d9a2b-90a8-4404-848d-55390a34104d",
    threadId: "38b28545-562c-44e9-a967-c46c5391e8a0",
    executionProfileRef: "oz.deterministic.v1",
  },
} as const;

const makeMessage = (id: string, value: unknown, orderingKey: string | undefined = id) => {
  const acknowledged = Deferred.makeUnsafe<void>();
  const nacked = Deferred.makeUnsafe<void>();
  const message: StreamingPullMessage = {
    data: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    id,
    orderingKey,
    acknowledge: () => {
      Deferred.doneUnsafe(acknowledged, Effect.void);
    },
    nack: () => {
      Deferred.doneUnsafe(nacked, Effect.void);
    },
  };
  return { acknowledged, message, nacked };
};

const makeSource = () => {
  const started = Deferred.makeUnsafe<void>();
  const stopped = Deferred.makeUnsafe<void>();
  const closed = Deferred.makeUnsafe<void>();
  const events: Array<string> = [];
  let handlers: StreamingPullHandlers | undefined;
  const source = StreamingPullSource.of({
    start: (value) =>
      Effect.sync(() => {
        handlers = value;
        events.push("receiving");
        Deferred.doneUnsafe(started, Effect.void);
      }),
    stop: () =>
      Effect.sync(() => {
        events.push("receiving-stopped");
        Deferred.doneUnsafe(stopped, Effect.void);
      }),
    close: () =>
      Effect.sync(() => {
        events.push("client-closed");
        Deferred.doneUnsafe(closed, Effect.void);
      }),
  });
  const emit = (message: StreamingPullMessage) =>
    Effect.sync(() => {
      handlers?.onMessage(message);
    });
  const fail = (cause: unknown) =>
    Effect.sync(() => {
      handlers?.onError(cause);
    });
  return { closed, emit, events, fail, source, started, stopped };
};

const runWorker = (
  source: StreamingPullSource["Service"],
  handle: (delivery: RunnableAgentRunDelivery) => Effect.Effect<AgentRunWorkerDisposition>,
  executionSlots: number,
) =>
  runStreamingPullWorker({ executionSlots }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(StreamingPullSource, source),
        Layer.succeed(AgentRunWorker, AgentRunWorker.of({ handle })),
      ),
    ),
  );

describe("StreamingPull AgentRun delivery", () => {
  it.effect("acknowledges durable terminal outcomes and nacks retryable or invalid work", () =>
    Effect.gen(function* () {
      const source = makeSource();
      const completed = makeMessage("completed", deliveries.completed);
      const alreadyTerminal = makeMessage("already-terminal", {
        ...deliveries.completed,
        deliveryId: "ece30e84-696f-490e-ac4e-3cb688ee8b4a",
      });
      const retry = makeMessage("retry", deliveries.retry);
      const invalid = makeMessage("invalid", "not-json");
      let calls = 0;
      const running = yield* Effect.forkChild(
        runWorker(
          source.source,
          (delivery) => {
            calls += 1;
            return Effect.succeed(
              delivery.agentRunId === deliveries.retry.agentRunId
                ? { type: "retry" as const }
                : {
                    type: "acknowledge" as const,
                    outcome: calls === 1 ? ("succeeded" as const) : ("alreadyTerminal" as const),
                  },
            );
          },
          32,
        ),
      );
      yield* Deferred.await(source.started);
      yield* source.emit(completed.message);
      yield* source.emit(alreadyTerminal.message);
      yield* source.emit(retry.message);
      yield* source.emit(invalid.message);

      yield* Effect.all([
        Deferred.await(completed.acknowledged),
        Deferred.await(alreadyTerminal.acknowledged),
        Deferred.await(retry.nacked),
        Deferred.await(invalid.nacked),
      ]);
      expect(calls).toBe(3);
      yield* Fiber.interrupt(running);
    }),
  );

  it.effect("bounds concurrent execution independently of subscriber flow control", () =>
    Effect.gen(function* () {
      const source = makeSource();
      const release = yield* Deferred.make<void>();
      const twoStarted = yield* Deferred.make<void>();
      const messages = [
        makeMessage("one", deliveries.completed),
        makeMessage("two", { ...deliveries.completed, deliveryId: deliveries.retry.deliveryId }),
        makeMessage("three", {
          ...deliveries.completed,
          deliveryId: "ece30e84-696f-490e-ac4e-3cb688ee8b4a",
        }),
      ];
      let active = 0;
      let maximum = 0;
      let started = 0;
      const running = yield* Effect.forkChild(
        runWorker(
          source.source,
          () =>
            Effect.gen(function* () {
              active += 1;
              started += 1;
              maximum = Math.max(maximum, active);
              if (started === 2) yield* Deferred.succeed(twoStarted, undefined);
              yield* Deferred.await(release);
              active -= 1;
              return { type: "acknowledge" as const, outcome: "succeeded" as const };
            }),
          2,
        ),
      );
      yield* Deferred.await(source.started);
      for (const message of messages) yield* source.emit(message.message);
      yield* Deferred.await(twoStarted);
      yield* Effect.yieldNow;
      expect(started).toBe(2);
      expect(maximum).toBe(2);

      yield* Deferred.succeed(release, undefined);
      yield* Effect.all(messages.map((message) => Deferred.await(message.acknowledged)));
      expect(started).toBe(3);
      expect(maximum).toBe(2);
      yield* Fiber.interrupt(running);
    }),
  );

  it.effect("serializes messages that share an ordering key", () =>
    Effect.gen(function* () {
      const source = makeSource();
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const first = makeMessage("one", deliveries.completed, "thread-a");
      const second = makeMessage(
        "two",
        { ...deliveries.completed, deliveryId: deliveries.retry.deliveryId },
        "thread-a",
      );
      let calls = 0;
      const running = yield* Effect.forkChild(
        runWorker(
          source.source,
          () =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              } else {
                yield* Deferred.succeed(secondStarted, undefined);
              }
              return { type: "acknowledge" as const, outcome: "succeeded" as const };
            }),
          2,
        ),
      );
      yield* Deferred.await(source.started);
      yield* source.emit(first.message);
      yield* source.emit(second.message);
      yield* Deferred.await(firstStarted);
      yield* Effect.yieldNow;
      expect(calls).toBe(1);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondStarted);
      yield* Effect.all([Deferred.await(first.acknowledged), Deferred.await(second.acknowledged)]);
      expect(calls).toBe(2);
      yield* Fiber.interrupt(running);
    }),
  );

  it.effect("stops intake and new claims before draining active work", () =>
    Effect.gen(function* () {
      const source = makeSource();
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const first = makeMessage("one", deliveries.completed, "thread-a");
      const queued = makeMessage("two", deliveries.retry, "thread-b");
      let calls = 0;
      const running = yield* Effect.forkChild(
        runWorker(
          source.source,
          () =>
            Effect.gen(function* () {
              calls += 1;
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
              return { type: "acknowledge" as const, outcome: "succeeded" as const };
            }),
          1,
        ),
      );
      yield* Deferred.await(source.started);
      yield* source.emit(first.message);
      yield* source.emit(queued.message);
      yield* Deferred.await(firstStarted);

      const shutdown = yield* Effect.forkChild(Fiber.interrupt(running));
      yield* Deferred.await(source.stopped);
      expect(source.events).toEqual(["receiving", "receiving-stopped"]);
      expect(yield* Deferred.isDone(source.closed)).toBe(false);
      expect(calls).toBe(1);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Effect.all([Deferred.await(first.acknowledged), Deferred.await(queued.nacked)]);
      yield* Fiber.join(shutdown);
      yield* Deferred.await(source.closed);
      expect(source.events).toEqual(["receiving", "receiving-stopped", "client-closed"]);
      expect(calls).toBe(1);
    }),
  );

  it.effect("fails the ready worker when StreamingPull closes fatally", () =>
    Effect.gen(function* () {
      const source = makeSource();
      const running = yield* Effect.forkChild(
        runWorker(
          source.source,
          () => Effect.succeed({ type: "acknowledge" as const, outcome: "succeeded" as const }),
          1,
        ),
      );
      yield* Deferred.await(source.started);

      yield* source.fail("subscriber closed");
      const exit = yield* Fiber.await(running).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die("ready worker stayed alive after fatal StreamingPull closure"),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(source.events).toEqual(["receiving", "receiving-stopped", "client-closed"]);
    }),
  );
});

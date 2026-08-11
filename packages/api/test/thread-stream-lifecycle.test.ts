import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Latch, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  ConnectionLimitExceeded,
  ThreadResumeUnavailable,
  ThreadStreamLifecycle,
  makeThreadStreamLifecycleLayer,
  type ThreadStreamLifecycleService,
} from "../src/index.js";
import { makeThreadStreamLifecycleTestLayer } from "../src/testing.js";
import type { ThreadStreamEvent } from "../src/index.js";

const checkpoint = (position: string): ThreadStreamEvent => ({
  event: "caught_up",
  data: { throughPosition: position, throughCursor: `cursor-${position}` },
});

const config = {
  maxBufferedAgeMs: 100,
  maxBufferedBytes: 1_024,
  maxBufferedEvents: 2,
  maxConnectionLifetimeMs: 1_000,
  maxConnections: 1,
};

const collectRequest = (
  lifecycle: ThreadStreamLifecycleService,
  source: Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stream = yield* lifecycle.open(source);
      return yield* Stream.runCollect(stream);
    }),
  );

describe("Thread stream lifecycle", () => {
  it.effect("releases a reserved slot when stream protection fails", () =>
    Effect.gen(function* () {
      const failFirstProtection = yield* Ref.make(true);
      yield* Effect.gen(function* () {
        const lifecycle = yield* ThreadStreamLifecycle;

        const failure = yield* Effect.scoped(lifecycle.open(Stream.never)).pipe(Effect.flip);
        expect(failure).toEqual(new ThreadResumeUnavailable());
        expect((yield* lifecycle.status).activeConnections).toBe(0);

        expect(Array.from(yield* collectRequest(lifecycle, Stream.make(checkpoint("1"))))).toEqual([
          checkpoint("1"),
        ]);
        expect((yield* lifecycle.status).activeConnections).toBe(0);
      }).pipe(
        Effect.provide(
          makeThreadStreamLifecycleTestLayer(config, {
            beforeProtect: Ref.getAndSet(failFirstProtection, false).pipe(
              Effect.flatMap((fail) =>
                fail ? Effect.fail(new ThreadResumeUnavailable()) : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
  );

  it.effect("releases a reserved slot when the authorized stream handshake is interrupted", () =>
    Effect.gen(function* () {
      const blockFirstProtection = yield* Ref.make(true);
      const protectionStarted = yield* Latch.make();
      yield* Effect.gen(function* () {
        const lifecycle = yield* ThreadStreamLifecycle;
        const opening = yield* Effect.scoped(lifecycle.open(Stream.never)).pipe(Effect.forkChild);

        yield* protectionStarted.await;
        expect((yield* lifecycle.status).activeConnections).toBe(1);
        yield* Fiber.interrupt(opening);
        expect((yield* lifecycle.status).activeConnections).toBe(0);

        expect(Array.from(yield* collectRequest(lifecycle, Stream.make(checkpoint("1"))))).toEqual([
          checkpoint("1"),
        ]);
        expect((yield* lifecycle.status).activeConnections).toBe(0);
      }).pipe(
        Effect.provide(
          makeThreadStreamLifecycleTestLayer(config, {
            beforeProtect: Ref.getAndSet(blockFirstProtection, false).pipe(
              Effect.flatMap((block) =>
                block ? protectionStarted.open.pipe(Effect.andThen(Effect.never)) : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
  );

  it.effect("terminates a started producer when stream handoff is interrupted", () =>
    Effect.gen(function* () {
      const handoffStarted = yield* Latch.make();
      const sourceFinalized = yield* Latch.make();
      yield* Effect.gen(function* () {
        const lifecycle = yield* ThreadStreamLifecycle;
        const opening = yield* Effect.scoped(
          lifecycle.open(Stream.never.pipe(Stream.ensuring(sourceFinalized.open))),
        ).pipe(Effect.forkChild);

        yield* handoffStarted.await;
        yield* Fiber.interrupt(opening);
        yield* sourceFinalized.await.pipe(Effect.timeout("1 second"));

        expect((yield* lifecycle.status).activeConnections).toBe(0);
      }).pipe(
        Effect.provide(
          makeThreadStreamLifecycleTestLayer(config, {
            afterProducerFork: handoffStarted.open.pipe(Effect.andThen(Effect.never)),
            beforeProtect: Effect.void,
          }),
        ),
      );
    }),
  );

  it.effect("releases a discarded open when its request scope is interrupted", () =>
    Effect.gen(function* () {
      const opened = yield* Latch.make();
      const sourceFinalized = yield* Latch.make();
      const lifecycle = yield* ThreadStreamLifecycle;
      const request = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lifecycle
            .open(Stream.never.pipe(Stream.ensuring(sourceFinalized.open)))
            .pipe(Effect.asVoid);
          yield* opened.open;
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);

      yield* opened.await;
      expect((yield* lifecycle.status).activeConnections).toBe(1);
      yield* Fiber.interrupt(request);
      yield* sourceFinalized.await.pipe(Effect.timeout("1 second"));
      expect((yield* lifecycle.status).activeConnections).toBe(0);

      expect(Array.from(yield* collectRequest(lifecycle, Stream.make(checkpoint("1"))))).toEqual([
        checkpoint("1"),
      ]);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("rejects excess connections before streaming and releases the slot on close", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const offered = yield* Latch.make();
      const running = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* lifecycle.open(
            Stream.make(checkpoint("0")).pipe(Stream.concat(Stream.never)),
          );
          yield* first.pipe(
            Stream.tap(() => offered.open),
            Stream.runDrain,
          );
        }),
      ).pipe(Effect.forkChild);
      yield* offered.await;

      const rejected = yield* Effect.scoped(lifecycle.open(Stream.never)).pipe(Effect.flip);
      expect(rejected).toEqual(new ConnectionLimitExceeded({ retryAfterSeconds: 5 }));
      expect((yield* lifecycle.status).activeConnections).toBe(1);

      yield* Fiber.interrupt(running);
      expect((yield* lifecycle.status).activeConnections).toBe(0);

      expect(Array.from(yield* collectRequest(lifecycle, Stream.make(checkpoint("0"))))).toEqual([
        checkpoint("0"),
      ]);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("closes only the slow stream when its event buffer is full", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const allowHealthyEvent = yield* Latch.make();
      const healthyEventSeen = yield* Latch.make();
      const healthyFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const healthyStream = yield* lifecycle.open(
            Stream.fromEffectDrain(allowHealthyEvent.await).pipe(
              Stream.concat(Stream.make(checkpoint("9"))),
              Stream.concat(Stream.never),
            ),
          );
          yield* healthyStream.pipe(
            Stream.tap(() => healthyEventSeen.open),
            Stream.runDrain,
          );
        }),
      ).pipe(Effect.forkChild);
      const allowBurst = yield* Latch.make();
      const burstFinished = yield* Latch.make();
      const slowOpened = yield* Latch.make();
      const startSlowConsumer = yield* Latch.make();
      const slowFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const protectedStream = yield* lifecycle.open(
            Stream.make(checkpoint("1")).pipe(
              Stream.concat(
                Stream.fromEffectDrain(allowBurst.await).pipe(
                  Stream.concat(Stream.make(checkpoint("2"), checkpoint("3"), checkpoint("4"))),
                ),
              ),
              Stream.ensuring(burstFinished.open),
            ),
          );
          yield* slowOpened.open;
          yield* startSlowConsumer.await;
          return yield* Stream.runCollect(protectedStream);
        }),
      ).pipe(Effect.forkChild);
      yield* slowOpened.await;
      yield* allowBurst.open;
      yield* burstFinished.await;
      yield* startSlowConsumer.open;
      const delivered = Array.from(yield* Fiber.join(slowFiber));

      expect(
        delivered.map((event) =>
          event.event === "caught_up" ? event.data.throughPosition : "thread_event",
        ),
      ).toEqual(delivered.map((_, index) => String(index + 1)));
      expect(delivered).not.toContainEqual(checkpoint("4"));
      expect((yield* lifecycle.status).slowConsumerCloses).toBe(1);
      expect((yield* lifecycle.status).activeConnections).toBe(1);
      yield* allowHealthyEvent.open;
      yield* healthyEventSeen.await;
      expect((yield* lifecycle.status).activeConnections).toBe(1);
      yield* Fiber.interrupt(healthyFiber);
      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(
      Effect.provide(
        makeThreadStreamLifecycleLayer({
          ...config,
          maxBufferedEvents: 1,
          maxConnections: 2,
        }),
      ),
    ),
  );

  it.effect("closes a stream whose unsent bytes exceed its bound", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      expect(Array.from(yield* collectRequest(lifecycle, Stream.make(checkpoint("1"))))).toEqual(
        [],
      );
      expect((yield* lifecycle.status).slowConsumerCloses).toBe(1);
    }).pipe(
      Effect.provide(
        makeThreadStreamLifecycleLayer({
          ...config,
          maxBufferedBytes: 1,
        }),
      ),
    ),
  );

  it.live("closes when the oldest unsent event reaches its age bound", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const allowSecond = yield* Latch.make();
      const opened = yield* Latch.make();
      const startConsumer = yield* Latch.make();
      const request = yield* Effect.scoped(
        Effect.gen(function* () {
          const protectedStream = yield* lifecycle.open(
            Stream.make(checkpoint("1")).pipe(
              Stream.concat(
                Stream.fromEffectDrain(allowSecond.await).pipe(
                  Stream.concat(Stream.make(checkpoint("2"))),
                  Stream.concat(Stream.never),
                ),
              ),
            ),
          );
          yield* opened.open;
          yield* startConsumer.await;
          return yield* Stream.runCollect(protectedStream);
        }),
      ).pipe(Effect.forkChild);
      yield* opened.await;
      yield* allowSecond.open;
      yield* Effect.sleep(config.maxBufferedAgeMs * 2);
      yield* startConsumer.open;
      const delivered = Array.from(yield* Fiber.join(request));

      expect(delivered).toEqual([checkpoint("1")]);
      expect((yield* lifecycle.status).slowConsumerCloses).toBe(1);
      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("drains active streams and rejects new streams until process replacement", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const opened = yield* Latch.make();
      const running = yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* lifecycle.open(Stream.never);
          yield* opened.open;
          yield* Stream.runDrain(stream);
        }),
      ).pipe(Effect.forkChild);

      yield* opened.await;
      yield* lifecycle.drain;
      yield* Fiber.join(running);
      expect(yield* lifecycle.status).toMatchObject({ accepting: false, activeConnections: 0 });

      const rejected = yield* Effect.scoped(lifecycle.open(Stream.never)).pipe(Effect.flip);
      expect(rejected).toEqual(new ThreadResumeUnavailable());
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("waits for source and consumer finalization before drain returns", () =>
    Effect.gen(function* () {
      const allowSourceFinalizer = yield* Latch.make();
      const consumerFinalized = yield* Latch.make();
      const sourceStarted = yield* Latch.make();
      const sourceFinalizerStarted = yield* Latch.make();
      const lifecycle = yield* ThreadStreamLifecycle;
      const consumer = yield* Effect.scoped(
        Effect.gen(function* () {
          const protectedStream = yield* lifecycle.open(
            Stream.fromEffectDrain(sourceStarted.open).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(
                sourceFinalizerStarted.open.pipe(Effect.andThen(allowSourceFinalizer.await)),
              ),
            ),
          );
          yield* protectedStream.pipe(Stream.ensuring(consumerFinalized.open), Stream.runDrain);
        }),
      ).pipe(Effect.forkChild);
      yield* sourceStarted.await;
      const draining = yield* lifecycle.drain.pipe(Effect.forkChild);

      yield* sourceFinalizerStarted.await;
      yield* consumerFinalized.await;
      const drainIsWaiting = draining.pollUnsafe() === undefined;
      const requestIsWaitingForSource = consumer.pollUnsafe() === undefined;
      const activeConnections = (yield* lifecycle.status).activeConnections;

      yield* allowSourceFinalizer.open;
      yield* Fiber.join(draining);
      yield* Fiber.join(consumer);
      expect(drainIsWaiting).toBe(true);
      expect(requestIsWaitingForSource).toBe(true);
      expect(activeConnections).toBe(1);
      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("waits for the outer transport consumer scope before drain returns", () =>
    Effect.gen(function* () {
      const allowTransportFinalizer = yield* Latch.make();
      const transportFinalizerStarted = yield* Latch.make();
      const lifecycle = yield* ThreadStreamLifecycle;
      const consumer = yield* Effect.scoped(
        Effect.gen(function* () {
          const protectedStream = yield* lifecycle.open(Stream.never);
          yield* protectedStream.pipe(
            Stream.ensuring(
              transportFinalizerStarted.open.pipe(Effect.andThen(allowTransportFinalizer.await)),
            ),
            Stream.runDrain,
          );
        }),
      ).pipe(Effect.forkChild);
      const draining = yield* lifecycle.drain.pipe(Effect.forkChild);

      yield* transportFinalizerStarted.await;
      const drainIsWaiting = draining.pollUnsafe() === undefined;
      const activeConnections = (yield* lifecycle.status).activeConnections;

      yield* allowTransportFinalizer.open;
      yield* Fiber.join(draining);
      yield* Fiber.join(consumer);
      expect(drainIsWaiting).toBe(true);
      expect(activeConnections).toBe(1);
      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("propagates an established stream failure from its durable source", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const failSource = yield* Latch.make();
      const request = yield* Effect.scoped(
        Effect.gen(function* () {
          const protectedStream = yield* lifecycle.open(
            Stream.make(checkpoint("1")).pipe(
              Stream.concat(
                Stream.fromEffect(
                  failSource.await.pipe(Effect.andThen(Effect.fail(new ThreadResumeUnavailable()))),
                ),
              ),
            ),
          );
          return yield* Stream.runCollect(protectedStream).pipe(Effect.flip);
        }),
      ).pipe(Effect.forkChild);
      yield* failSource.open;
      const failure = yield* Fiber.join(request);

      expect(failure).toEqual(new ThreadResumeUnavailable());
      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("closes a stream at its configured maximum lifetime", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const running = yield* Effect.scoped(
        lifecycle.open(Stream.never).pipe(Effect.flatMap(Stream.runDrain)),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(config.maxConnectionLifetimeMs);
      yield* Fiber.join(running);

      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );
});

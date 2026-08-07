import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Latch, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  ConnectionLimitExceeded,
  ThreadResumeUnavailable,
  ThreadStreamLifecycle,
  makeThreadStreamLifecycleLayer,
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

describe("Thread stream lifecycle", () => {
  it.effect("releases a reserved slot when stream protection fails", () =>
    Effect.gen(function* () {
      const failFirstProtection = yield* Ref.make(true);
      yield* Effect.gen(function* () {
        const lifecycle = yield* ThreadStreamLifecycle;

        const failure = yield* lifecycle.open(Stream.never).pipe(Effect.flip);
        expect(failure).toEqual(new ThreadResumeUnavailable());
        expect((yield* lifecycle.status).activeConnections).toBe(0);

        const replacement = yield* lifecycle.open(Stream.make(checkpoint("1")));
        expect(Array.from(yield* Stream.runCollect(replacement))).toEqual([checkpoint("1")]);
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
        const opening = yield* lifecycle.open(Stream.never).pipe(Effect.forkChild);

        yield* protectionStarted.await;
        expect((yield* lifecycle.status).activeConnections).toBe(1);
        yield* Fiber.interrupt(opening);
        expect((yield* lifecycle.status).activeConnections).toBe(0);

        const replacement = yield* lifecycle.open(Stream.make(checkpoint("1")));
        expect(Array.from(yield* Stream.runCollect(replacement))).toEqual([checkpoint("1")]);
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

  it.effect("rejects excess connections before streaming and releases the slot on close", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const first = yield* lifecycle.open(
        Stream.make(checkpoint("0")).pipe(Stream.concat(Stream.never)),
      );

      const rejected = yield* lifecycle.open(Stream.never).pipe(Effect.flip);
      expect(rejected).toEqual(new ConnectionLimitExceeded({ retryAfterSeconds: 5 }));
      expect((yield* lifecycle.status).activeConnections).toBe(1);

      const offered = yield* Latch.make();
      const running = yield* first.pipe(
        Stream.tap(() => offered.open),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* offered.await;
      yield* Fiber.interrupt(running);
      expect((yield* lifecycle.status).activeConnections).toBe(0);

      const replacement = yield* lifecycle.open(Stream.make(checkpoint("0")));
      expect(Array.from(yield* Stream.runCollect(replacement))).toEqual([checkpoint("0")]);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("closes only the slow stream when its event buffer is full", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const allowHealthyEvent = yield* Latch.make();
      const healthyEventSeen = yield* Latch.make();
      const healthyStream = yield* lifecycle.open(
        Stream.fromEffectDrain(allowHealthyEvent.await).pipe(
          Stream.concat(Stream.make(checkpoint("9"))),
          Stream.concat(Stream.never),
        ),
      );
      const healthyFiber = yield* healthyStream.pipe(
        Stream.tap(() => healthyEventSeen.open),
        Stream.runDrain,
        Effect.forkChild,
      );
      const allowBurst = yield* Latch.make();
      const protectedStream = yield* lifecycle.open(
        Stream.make(checkpoint("1")).pipe(
          Stream.concat(
            Stream.fromEffectDrain(allowBurst.await).pipe(
              Stream.concat(Stream.make(checkpoint("2"), checkpoint("3"), checkpoint("4"))),
            ),
          ),
        ),
      );
      yield* allowBurst.open;
      while ((yield* lifecycle.status).slowConsumerCloses === 0) yield* Effect.yieldNow;
      const delivered = Array.from(yield* Stream.runCollect(protectedStream));

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
      const protectedStream = yield* lifecycle.open(Stream.make(checkpoint("1")));

      expect(Array.from(yield* Stream.runCollect(protectedStream))).toEqual([]);
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
      yield* allowSecond.open;
      yield* Effect.gen(function* () {
        while ((yield* lifecycle.status).slowConsumerCloses === 0) {
          yield* Effect.sleep(10);
        }
      }).pipe(Effect.timeout(config.maxBufferedAgeMs * 5));
      expect((yield* lifecycle.status).slowConsumerCloses).toBe(1);
      const delivered = Array.from(yield* Stream.runCollect(protectedStream));

      expect(delivered).toEqual([checkpoint("1")]);
      expect((yield* lifecycle.status).slowConsumerCloses).toBe(1);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("drains active streams and rejects new streams until process replacement", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const protectedStream = yield* lifecycle.open(Stream.never);
      const running = yield* protectedStream.pipe(Stream.runDrain, Effect.forkChild);

      yield* lifecycle.drain;
      yield* Fiber.join(running);
      expect(yield* lifecycle.status).toMatchObject({ accepting: false, activeConnections: 0 });

      const rejected = yield* lifecycle.open(Stream.never).pipe(Effect.flip);
      expect(rejected).toEqual(new ThreadResumeUnavailable());
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect(
    "closes an established stream cleanly when its durable source becomes unavailable",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ThreadStreamLifecycle;
        const failSource = yield* Latch.make();
        const protectedStream = yield* lifecycle.open(
          Stream.make(checkpoint("1")).pipe(
            Stream.concat(
              Stream.fromEffect(
                failSource.await.pipe(Effect.andThen(Effect.fail(new ThreadResumeUnavailable()))),
              ),
            ),
          ),
        );
        yield* failSource.open;
        while ((yield* lifecycle.status).activeConnections > 0) yield* Effect.yieldNow;

        expect(Array.from(yield* Stream.runCollect(protectedStream))).toEqual([]);
        expect((yield* lifecycle.status).activeConnections).toBe(0);
      }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );

  it.effect("closes a stream at its configured maximum lifetime", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadStreamLifecycle;
      const protectedStream = yield* lifecycle.open(Stream.never);
      const running = yield* protectedStream.pipe(Stream.runDrain, Effect.forkChild);

      yield* TestClock.adjust(config.maxConnectionLifetimeMs);
      yield* Fiber.join(running);

      expect((yield* lifecycle.status).activeConnections).toBe(0);
    }).pipe(Effect.provide(makeThreadStreamLifecycleLayer(config))),
  );
});

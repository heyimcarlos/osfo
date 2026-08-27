/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makeMemoryProviderReconciliationQueue } from "./memory-provider-reconciliation-queue";

it.effect("serializes reconciliation in arrival order and continues after failure", () =>
  Effect.gen(function* () {
    const queue = makeMemoryProviderReconciliationQueue();
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const events: Array<string> = [];

    const first = yield* queue
      .run(
        Effect.gen(function* () {
          events.push("first:start");
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(releaseFirst);
          events.push("first:failure");
          return yield* Effect.fail("first failed" as const);
        }),
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(firstStarted);

    const second = yield* queue
      .run(Effect.sync(() => events.push("second")))
      .pipe(Effect.forkChild);
    const third = yield* queue.run(Effect.sync(() => events.push("third"))).pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    expect(events).toEqual(["first:start"]);
    yield* Deferred.succeed(releaseFirst, undefined);
    const firstExit = yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Fiber.join(third);

    expect(Exit.isFailure(firstExit)).toBe(true);
    expect(events).toEqual(["first:start", "first:failure", "second", "third"]);
  }),
);

it.effect("removes an interrupted waiter without interrupting later reconciliation", () =>
  Effect.gen(function* () {
    const queue = makeMemoryProviderReconciliationQueue();
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const events: Array<string> = [];

    const first = yield* queue
      .run(
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.andThen(Effect.sync(() => events.push("first"))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted);

    const interrupted = yield* queue
      .run(Effect.sync(() => events.push("interrupted")))
      .pipe(Effect.forkChild);
    const later = yield* queue.run(Effect.sync(() => events.push("later"))).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(interrupted);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(later);

    expect(events).toEqual(["first", "later"]);
  }),
);

it.effect("releases the permit when running reconciliation is interrupted", () =>
  Effect.gen(function* () {
    const queue = makeMemoryProviderReconciliationQueue();
    const started = yield* Deferred.make<void>();
    const events: Array<string> = [];

    const running = yield* queue
      .run(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => events.push("interrupted"))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const later = yield* queue.run(Effect.sync(() => events.push("later"))).pipe(Effect.forkChild);

    yield* Fiber.interrupt(running);
    yield* Fiber.join(later);

    expect(events).toEqual(["interrupted", "later"]);
  }),
);

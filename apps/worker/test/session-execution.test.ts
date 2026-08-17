import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";

import { makeSessionExecution } from "../src/agents/osfo/session-execution";

describe("Agent Session execution", () => {
  it.effect("waits for Think to become idle before Session-changing work", () =>
    Effect.gen(function* () {
      let hasPendingOrRunning = true;
      const inspected: Array<boolean> = [];
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.sync(() => {
          inspected.push(hasPendingOrRunning);
          return hasPendingOrRunning;
        }),
      });
      const replacementStarted = yield* Deferred.make<void>();
      const replacement = yield* execution
        .runWhenIdle(Deferred.succeed(replacementStarted, undefined))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(Option.isNone(yield* Deferred.poll(replacementStarted))).toBe(true);

      hasPendingOrRunning = false;
      yield* execution.submissionChanged;
      yield* Fiber.join(replacement);

      expect(inspected).toEqual([true, false]);
      expect(Option.isSome(yield* Deferred.poll(replacementStarted))).toBe(true);
    }),
  );

  it.effect("rechecks Think after every status notification", () =>
    Effect.gen(function* () {
      let hasPendingOrRunning = true;
      let inspections = 0;
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.sync(() => {
          inspections += 1;
          return hasPendingOrRunning;
        }),
      });
      const replacementStarted = yield* Deferred.make<void>();
      const replacement = yield* execution
        .runWhenIdle(Deferred.succeed(replacementStarted, undefined))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* execution.submissionChanged;
      yield* Effect.yieldNow;
      expect(inspections).toBe(2);
      expect(Option.isNone(yield* Deferred.poll(replacementStarted))).toBe(true);

      hasPendingOrRunning = false;
      yield* execution.submissionChanged;
      yield* Fiber.join(replacement);
      expect(inspections).toBe(3);
    }),
  );

  it.effect("rechecks when Think changes during an in-flight idle inspection", () =>
    Effect.gen(function* () {
      const inspectionStarted = yield* Deferred.make<void>();
      const releaseInspection = yield* Deferred.make<void>();
      const secondInspectionStarted = yield* Deferred.make<void>();
      let inspections = 0;
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.sync(() => {
          inspections += 1;
          return inspections;
        }).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Deferred.succeed(inspectionStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseInspection)),
                  Effect.as(true),
                )
              : Deferred.succeed(secondInspectionStarted, undefined).pipe(Effect.as(false)),
          ),
        ),
      });
      const replacement = yield* execution
        .runWhenIdle(Effect.succeed("replaced"))
        .pipe(Effect.forkChild);
      yield* Deferred.await(inspectionStarted);

      yield* execution.submissionChanged;
      yield* Deferred.succeed(releaseInspection, undefined);
      yield* Effect.yieldNow;
      const rechecked = Option.isSome(yield* Deferred.poll(secondInspectionStarted));
      if (!rechecked) yield* execution.submissionChanged;

      expect(yield* Fiber.join(replacement)).toBe("replaced");
      expect(rechecked).toBe(true);
      expect(inspections).toBe(2);
    }),
  );

  it.effect("does not make ordinary admission wait for Think to be idle", () =>
    Effect.gen(function* () {
      let inspected = false;
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.sync(() => {
          inspected = true;
          return true;
        }),
      });

      expect(yield* execution.run(Effect.succeed("admitted"))).toBe("admitted");
      expect(inspected).toBe(false);
    }),
  );

  it.effect("keeps later ordinary admission behind a waiting Session replacement", () =>
    Effect.gen(function* () {
      let hasPendingOrRunning = true;
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.sync(() => hasPendingOrRunning),
      });
      const replacementWaiting = yield* Deferred.make<void>();
      const replacementRelease = yield* Deferred.make<void>();
      const ordinaryStarted = yield* Deferred.make<void>();
      const order: Array<string> = [];

      const replacement = yield* execution
        .runWhenIdle(
          Deferred.succeed(replacementWaiting, undefined).pipe(
            Effect.andThen(Deferred.await(replacementRelease)),
            Effect.tap(() => Effect.sync(() => order.push("replacement"))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const ordinary = yield* execution
        .run(
          Deferred.succeed(ordinaryStarted, undefined).pipe(
            Effect.tap(() => Effect.sync(() => order.push("ordinary"))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Deferred.poll(ordinaryStarted))).toBe(true);

      hasPendingOrRunning = false;
      yield* execution.submissionChanged;
      yield* Deferred.await(replacementWaiting);
      expect(Option.isNone(yield* Deferred.poll(ordinaryStarted))).toBe(true);

      yield* Deferred.succeed(replacementRelease, undefined);
      yield* Fiber.join(replacement);
      yield* Fiber.join(ordinary);
      expect(order).toEqual(["replacement", "ordinary"]);
    }),
  );

  it.effect("propagates Think inspection failures without running replacement", () =>
    Effect.gen(function* () {
      let replacementStarted = false;
      const execution = makeSessionExecution({
        hasPendingOrRunning: Effect.fail("inspection unavailable"),
      });
      const exit = yield* execution
        .runWhenIdle(
          Effect.sync(() => {
            replacementStarted = true;
          }),
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(replacementStarted).toBe(false);
    }),
  );
});

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

export interface ProviderFiberReservation {
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<Fiber.Fiber<A, E>>;
  readonly releaseUnused: Effect.Effect<void>;
}

export interface ProviderFiberSupervisor {
  readonly reserve: (permits: number) => Effect.Effect<ProviderFiberReservation>;
}

const waitForEmpty = (fibers: ReadonlySet<Fiber.Fiber<unknown, unknown>>): Effect.Effect<void> =>
  Effect.suspend(() =>
    fibers.size === 0 ? Effect.void : Effect.sleep(5).pipe(Effect.andThen(waitForEmpty(fibers))),
  );

export const makeProviderFiberSupervisor = (
  capacity: number,
  drainTimeoutMs: number,
): Effect.Effect<ProviderFiberSupervisor, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(capacity);
      const fibers = new Set<Fiber.Fiber<unknown, unknown>>();
      let accepting = true;

      const reserve = (count: number) =>
        Effect.gen(function* () {
          yield* permits.take(count);
          let remaining = count;

          const fork: ProviderFiberReservation["fork"] = (effect) =>
            Effect.sync(() => {
              remaining -= 1;
              const fiber = Effect.runFork(effect);
              fibers.add(fiber);
              fiber.addObserver(() => {
                fibers.delete(fiber);
                Effect.runSync(permits.release(1));
              });
              return fiber;
            });

          const releaseUnused = Effect.suspend(() => {
            const unused = remaining;
            remaining = 0;
            return unused === 0 ? Effect.void : permits.release(unused).pipe(Effect.asVoid);
          });

          if (accepting) return { fork, releaseUnused } satisfies ProviderFiberReservation;
          yield* releaseUnused;
          return yield* Effect.interrupt;
        });

      return {
        fibers,
        supervisor: { reserve } satisfies ProviderFiberSupervisor,
        stop: () => {
          accepting = false;
          for (const fiber of fibers) fiber.interruptUnsafe();
          return waitForEmpty(fibers).pipe(Effect.timeoutOption(drainTimeoutMs));
        },
      };
    }),
    ({ fibers, stop }) =>
      stop().pipe(
        Effect.flatMap((settled) =>
          Option.isSome(settled)
            ? Effect.void
            : Effect.logWarning("Provider fiber supervisor drain deadline exceeded", {
                activeFiberCount: fibers.size,
              }),
        ),
      ),
  ).pipe(Effect.map(({ supervisor }) => supervisor));

import { Deferred, Effect, Semaphore } from "effect";

import type { SessionExecution } from "./session-execution";

/** Agent-local fence that rejects ordinary mutation and drains tracked work before cleanup starts. */
export const makeAccountDeletionFence = () => {
  const semaphore = Semaphore.makeUnsafe(1);
  const trackedExecutions = new Map<AbortController, Deferred.Deferred<void>>();
  let closed = false;

  return {
    close: Effect.suspend(() => {
      closed = true;
      return semaphore
        .withPermit(
          Effect.sync(() => {
            const completions = [...trackedExecutions.entries()].map(([controller, completion]) => {
              controller.abort("Account deletion fenced ordinary Agent execution");
              return completion;
            });
            return completions;
          }),
        )
        .pipe(
          Effect.flatMap((completions) =>
            Effect.forEach(completions, Deferred.await, { concurrency: "unbounded" }),
          ),
          Effect.asVoid,
        );
    }),
    run: <A, E, R, E2>(
      effect: Effect.Effect<A, E, R>,
      onClosed: () => E2,
    ): Effect.Effect<A, E | E2, R> =>
      semaphore.withPermit(
        Effect.suspend((): Effect.Effect<A, E | E2, R> =>
          closed ? Effect.fail(onClosed()) : effect,
        ),
      ),
    runTracked: <A, E, R, E2>(
      effect: (signal: AbortSignal) => Effect.Effect<A, E, R>,
      onClosed: () => E2,
    ): Effect.Effect<A, E | E2, R> =>
      Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- Deletion aborts tracked work without interrupting its in-flight Promise boundary; close still waits for completion.
        const controller = new AbortController();
        const completion = yield* Deferred.make<void>();
        const admitted = yield* semaphore.withPermit(
          Effect.sync(() => {
            if (closed) return false;
            trackedExecutions.set(controller, completion);
            return true;
          }),
        );
        if (!admitted) return yield* Effect.fail(onClosed());
        return yield* effect(controller.signal).pipe(
          Effect.ensuring(
            semaphore
              .withPermit(
                Effect.sync(() => {
                  trackedExecutions.delete(controller);
                }),
              )
              .pipe(Effect.andThen(Deferred.succeed(completion, undefined)), Effect.asVoid),
          ),
        );
      }),
  };
};

/** Keep Session serialization outside the deletion fence so quiescence and mutation share one lock order. */
export const makeAccountDeletionFencedSessionExecution = <E, R>(
  sessionExecution: SessionExecution<E, R>,
  fence: ReturnType<typeof makeAccountDeletionFence>,
) => ({
  close: sessionExecution.run(fence.close),
  closeAfter: <A, E2, R2>(before: Effect.Effect<A, E2, R2>) =>
    sessionExecution.run(before.pipe(Effect.andThen(fence.close))),
  run: <A, E2, R2, E3>(effect: Effect.Effect<A, E2, R2>, onClosed: () => E3) =>
    sessionExecution.run(fence.run(effect, onClosed)),
  runWhenIdle: <A, E2, R2, E3>(effect: Effect.Effect<A, E2, R2>, onClosed: () => E3) =>
    sessionExecution.runWhenIdle(fence.run(effect, onClosed)),
});

/** Reject a typed RPC failure returned as a value from an otherwise void quiescence call. */
export const requireAccountDeletionQuiescence = (result: void | Error): void => {
  if (result !== undefined) throw result;
};

export * as AccountDeletionFence from "./account-deletion-fence";

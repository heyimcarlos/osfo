import { Deferred, Effect, Exit, Semaphore } from "effect";

import type { SessionExecution } from "./session-execution";

/** Agent-local fence that rejects ordinary mutation and drains tracked work before cleanup starts. */
export const makeAccountDeletionFence = () => {
  const semaphore = Semaphore.makeUnsafe(1);
  const trackedExecutions = new Map<AbortController, Deferred.Deferred<void>>();
  let closed = false;

  const acquireTracked = <E>(onClosed: () => E) =>
    semaphore.withPermit(
      Effect.suspend(() => {
        if (closed) return Effect.fail(onClosed());
        // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- Deletion aborts tracked work without interrupting its in-flight Promise boundary; close still waits for completion.
        const controller = new AbortController();
        return Deferred.make<void>().pipe(
          Effect.map((completion) => {
            trackedExecutions.set(controller, completion);
            return {
              complete: semaphore
                .withPermit(
                  Effect.sync(() => {
                    trackedExecutions.delete(controller);
                  }),
                )
                .pipe(Effect.andThen(Deferred.succeed(completion, undefined)), Effect.asVoid),
              signal: controller.signal,
            };
          }),
        );
      }),
    );

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
      acquireTracked(onClosed).pipe(
        Effect.flatMap((tracked) => effect(tracked.signal).pipe(Effect.ensuring(tracked.complete))),
      ),
    acquireTracked,
  };
};

/** Keep Session serialization outside the deletion fence so quiescence and mutation share one lock order. */
export const makeAccountDeletionFencedSessionExecution = <E, R>(
  sessionExecution: SessionExecution<E, R>,
  fence: ReturnType<typeof makeAccountDeletionFence>,
) => {
  const runTracked = <Admission, E2, R2, A, E3, R3, E4>(
    serialize: <Value, Failure, Requirements>(
      effect: Effect.Effect<Value, Failure, Requirements>,
    ) => Effect.Effect<Value, E | Failure, R | Requirements>,
    admit: (signal: AbortSignal) => Effect.Effect<Admission, E2, R2>,
    continueWith: (admission: Admission, signal: AbortSignal) => Effect.Effect<A, E3, R3>,
    onClosed: () => E4,
  ) =>
    Effect.gen(function* () {
      const admitted = yield* serialize(
        fence.acquireTracked(onClosed).pipe(
          Effect.flatMap((tracked) =>
            admit(tracked.signal).pipe(
              Effect.map((value) => ({ tracked, value })),
              Effect.onExit((exit) => (Exit.isFailure(exit) ? tracked.complete : Effect.void)),
            ),
          ),
        ),
      );
      return yield* Effect.suspend(() =>
        continueWith(admitted.value, admitted.tracked.signal),
      ).pipe(Effect.ensuring(admitted.tracked.complete));
    });

  return {
    close: sessionExecution.run(fence.close),
    closeAfter: <A, E2, R2>(before: Effect.Effect<A, E2, R2>) =>
      sessionExecution.run(before.pipe(Effect.andThen(fence.close))),
    run: <A, E2, R2, E3>(effect: Effect.Effect<A, E2, R2>, onClosed: () => E3) =>
      sessionExecution.run(fence.run(effect, onClosed)),
    runTracked: <Admission, E2, R2, A, E3, R3, E4>(
      admit: (signal: AbortSignal) => Effect.Effect<Admission, E2, R2>,
      continueWith: (admission: Admission, signal: AbortSignal) => Effect.Effect<A, E3, R3>,
      onClosed: () => E4,
    ) => runTracked(sessionExecution.run, admit, continueWith, onClosed),
    runTrackedWhenIdle: <Admission, E2, R2, A, E3, R3, E4>(
      admit: (signal: AbortSignal) => Effect.Effect<Admission, E2, R2>,
      continueWith: (admission: Admission, signal: AbortSignal) => Effect.Effect<A, E3, R3>,
      onClosed: () => E4,
    ) => runTracked(sessionExecution.runWhenIdle, admit, continueWith, onClosed),
    runWhenIdle: <A, E2, R2, E3>(effect: Effect.Effect<A, E2, R2>, onClosed: () => E3) =>
      sessionExecution.runWhenIdle(fence.run(effect, onClosed)),
  };
};

/** Reject a typed RPC failure returned as a value from an otherwise void quiescence call. */
export const requireAccountDeletionQuiescence = (result: void | Error): void => {
  if (result !== undefined) throw result;
};

export * as AccountDeletionFence from "./account-deletion-fence";

import { Effect, Semaphore } from "effect";

/** Think-owned active-Submission inspection used before Session replacement. */
export interface SessionExecutionInspection<E, R> {
  readonly hasPendingOrRunning: Effect.Effect<boolean, E, R>;
}

/** Agent gate that serializes admission and waits on Think-owned lifecycle authority. */
export interface SessionExecution<E, R> {
  readonly run: <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) => Effect.Effect<A, E2, R2>;
  readonly runWhenIdle: <A, E2, R2>(
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E | E2, R | R2>;
  readonly submissionChanged: Effect.Effect<void>;
}

/** Construct a gate that rechecks Think rather than mirroring Submission state. */
export const makeSessionExecution = <E, R>(
  inspection: SessionExecutionInspection<E, R>,
): SessionExecution<E, R> => {
  const semaphore = Semaphore.makeUnsafe(1);
  let revision = 0;
  const waiters = new Set<() => void>();

  const awaitChange = (observedRevision: number) =>
    Effect.callback<void>((resume) => {
      if (revision !== observedRevision) {
        resume(Effect.void);
        return Effect.void;
      }
      const notify = () => resume(Effect.void);
      waiters.add(notify);
      return Effect.sync(() => waiters.delete(notify));
    });

  const run = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) => semaphore.withPermit(effect);
  const runWhenIdle = <A, E2, R2>(
    effect: Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E | E2, R | R2> => {
    const awaitIdle = (): Effect.Effect<A, E | E2, R | R2> =>
      Effect.sync(() => revision).pipe(
        Effect.flatMap((observedRevision) =>
          inspection.hasPendingOrRunning.pipe(
            Effect.flatMap((hasActiveSubmission) => {
              if (!hasActiveSubmission) return effect;
              return awaitChange(observedRevision).pipe(Effect.andThen(awaitIdle));
            }),
          ),
        ),
      );
    return semaphore.withPermit(awaitIdle());
  };

  return {
    run,
    runWhenIdle,
    submissionChanged: Effect.sync(() => {
      revision += 1;
      const pending = [...waiters];
      waiters.clear();
      for (const notify of pending) notify();
    }),
  };
};

import { Effect, Semaphore } from "effect";

/** Agent-local fence that drains R2 writers before account cleanup starts. */
export const makeAccountDeletionFence = () => {
  const semaphore = Semaphore.makeUnsafe(1);
  let closed = false;

  return {
    close: Effect.suspend(() => {
      closed = true;
      return semaphore.withPermit(Effect.void);
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
  };
};

/** Reject a typed RPC failure returned as a value from an otherwise void quiescence call. */
export const requireAccountDeletionQuiescence = (result: void | Error): void => {
  if (result !== undefined) throw result;
};

export * as AccountDeletionFence from "./account-deletion-fence";

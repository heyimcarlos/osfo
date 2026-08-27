import { type Effect, Semaphore } from "effect";

export interface MemoryProviderReconciliationQueue {
  readonly run: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** Serialize every reconciliation source for one Agent instance. */
export const makeMemoryProviderReconciliationQueue = (): MemoryProviderReconciliationQueue => {
  const semaphore = Semaphore.makeUnsafe(1);
  return { run: (work) => semaphore.withPermit(work) };
};

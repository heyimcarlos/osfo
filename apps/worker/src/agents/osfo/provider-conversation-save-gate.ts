import { Semaphore, type Effect } from "effect";

/** Agent-local gate that drains entered provider saves before Session deletion settles them. */
export const makeProviderConversationSaveGate = () => {
  const semaphore = Semaphore.makeUnsafe(1);

  return {
    runSave: <A, E, R>(effect: Effect.Effect<A, E, R>) => semaphore.withPermit(effect),
    runSessionDeletion: <A, E, R>(effect: Effect.Effect<A, E, R>) => semaphore.withPermit(effect),
  };
};

export * as ProviderConversationSaveGate from "./provider-conversation-save-gate";

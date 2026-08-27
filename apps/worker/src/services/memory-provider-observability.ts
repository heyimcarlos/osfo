import { Clock, Effect, Result } from "effect";

import type { MemoryProviderOperation } from "./memory-provider";

/* oxlint-disable eslint/no-underscore-dangle -- Application evidence uses the canonical _tag discriminator. */

export type Evidence =
  | {
      readonly _tag: "BacklogObserved";
      readonly blockedAppendCount: number;
      readonly oldestPendingAppendAgeMillis: number;
      readonly pendingAppendCount: number;
    }
  | {
      readonly _tag: "ProcessingCompleted";
      readonly processingCompletedAtMillis: number;
      readonly processingLatencyMillis: number;
      readonly retryCount: number;
    }
  | {
      readonly _tag: "SearchReady";
      readonly retryCount: number;
      readonly searchReadyAtMillis: number;
      readonly searchReadinessLatencyMillis: number;
    }
  | {
      readonly _tag: "RetryScheduled";
      readonly failureTag: string;
      readonly operation: MemoryProviderOperation;
      readonly retryCount: number;
    }
  | {
      readonly _tag: "OverlappingAppendBlocked";
      readonly blockedAppendCount: number;
    };

/** Time one provider boundary while retaining its original typed success or failure. */
export const observeCall = <A, E extends { readonly _tag: string }, R>(
  operation: MemoryProviderOperation,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* effect.pipe(Effect.result);
    const completedAt = yield* Clock.currentTimeMillis;
    const latencyMillis = completedAt - startedAt;
    if (Result.isFailure(result)) {
      yield* Effect.logWarning("MemoryProvider call failed").pipe(
        Effect.annotateLogs({
          failureTag: result.failure._tag,
          latencyMillis,
          operation,
          outcome: "failed",
        }),
      );
      return yield* Effect.fail(result.failure);
    }
    yield* Effect.logInfo("MemoryProvider call completed").pipe(
      Effect.annotateLogs({ latencyMillis, operation, outcome: "succeeded" }),
    );
    return result.success;
  });

/** Emit one safe outbox lifecycle signal without operation payloads or identities. */
export const emit = Effect.fn("MemoryProviderObservability.emit")((evidence: Evidence) => {
  const { _tag, ...annotations } = evidence;
  return Effect.logInfo(messageFor(evidence)).pipe(Effect.annotateLogs(annotations));
});

const messageFor = (evidence: Evidence): string => {
  switch (evidence._tag) {
    case "BacklogObserved":
      return "MemoryProvider outbox backlog observed";
    case "OverlappingAppendBlocked":
      return "MemoryProvider overlapping append blocked";
    case "ProcessingCompleted":
      return "MemoryProvider processing completed";
    case "RetryScheduled":
      return "MemoryProvider retry scheduled";
    case "SearchReady":
      return "MemoryProvider source search ready";
  }
  return evidence satisfies never;
};

export * as MemoryProviderObservability from "./memory-provider-observability";

/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect owns its isolated logger. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Logger, References } from "effect";
import { TestClock } from "effect/testing";

import { MemoryProvider } from "./memory-provider";
import { MemoryProviderObservability } from "./memory-provider-observability";

it.effect("records provider latency and failure class without provider or customer bodies", () => {
  const logs: Array<{ readonly annotations: object; readonly message: unknown }> = [];
  const logger = Logger.make<unknown, void>((options) => {
    logs.push({
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      message: options.message,
    });
  });

  return Effect.gen(function* () {
    const success = yield* MemoryProviderObservability.observeCall(
      "recall",
      Effect.sleep("25 millis").pipe(Effect.as("private provider body")),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("25 millis");
    yield* Fiber.join(success);

    const failure = yield* MemoryProviderObservability.observeCall(
      "saveConversation",
      Effect.sleep("10 millis").pipe(
        Effect.andThen(
          Effect.fail(
            new MemoryProvider.MemoryProviderUnavailable({
              message: "private provider response body",
              operation: "saveConversation",
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("10 millis");
    yield* Fiber.await(failure);

    expect(logs).toEqual([
      {
        annotations: { latencyMillis: 25, operation: "recall", outcome: "succeeded" },
        message: ["MemoryProvider call completed"],
      },
      {
        annotations: {
          failureTag: "MemoryProviderUnavailable",
          latencyMillis: 10,
          operation: "saveConversation",
          outcome: "failed",
        },
        message: ["MemoryProvider call failed"],
      },
    ]);
    expect(
      logs.every(
        ({ annotations }) => !Object.values(annotations).includes("private provider response body"),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(Logger.layer([logger])));
});

it.effect(
  "keeps processing completion, search readiness, retry, and backlog as separate signals",
  () => {
    const logs: Array<object> = [];
    const logger = Logger.make<unknown, void>((options) => {
      logs.push({
        ...options.fiber.getRef(References.CurrentLogAnnotations),
        message: options.message,
      });
    });

    return Effect.gen(function* () {
      yield* MemoryProviderObservability.emit({
        _tag: "BacklogObserved",
        blockedAppendCount: 2,
        oldestPendingAppendAgeMillis: 4_000,
        pendingAppendCount: 3,
      });
      yield* MemoryProviderObservability.emit({
        _tag: "ProcessingCompleted",
        processingCompletedAtMillis: 10_000,
        processingLatencyMillis: 1_500,
        retryCount: 1,
      });
      yield* MemoryProviderObservability.emit({
        _tag: "SearchReady",
        retryCount: 2,
        searchReadyAtMillis: 11_000,
        searchReadinessLatencyMillis: 2_500,
      });
      yield* MemoryProviderObservability.emit({
        _tag: "RetryScheduled",
        failureTag: "MemoryProviderUnavailable",
        operation: "checkConversationSearchability",
        retryCount: 2,
      });

      expect(logs).toEqual([
        {
          blockedAppendCount: 2,
          message: ["MemoryProvider outbox backlog observed"],
          oldestPendingAppendAgeMillis: 4_000,
          pendingAppendCount: 3,
        },
        {
          message: ["MemoryProvider processing completed"],
          processingCompletedAtMillis: 10_000,
          processingLatencyMillis: 1_500,
          retryCount: 1,
        },
        {
          message: ["MemoryProvider source search ready"],
          retryCount: 2,
          searchReadyAtMillis: 11_000,
          searchReadinessLatencyMillis: 2_500,
        },
        {
          failureTag: "MemoryProviderUnavailable",
          message: ["MemoryProvider retry scheduled"],
          operation: "checkConversationSearchability",
          retryCount: 2,
        },
      ]);
    }).pipe(Effect.provide(Logger.layer([logger])));
  },
);

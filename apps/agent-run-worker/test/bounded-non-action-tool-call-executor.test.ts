import {
  AgentRunCancellationObserved,
  NonActionToolCallExecutor,
  ToolCallExecutionError,
  type ToolCallAttempt,
} from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  deterministicEchoCapability,
  makeBoundedNonActionToolCallExecutorLayer,
  type NonActionToolCapability,
} from "../src/bounded-non-action-tool-call-executor.js";

const attempt = {
  agentRunId: "9a9fcdbd-b586-4b46-b57f-5a4fde715933",
  attemptLimit: 2,
  attemptNumber: 1,
  executionMode: "nonAction",
  input: { type: "text", text: "hello" },
  memberIndex: 0,
  toolCallAttemptId: "32b293b7-7427-47b1-ab53-a0f19c752f70",
  toolCallBatchId: "3089c6cd-f18a-4376-bb7d-7425b025eb79",
  toolCallId: "tool_77aa98bb-b2e2-4087-a6ad-6f3d4af5fdeb",
  toolName: "echo",
} as const satisfies ToolCallAttempt;

const context = {
  pollCancellation: () => Effect.void,
  reportProgress: () => Effect.void,
};

const layerFor = (capability: NonActionToolCapability) =>
  makeBoundedNonActionToolCallExecutorLayer({
    capabilities: [capability],
    cleanupDeadlineMs: 10,
    executionDeadlineMs: 10,
    cancellationPollIntervalMs: 1,
  });

const execute = (capability: NonActionToolCapability) =>
  NonActionToolCallExecutor.use((executor) => executor.execute(attempt, context)).pipe(
    Effect.provide(layerFor(capability)),
  );

describe("bounded non-Action ToolCall executor", () => {
  it.effect("executes an explicitly granted capability and cleans it up", () =>
    Effect.gen(function* () {
      const cleanups = yield* Ref.make(0);
      const outcome = yield* execute({
        ...deterministicEchoCapability,
        cleanup: () => Ref.update(cleanups, (count) => count + 1),
      });

      expect(outcome).toEqual({
        type: "succeeded",
        result: { type: "text", text: "hello" },
      });
      expect(yield* Ref.get(cleanups)).toBe(1);
    }),
  );

  it.effect("fails closed when the capability is not granted", () =>
    Effect.gen(function* () {
      const outcome = yield* NonActionToolCallExecutor.use((executor) =>
        executor.execute({ ...attempt, toolName: "filesystem" }, context),
      ).pipe(
        Effect.provide(
          makeBoundedNonActionToolCallExecutorLayer({
            capabilities: [deterministicEchoCapability],
            cleanupDeadlineMs: 10,
            executionDeadlineMs: 10,
            cancellationPollIntervalMs: 1,
          }),
        ),
      );
      expect(outcome).toEqual({ type: "failed", cause: "invalidInput" });
    }),
  );

  it.effect("cleans up after execution failure", () =>
    Effect.gen(function* () {
      const cleanups = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        execute({
          toolName: "echo",
          execute: () =>
            Effect.fail(new ToolCallExecutionError({ cause: "failed", retryable: false })),
          cleanup: () => Ref.update(cleanups, (count) => count + 1),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(cleanups)).toBe(1);
    }),
  );

  it.effect("rejects capability outcomes carrying undeclared private fields", () =>
    Effect.gen(function* () {
      const cleanups = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        execute({
          toolName: "echo",
          execute: () =>
            Effect.succeed({
              type: "succeeded" as const,
              result: { type: "text" as const, text: "safe" },
              privatePayload: "must not cross the executor boundary",
            }),
          cleanup: () => Ref.update(cleanups, (count) => count + 1),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(cleanups)).toBe(1);
    }),
  );

  it.effect("cleans up after the execution deadline", () =>
    Effect.gen(function* () {
      const cleanups = yield* Ref.make(0);
      const fiber = yield* Effect.forkScoped(
        execute({
          toolName: "echo",
          execute: () => Effect.never,
          cleanup: () => Ref.update(cleanups, (count) => count + 1),
        }),
      );
      yield* TestClock.adjust("11 millis");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(cleanups)).toBe(1);
    }),
  );

  it.effect("cleans up when the executor fiber is interrupted", () =>
    Effect.gen(function* () {
      const cleanups = yield* Ref.make(0);
      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkScoped(
        execute({
          toolName: "echo",
          execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          cleanup: () => Ref.update(cleanups, (count) => count + 1),
        }),
      );

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      expect(yield* Ref.get(cleanups)).toBe(1);
    }),
  );

  it.effect("bounds cleanup after successful execution", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(
        execute({
          ...deterministicEchoCapability,
          cleanup: () => Effect.never,
        }),
      );

      yield* TestClock.adjust("11 millis");
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.isSome(error) ? error.value._tag : undefined).toBe("ToolCallExecutionError");
    }),
  );

  it.effect("preserves durable cancellation and cleans up", () =>
    Effect.gen(function* () {
      const cleanups = yield* Ref.make(0);
      const program = NonActionToolCallExecutor.use((executor) =>
        executor.execute(attempt, {
          reportProgress: () => Effect.void,
          pollCancellation: () => Effect.fail(new AgentRunCancellationObserved()),
        }),
      ).pipe(
        Effect.provide(
          layerFor({
            toolName: "echo",
            execute: () => Effect.never,
            cleanup: () => Ref.update(cleanups, (count) => count + 1),
          }),
        ),
      );
      const fiber = yield* Effect.forkScoped(program);
      yield* TestClock.adjust("2 millis");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.isSome(error) ? error.value._tag : undefined).toBe(
        "AgentRunCancellationObserved",
      );
      expect(yield* Ref.get(cleanups)).toBe(1);
    }),
  );

  it.effect("rejects duplicate capability authority at layer construction", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        NonActionToolCallExecutor.use(() => Effect.void).pipe(
          Effect.provide(
            makeBoundedNonActionToolCallExecutorLayer({
              capabilities: [deterministicEchoCapability, deterministicEchoCapability],
              cleanupDeadlineMs: 10,
              executionDeadlineMs: 10,
              cancellationPollIntervalMs: 1,
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects non-positive execution bounds", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        NonActionToolCallExecutor.use(() => Effect.void).pipe(
          Effect.provide(
            makeBoundedNonActionToolCallExecutorLayer({
              capabilities: [deterministicEchoCapability],
              cleanupDeadlineMs: 10,
              executionDeadlineMs: 0,
              cancellationPollIntervalMs: 1,
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

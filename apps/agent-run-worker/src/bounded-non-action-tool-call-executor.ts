import {
  NonActionToolCallExecutor,
  ToolCallExecutionError,
  type NonActionToolCallExecutionContext,
  type ToolCallAttempt,
  type ToolCallOutcome,
  ToolCallOutcomeSchema,
} from "@osfo/agent-run";
import { Data, Duration, Effect, Layer, Schema } from "effect";

export interface NonActionToolCapability {
  readonly toolName: string;
  readonly execute: (
    attempt: ToolCallAttempt,
  ) => Effect.Effect<ToolCallOutcome, ToolCallExecutionError>;
  readonly cleanup: (attempt: ToolCallAttempt) => Effect.Effect<void, ToolCallExecutionError>;
}

export interface BoundedNonActionToolCallExecutorConfig {
  readonly capabilities: ReadonlyArray<NonActionToolCapability>;
  readonly executionDeadlineMs: number;
  readonly cancellationPollIntervalMs: number;
  readonly cleanupDeadlineMs: number;
}

export class InvalidBoundedNonActionToolCallExecutorConfig extends Data.TaggedError(
  "InvalidBoundedNonActionToolCallExecutorConfig",
)<{ readonly cause: string }> {}

const executionError = (cause: unknown, retryable: boolean) =>
  new ToolCallExecutionError({ cause, retryable });

const runCancellationPolling = (context: NonActionToolCallExecutionContext, intervalMs: number) =>
  Effect.forever(
    Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.andThen(context.pollCancellation())),
  );

const runCleanup = (
  capability: NonActionToolCapability,
  attempt: ToolCallAttempt,
  deadlineMs: number,
) =>
  capability.cleanup(attempt).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(deadlineMs),
      orElse: () => Effect.fail(executionError(`Tool cleanup exceeded ${deadlineMs}ms`, false)),
    }),
  );

/**
 * Composes an explicit capability catalog with hard execution and cleanup
 * deadlines. Cancellation is polled through the durable AgentRun authority,
 * so a handler cannot stay alive merely because it does not report progress.
 */
export const makeBoundedNonActionToolCallExecutorLayer = (
  config: BoundedNonActionToolCallExecutorConfig,
) =>
  Layer.effect(
    NonActionToolCallExecutor,
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(config.executionDeadlineMs) ||
        config.executionDeadlineMs <= 0 ||
        !Number.isSafeInteger(config.cancellationPollIntervalMs) ||
        config.cancellationPollIntervalMs <= 0 ||
        !Number.isSafeInteger(config.cleanupDeadlineMs) ||
        config.cleanupDeadlineMs <= 0
      ) {
        return yield* new InvalidBoundedNonActionToolCallExecutorConfig({
          cause: "Deadlines and polling intervals must be positive safe integers",
        });
      }
      const capabilityNames = config.capabilities.map(({ toolName }) => toolName);
      if (
        capabilityNames.some((toolName) => toolName.length === 0 || toolName.length > 128) ||
        new Set(capabilityNames).size !== capabilityNames.length
      ) {
        return yield* new InvalidBoundedNonActionToolCallExecutorConfig({
          cause: "Capability names must be unique and between 1 and 128 characters",
        });
      }

      return NonActionToolCallExecutor.of({
        execute: (attempt, context) => {
          const capability = config.capabilities.find(
            (candidate) => candidate.toolName === attempt.toolName,
          );
          if (capability === undefined) {
            return Effect.succeed({ type: "failed", cause: "invalidInput" } as const);
          }

          const execution = context
            .reportProgress({ observationIndex: 0, message: "Tool execution started" })
            .pipe(
              Effect.andThen(capability.execute(attempt)),
              Effect.flatMap((outcome) =>
                Schema.decodeUnknownEffect(ToolCallOutcomeSchema, {
                  onExcessProperty: "error",
                })(outcome).pipe(Effect.mapError((cause) => executionError(cause, false))),
              ),
              Effect.timeoutOrElse({
                duration: Duration.millis(config.executionDeadlineMs),
                orElse: () =>
                  Effect.fail(
                    executionError(`Tool execution exceeded ${config.executionDeadlineMs}ms`, true),
                  ),
              }),
              Effect.raceFirst(runCancellationPolling(context, config.cancellationPollIntervalMs)),
            );

          return execution.pipe(
            Effect.onExit(() => runCleanup(capability, attempt, config.cleanupDeadlineMs)),
          );
        },
      });
    }),
  );

export const deterministicEchoCapability: NonActionToolCapability = {
  toolName: "echo",
  execute: (attempt) =>
    Effect.succeed({
      type: "succeeded",
      result: { type: "text", text: attempt.input.text },
    }),
  cleanup: () => Effect.void,
};

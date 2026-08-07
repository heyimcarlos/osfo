import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  AgentRunFence,
  AgentRunRepositoryError,
  ModelCallAttempt,
  ModelCallExecutionError,
  ModelCallAttemptOutcome,
} from "./index.js";
import {
  executeCommittedNonActionToolCallBatch,
  NonActionToolCallExecutor,
  type PreparedToolCallBatch,
  ToolCallRepository,
  type ToolCallBatchRequest,
  type ToolCallExecutionError,
  type ToolCallOutcome,
} from "./tool-call.js";

export interface ModelToolLoopTurn {
  readonly attempt: ModelCallAttempt;
  readonly outcome: ModelCallAttemptOutcome;
}

export interface ModelToolCallBarrierRepositoryService {
  /**
   * Atomically persists the completed model turn, its completion barrier, and
   * the full stable ToolCall batch before returning executor authority.
   */
  readonly commitModelToolCallBarrier: (
    fence: AgentRunFence,
    turn: ModelToolLoopTurn,
    request: ToolCallBatchRequest,
  ) => Effect.Effect<PreparedToolCallBatch, AgentRunRepositoryError>;
}

export class ModelToolCallBarrierRepository extends Context.Service<
  ModelToolCallBarrierRepository,
  ModelToolCallBarrierRepositoryService
>()("@osfo/agent-run/ModelToolCallBarrierRepository") {}

export interface ModelToolContinuationService {
  readonly continueAfterToolCallBatch: (input: {
    readonly fence: AgentRunFence;
    readonly completedTurn: ModelToolLoopTurn;
    readonly batch: PreparedToolCallBatch;
    readonly outcomes: ReadonlyArray<{
      readonly toolCallId: string;
      readonly outcome: ToolCallOutcome;
    }>;
  }) => Effect.Effect<ModelToolLoopTurn, AgentRunRepositoryError | ModelCallExecutionError>;
}

export class ModelToolContinuation extends Context.Service<
  ModelToolContinuation,
  ModelToolContinuationService
>()("@osfo/agent-run/ModelToolContinuation") {}

export class AgentRunToolLoopError extends Data.TaggedError("AgentRunToolLoopError")<{
  readonly cause: "toolCallBatchFailed" | "toolCallBatchCanceled" | "toolCallRoundLimitExceeded";
}> {}

export interface AgentRunToolLoopService {
  readonly drive: (
    fence: AgentRunFence,
    initialTurn: ModelToolLoopTurn,
  ) => Effect.Effect<
    ModelToolLoopTurn,
    | AgentRunRepositoryError
    | ModelCallExecutionError
    | ToolCallExecutionError
    | AgentRunToolLoopError
  >;
}

export class AgentRunToolLoop extends Context.Service<AgentRunToolLoop, AgentRunToolLoopService>()(
  "@osfo/agent-run/AgentRunToolLoop",
) {}

export interface AgentRunToolLoopConfig {
  readonly maxToolCallRounds: number;
}

export class InvalidAgentRunToolLoopConfig extends Data.TaggedError(
  "InvalidAgentRunToolLoopConfig",
)<{
  readonly cause: "maxToolCallRoundsMustBePositive";
}> {}

/**
 * Drives normalized model ToolCall completions through a durable barrier,
 * executes only that committed batch, then hands typed outcomes to the next
 * model turn. Provider-specific continuation authority remains behind the
 * ModelToolContinuation service and never enters the public ToolCall model.
 */
export const makeAgentRunToolLoopLayer = (config: AgentRunToolLoopConfig) =>
  Layer.effect(
    AgentRunToolLoop,
    Effect.gen(function* () {
      if (!Number.isSafeInteger(config.maxToolCallRounds) || config.maxToolCallRounds <= 0) {
        return yield* new InvalidAgentRunToolLoopConfig({
          cause: "maxToolCallRoundsMustBePositive",
        });
      }
      const barrierRepository = yield* ModelToolCallBarrierRepository;
      const continuation = yield* ModelToolContinuation;
      const toolCallRepository = yield* ToolCallRepository;
      const toolCallExecutor = yield* NonActionToolCallExecutor;

      const drive: AgentRunToolLoopService["drive"] = Effect.fn("AgentRunToolLoop.drive")(
        function* (fence, initialTurn) {
          let turn = initialTurn;
          let completedRounds = 0;
          while (true) {
            const completion = turn.outcome.completion;
            if (completion.type === "text") return turn;
            if (completedRounds >= config.maxToolCallRounds) {
              return yield* new AgentRunToolLoopError({
                cause: "toolCallRoundLimitExceeded",
              });
            }

            const batch = yield* barrierRepository.commitModelToolCallBarrier(
              fence,
              turn,
              completion.batch,
            );
            const batchState = yield* executeCommittedNonActionToolCallBatch(fence, batch).pipe(
              Effect.provideService(ToolCallRepository, toolCallRepository),
              Effect.provideService(NonActionToolCallExecutor, toolCallExecutor),
            );
            if (batchState.type !== "succeeded") {
              return yield* new AgentRunToolLoopError({
                cause:
                  batchState.type === "canceled" ? "toolCallBatchCanceled" : "toolCallBatchFailed",
              });
            }

            completedRounds += 1;
            turn = yield* continuation.continueAfterToolCallBatch({
              fence,
              completedTurn: turn,
              batch,
              outcomes: batchState.outcomes,
            });
          }
        },
      );

      return AgentRunToolLoop.of({ drive });
    }),
  );

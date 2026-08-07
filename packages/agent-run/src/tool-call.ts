import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AgentRunFence, AgentRunRepositoryError } from "./index.js";

const Identity = Schema.String.check(Schema.isUUID());
const ToolCallIdentity = Schema.String.check(
  Schema.isPattern(
    /^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
);
const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const toolCallProgressTextMaxLength = 512;
export const toolCallResultTextMaxLength = 16_384;
export const toolCallBatchSizeMax = 8;

export const ToolCallRequestSchema = Schema.Struct({
  executionMode: Schema.Literal("nonAction"),
  toolName: NonEmptyText.check(Schema.isMaxLength(128)),
  input: Schema.Struct({
    type: Schema.Literal("text"),
    text: NonEmptyText.check(Schema.isMaxLength(toolCallResultTextMaxLength)),
  }),
});

export type ToolCallRequest = typeof ToolCallRequestSchema.Type;

export const ToolCallBatchRequestSchema = Schema.Struct({
  batchKey: NonEmptyText.check(Schema.isMaxLength(128)),
  attemptLimit: PositiveInteger.check(Schema.isLessThanOrEqualTo(5)),
  requests: Schema.Array(ToolCallRequestSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(toolCallBatchSizeMax),
  ),
});

export type ToolCallBatchRequest = typeof ToolCallBatchRequestSchema.Type;

export const PreparedToolCallSchema = Schema.Struct({
  toolCallId: ToolCallIdentity,
  toolCallBatchId: Identity,
  agentRunId: Identity,
  memberIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attemptLimit: PositiveInteger,
  executionMode: Schema.Literal("nonAction"),
  toolName: NonEmptyText,
  input: ToolCallRequestSchema.fields.input,
});

export type PreparedToolCall = typeof PreparedToolCallSchema.Type;

export const PreparedToolCallBatchSchema = Schema.Struct({
  toolCallBatchId: Identity,
  agentRunId: Identity,
  batchKey: NonEmptyText,
  calls: Schema.Array(PreparedToolCallSchema).check(Schema.isMinLength(1)),
});

export type PreparedToolCallBatch = typeof PreparedToolCallBatchSchema.Type;

export const ToolCallAttemptSchema = Schema.Struct({
  ...PreparedToolCallSchema.fields,
  toolCallAttemptId: Identity,
  attemptNumber: PositiveInteger,
});

export type ToolCallAttempt = typeof ToolCallAttemptSchema.Type;

export const ToolCallProgressSchema = Schema.Struct({
  observationIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  message: NonEmptyText.check(Schema.isMaxLength(toolCallProgressTextMaxLength)),
});

export type ToolCallProgress = typeof ToolCallProgressSchema.Type;

export const ToolCallOutcomeSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("succeeded"),
    result: Schema.Struct({
      type: Schema.Literal("text"),
      text: NonEmptyText.check(Schema.isMaxLength(toolCallResultTextMaxLength)),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    cause: Schema.Literals(["invalidInput", "executionFailed", "dependencyUnavailable"]),
  }),
  Schema.Struct({ type: Schema.Literal("canceled") }),
]);

export type ToolCallOutcome = typeof ToolCallOutcomeSchema.Type;

export const ToolCallAttemptClaimSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("busy") }),
  Schema.Struct({ type: Schema.Literal("terminal") }),
  Schema.Struct({ type: Schema.Literal("started"), attempt: ToolCallAttemptSchema }),
]);

export type ToolCallAttemptClaim = typeof ToolCallAttemptClaimSchema.Type;

export const ToolCallBatchStateSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pending"), calls: Schema.Array(PreparedToolCallSchema) }),
  Schema.Struct({
    type: Schema.Literal("succeeded"),
    outcomes: Schema.Array(
      Schema.Struct({ toolCallId: ToolCallIdentity, outcome: ToolCallOutcomeSchema }),
    ),
  }),
  Schema.Struct({ type: Schema.Literals(["failed", "canceled"]) }),
]);

export type ToolCallBatchState = typeof ToolCallBatchStateSchema.Type;

export interface ToolCallRepositoryService {
  readonly commitBatch: (
    fence: AgentRunFence,
    request: ToolCallBatchRequest,
  ) => Effect.Effect<PreparedToolCallBatch, AgentRunRepositoryError>;
  readonly claimNextAttempt: (
    fence: AgentRunFence,
    batch: PreparedToolCallBatch,
  ) => Effect.Effect<ToolCallAttemptClaim, AgentRunRepositoryError>;
  readonly appendProgress: (
    fence: AgentRunFence,
    attempt: ToolCallAttempt,
    progress: ToolCallProgress,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly completeAttempt: (
    fence: AgentRunFence,
    attempt: ToolCallAttempt,
    outcome: ToolCallOutcome,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly retryAttempt: (
    fence: AgentRunFence,
    attempt: ToolCallAttempt,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly cancelBatch: (
    fence: AgentRunFence,
    batch: PreparedToolCallBatch,
  ) => Effect.Effect<void, AgentRunRepositoryError>;
  readonly loadBatchState: (
    fence: AgentRunFence,
    batch: PreparedToolCallBatch,
  ) => Effect.Effect<ToolCallBatchState, AgentRunRepositoryError>;
}

export class ToolCallRepository extends Context.Service<
  ToolCallRepository,
  ToolCallRepositoryService
>()("@osfo/agent-run/ToolCallRepository") {}

export class ToolCallExecutionError extends Data.TaggedError("ToolCallExecutionError")<{
  readonly cause: unknown;
  readonly retryable: boolean;
}> {}

export class NonActionToolCallExecutor extends Context.Service<
  NonActionToolCallExecutor,
  {
    readonly execute: (
      attempt: ToolCallAttempt,
      reportProgress: (progress: ToolCallProgress) => Effect.Effect<void, AgentRunRepositoryError>,
    ) => Effect.Effect<ToolCallOutcome, ToolCallExecutionError | AgentRunRepositoryError>;
  }
>()("@osfo/agent-run/NonActionToolCallExecutor") {}

export const makeDeterministicTextToolCallExecutorLayer = () =>
  Layer.succeed(NonActionToolCallExecutor)({
    execute: (attempt, reportProgress) =>
      Effect.gen(function* () {
        yield* reportProgress({ observationIndex: 0, message: "Tool execution started" });
        if (attempt.toolName !== "echo") {
          return {
            type: "failed" as const,
            cause: "invalidInput" as const,
          };
        }
        yield* reportProgress({ observationIndex: 1, message: "Tool execution completed" });
        return {
          type: "succeeded" as const,
          result: { type: "text" as const, text: attempt.input.text },
        };
      }),
  });

export const executeNonActionToolCallBatch = Effect.fn("NonActionToolCallBatch.execute")(function* (
  fence: AgentRunFence,
  request: ToolCallBatchRequest,
) {
  const repository = yield* ToolCallRepository;
  const executor = yield* NonActionToolCallExecutor;
  const validatedRequest = yield* Schema.decodeUnknownEffect(ToolCallBatchRequestSchema)(
    request,
  ).pipe(Effect.mapError((cause) => new ToolCallExecutionError({ cause, retryable: false })));
  const batch = yield* repository.commitBatch(fence, validatedRequest);

  while (true) {
    const claim = yield* repository.claimNextAttempt(fence, batch);
    if (claim.type === "busy")
      return yield* new ToolCallExecutionError({
        cause: "Another ToolCall attempt is active for this AgentRun claim",
        retryable: true,
      });
    if (claim.type === "none" || claim.type === "terminal") {
      return yield* repository.loadBatchState(fence, batch);
    }

    const outcome = yield* executor
      .execute(claim.attempt, (progress) =>
        repository.appendProgress(fence, claim.attempt, progress),
      )
      .pipe(
        Effect.catchTag("ToolCallExecutionError", (error) =>
          error.retryable
            ? repository
                .retryAttempt(fence, claim.attempt)
                .pipe(Effect.as<ToolCallOutcome | undefined>(undefined))
            : Effect.succeed<ToolCallOutcome>({
                type: "failed",
                cause: "executionFailed",
              }),
        ),
      );
    if (outcome !== undefined) yield* repository.completeAttempt(fence, claim.attempt, outcome);
  }
});

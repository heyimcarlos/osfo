import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect";
import {
  AgentRunToolLoop,
  makeAgentRunToolLoopLayer,
  ModelToolCallBarrierRepository,
  ModelToolContinuation,
  NonActionToolCallExecutor,
  ToolCallRepository,
  type ModelCallAttempt,
  type ModelToolCallBarrierRepositoryService,
  type ModelToolContinuationService,
  type PreparedToolCallBatch,
  type ToolCallRepositoryService,
} from "../src/index.js";

const fence = {
  agentRunId: "9a9fcdbd-b586-4b46-b57f-5a4fde715933",
  workerId: "worker-a",
  claimEpoch: "1",
} as const;

const attempt = {
  assistantOutputId: "81164399-b959-4ad3-a66b-a9fbc6abf065",
  attemptNumber: 1,
  modelBinding: "oz.test.tools.v1",
  modelCallAttemptId: "a050145b-9816-4642-8cdb-5a0fc927d919",
  modelCallId: "6abbfd39-e806-447a-9618-d05df887c13f",
  prompt: "echo hello",
  usage: { type: "unknown" },
} as const satisfies ModelCallAttempt;

const request = {
  attemptLimit: 2,
  batchKey: "model-turn-1",
  requests: [
    {
      executionMode: "nonAction",
      input: { type: "text", text: "hello" },
      toolName: "echo",
    },
  ],
} as const;

const batch = {
  agentRunId: fence.agentRunId,
  batchKey: request.batchKey,
  calls: [
    {
      agentRunId: fence.agentRunId,
      attemptLimit: 2,
      executionMode: "nonAction",
      input: { type: "text", text: "hello" },
      memberIndex: 0,
      toolCallBatchId: "06f58a00-ad48-49e7-9d69-c87a13310232",
      toolCallId: "tool_d7927abe-f32f-422b-8251-6986efbc912e",
      toolName: "echo",
    },
  ],
  toolCallBatchId: "06f58a00-ad48-49e7-9d69-c87a13310232",
} as const satisfies PreparedToolCallBatch;

const toolAttempt = {
  ...batch.calls[0],
  attemptNumber: 1,
  toolCallAttemptId: "288ae95f-bf00-41fc-87a6-0b04ec458e46",
} as const;

const toolOutcome = {
  type: "succeeded" as const,
  result: { type: "text" as const, text: "hello" },
};

const initialTurn = {
  attempt,
  outcome: {
    completion: { type: "toolCallBatch" as const, batch: request },
    dispatchEvidence: { type: "confirmed" as const },
    usage: { type: "unknown" as const },
  },
};

const makeToolRepository = (events: Ref.Ref<ReadonlyArray<string>>): ToolCallRepositoryService => {
  let completed = false;
  return {
    appendProgress: () => Effect.void,
    cancelBatch: () => Effect.void,
    claimNextAttempt: () =>
      Ref.update(events, (current) => [...current, "claim"]).pipe(
        Effect.as(
          completed
            ? ({ type: "terminal" } as const)
            : ({ type: "started", attempt: toolAttempt } as const),
        ),
      ),
    commitBatch: () => Effect.succeed(batch),
    completeAttempt: () =>
      Effect.sync(() => {
        completed = true;
      }),
    loadBatchState: () =>
      Effect.succeed({
        type: "succeeded" as const,
        outcomes: [{ toolCallId: batch.calls[0].toolCallId, outcome: toolOutcome }],
      }),
    retryAttempt: () => Effect.void,
  };
};

const makeLayer = (
  events: Ref.Ref<ReadonlyArray<string>>,
  continuation: ModelToolContinuationService,
) => {
  const barrier: ModelToolCallBarrierRepositoryService = {
    commitModelToolCallBarrier: () =>
      Ref.update(events, (current) => [...current, "barrier"]).pipe(Effect.as(batch)),
  };
  return makeAgentRunToolLoopLayer({ maxToolCallRounds: 1 }).pipe(
    Layer.provideMerge(Layer.succeed(ModelToolCallBarrierRepository)(barrier)),
    Layer.provideMerge(Layer.succeed(ModelToolContinuation)(continuation)),
    Layer.provideMerge(Layer.succeed(ToolCallRepository)(makeToolRepository(events))),
    Layer.provideMerge(
      Layer.succeed(NonActionToolCallExecutor)({
        execute: () =>
          Ref.update(events, (current) => [...current, "execute"]).pipe(Effect.as(toolOutcome)),
      }),
    ),
  );
};

describe("AgentRun model to tools to model loop", () => {
  it.effect(
    "commits the model barrier before executor contact and continues with typed outcomes",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const finalTurn = {
          attempt: { ...attempt, modelCallAttemptId: "28a8f757-836b-4896-b45d-6e2c34fd6436" },
          outcome: {
            completion: { type: "text" as const },
            dispatchEvidence: { type: "confirmed" as const },
            usage: { type: "unknown" as const },
          },
        };
        const continuation: ModelToolContinuationService = {
          continueAfterToolCallBatch: ({ outcomes }) =>
            Ref.update(events, (current) => [...current, "continue"]).pipe(
              Effect.andThen(
                outcomes[0]?.outcome.type === "succeeded"
                  ? Effect.succeed(finalTurn)
                  : Effect.die("test fixture omitted the ToolCall outcome"),
              ),
            ),
        };

        const result = yield* AgentRunToolLoop.use((loop) => loop.drive(fence, initialTurn)).pipe(
          Effect.provide(makeLayer(events, continuation)),
        );

        expect(result).toEqual(finalTurn);
        expect(yield* Ref.get(events)).toEqual([
          "barrier",
          "claim",
          "execute",
          "claim",
          "continue",
        ]);
      }),
  );

  it.effect("fails closed before a second ToolCall round exceeds the configured bound", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const continuation: ModelToolContinuationService = {
        continueAfterToolCallBatch: () => Effect.succeed(initialTurn),
      };
      const exit = yield* Effect.exit(
        AgentRunToolLoop.use((loop) => loop.drive(fence, initialTurn)).pipe(
          Effect.provide(makeLayer(events, continuation)),
        ),
      );
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

      expect(Option.isSome(error) ? error.value._tag : undefined).toBe("AgentRunToolLoopError");
      expect(Option.isSome(error) ? error.value.cause : undefined).toBe(
        "toolCallRoundLimitExceeded",
      );
      expect(yield* Ref.get(events)).toEqual(["barrier", "claim", "execute", "claim"]);
    }),
  );
});

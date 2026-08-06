import { describe, expect, it } from "@effect/vitest";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { Effect, Layer, Stream } from "effect";
import {
  AgentRunRepository,
  AgentRunRepositoryUnavailable,
  AgentRunWorker,
  ModelCallExecutionError,
  ModelCallExecutor,
  makeAgentRunWorkerLayer,
  type AgentRunRepositoryService,
} from "../src/index.js";

const delivery = {
  version: 1,
  deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  executionProfileRef: "oz.deterministic.v1",
} as const;

const fence = {
  agentRunId: delivery.agentRunId,
  workerId: "worker-a",
  claimEpoch: "1",
} as const;

const prepared = {
  modelCallId: "1d27079d-635d-47e2-ab68-588fff581e3e",
  modelBinding: "oz.deterministic.echo.v1",
  prompt: "Hello, Oz",
} as const;

const attempt = {
  ...prepared,
  assistantOutputId: "86290831-b9ca-414a-abf1-4055b5347133",
  modelCallAttemptId: "866688f2-5f9f-44b7-83d1-3c4ef6fd301b",
  attemptNumber: 1,
  usage: { type: "unknown" },
} as const;

const makeRepository = () => {
  const calls: Array<string> = [];
  let modelCallState: "notStarted" | "pending" | "succeeded" | "failed" = "notStarted";
  const service: AgentRunRepositoryService = {
    claimAgentRun: () =>
      Effect.sync(() => {
        calls.push("claim");
        return { type: "claimed" as const, fence };
      }),
    loadRecordedState: () =>
      Effect.sync(() => {
        calls.push("load");
        return {
          agentRunId: delivery.agentRunId,
          executionProfileRef: "oz.deterministic.v1",
          userMessage: "Hello, Oz",
          modelCall:
            modelCallState === "notStarted"
              ? ({ type: "notStarted" } as const)
              : modelCallState === "pending"
                ? ({
                    type: "pending",
                    modelCallId: prepared.modelCallId,
                    prompt: prepared.prompt,
                  } as const)
                : modelCallState === "succeeded"
                  ? ({ type: "succeeded", modelCallId: prepared.modelCallId } as const)
                  : ({
                      type: "failed",
                      modelCallId: prepared.modelCallId,
                      cause: "modelCallFailed",
                    } as const),
        };
      }),
    ensureModelCall: () =>
      Effect.sync(() => {
        calls.push("intent");
        modelCallState = "pending";
        return prepared;
      }),
    beginModelCallAttempt: () =>
      Effect.sync(() => {
        calls.push("attempt");
        return attempt;
      }),
    appendModelOutput: (_fence, _attempt, observation) =>
      Effect.sync(() => {
        calls.push(`fragment:${observation.fragmentIndex}:${observation.text}`);
      }),
    completeModelCall: () =>
      Effect.sync(() => {
        calls.push("output:completed");
        modelCallState = "succeeded";
      }),
    interruptModelCall: () =>
      Effect.sync(() => {
        calls.push("output:interrupted");
        modelCallState = "failed";
      }),
    commitTerminal: (_fence, decision) =>
      Effect.sync(() => {
        calls.push(`run:${decision.type === "succeed" ? "succeeded" : "failed"}`);
      }),
    selectPublication: () => Effect.succeed({ type: "none" as const }),
    claimPublication: () => Effect.succeed({ type: "none" as const }),
    confirmPublication: () => Effect.void,
  };
  return { calls, service };
};

describe("AgentRun worker", () => {
  it.effect(
    "carries one delivery identity through committed output to one terminal outcome",
    () => {
      const repository = makeRepository();
      const executor = ModelCallExecutor.of({
        execute: () =>
          Stream.make(
            { fragmentIndex: 0, text: "Echo: " },
            { fragmentIndex: 1, text: "Hello, Oz" },
          ),
      });
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 30_000,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(repository.service)),
        Layer.provide(Layer.succeed(ModelCallExecutor)(executor)),
        Layer.provide(
          makeDeterministicAgentRuntimeLayer({
            executionProfileRef: "oz.deterministic.v1",
            modelBinding: "oz.deterministic.echo.v1",
          }),
        ),
      );

      return Effect.gen(function* () {
        const disposition = yield* AgentRunWorker.use((worker) => worker.handle(delivery));

        expect(disposition).toEqual({ type: "acknowledge", outcome: "succeeded" });
        expect(repository.calls).toEqual([
          "claim",
          "load",
          "intent",
          "attempt",
          "fragment:0:Echo: ",
          "fragment:1:Hello, Oz",
          "output:completed",
          "load",
          "run:succeeded",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("asks Pub/Sub to retry while another finite claim is authoritative", () => {
    const repository = makeRepository();
    const busy = {
      ...repository.service,
      claimAgentRun: () => Effect.succeed({ type: "busy" as const }),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-b",
      leaseDurationMs: 30_000,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(busy)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(ModelCallExecutor.of({ execute: () => Stream.empty })),
      ),
      Layer.provide(
        makeDeterministicAgentRuntimeLayer({
          executionProfileRef: "oz.deterministic.v1",
          modelBinding: "oz.deterministic.echo.v1",
        }),
      ),
    );

    return Effect.gen(function* () {
      const disposition = yield* AgentRunWorker.use((worker) => worker.handle(delivery));
      expect(disposition).toEqual({ type: "retry" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an incompatible execution profile before claiming the AgentRun", () => {
    const repository = makeRepository();
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v2",
      workerId: "worker-b",
      leaseDurationMs: 30_000,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(repository.service)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(ModelCallExecutor.of({ execute: () => Stream.empty })),
      ),
      Layer.provide(
        makeDeterministicAgentRuntimeLayer({
          executionProfileRef: "oz.deterministic.v2",
          modelBinding: "oz.deterministic.echo.v1",
        }),
      ),
    );

    return Effect.gen(function* () {
      const disposition = yield* AgentRunWorker.use((worker) => worker.handle(delivery));
      expect(disposition).toEqual({ type: "retry" });
      expect(repository.calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("interrupts partial output before committing a failed AgentRun", () => {
    const repository = makeRepository();
    const executor = ModelCallExecutor.of({
      execute: () =>
        Stream.make({ fragmentIndex: 0, text: "Partial" }).pipe(
          Stream.concat(
            Stream.fail(new ModelCallExecutionError({ cause: "provider unavailable" })),
          ),
        ),
    });
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(repository.service)),
      Layer.provide(Layer.succeed(ModelCallExecutor)(executor)),
      Layer.provide(
        makeDeterministicAgentRuntimeLayer({
          executionProfileRef: "oz.deterministic.v1",
          modelBinding: "oz.deterministic.echo.v1",
        }),
      ),
    );

    return Effect.gen(function* () {
      const disposition = yield* AgentRunWorker.use((worker) => worker.handle(delivery));

      expect(disposition).toEqual({ type: "acknowledge", outcome: "failed" });
      expect(repository.calls).toEqual([
        "claim",
        "load",
        "intent",
        "attempt",
        "fragment:0:Partial",
        "output:interrupted",
        "load",
        "run:failed",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retries without misclassifying a fragment persistence failure", () => {
    const repository = makeRepository();
    const unavailable = {
      ...repository.service,
      appendModelOutput: () =>
        Effect.fail(new AgentRunRepositoryUnavailable({ cause: "database unavailable" })),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(unavailable)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          ModelCallExecutor.of({
            execute: () => Stream.make({ fragmentIndex: 0, text: "Partial" }),
          }),
        ),
      ),
      Layer.provide(
        makeDeterministicAgentRuntimeLayer({
          executionProfileRef: "oz.deterministic.v1",
          modelBinding: "oz.deterministic.echo.v1",
        }),
      ),
    );

    return Effect.gen(function* () {
      const disposition = yield* AgentRunWorker.use((worker) => worker.handle(delivery));
      expect(disposition).toEqual({ type: "retry" });
      expect(repository.calls).toEqual(["claim", "load", "intent", "attempt"]);
    }).pipe(Effect.provide(layer));
  });
});

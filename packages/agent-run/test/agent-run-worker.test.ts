import { describe, expect, it } from "@effect/vitest";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { Clock, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  AgentRunCancellationObserved,
  AgentRunFenceRejected,
  AgentRunRepository,
  AgentRunRepositoryUnavailable,
  AgentRunWorker,
  ModelCallExecutionError,
  ModelCallExecutor,
  makeAgentRunWorkerLayer,
  type AgentRunCleanupResult,
  type AgentRunRepositoryService,
  type ModelCallAttempt,
  type ModelCallObservation,
} from "../src/index.js";

const delivery = {
  version: 1,
  deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  threadId: "512e5093-0051-4f82-b452-78d907ead08c",
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

const cancelConfirmed = () => Effect.succeed({ type: "confirmedStopped" as const });
const unknownAttemptOutcome = {
  dispatchEvidence: { type: "confirmed" as const },
  usage: { type: "unknown" as const },
};

const makeExecutor = (
  service: Pick<ModelCallExecutor["Service"], "cancel"> & {
    readonly execute: (
      attempt: ModelCallAttempt,
    ) => Stream.Stream<ModelCallObservation, ModelCallExecutionError>;
    readonly outcome?: ModelCallExecutor["Service"]["outcome"];
    readonly terminate?: ModelCallExecutor["Service"]["terminate"];
  },
) =>
  ModelCallExecutor.of({
    cancel: service.cancel,
    execute: (attempt) => Effect.succeed(service.execute(attempt)),
    outcome:
      service.outcome ??
      (() =>
        Effect.succeed({
          dispatchEvidence: { type: "confirmed" as const },
          usage: { type: "unknown" as const },
        })),
    terminate: service.terminate ?? (() => Effect.void),
  });

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
        return { type: "started" as const, attempt };
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
    recordModelCallCleanup: () => Effect.void,
    loadCancellation: () =>
      Effect.succeed({
        cleanupDeadlineAtEpochMs: Date.now() + 30_000,
        startedModelCallAttemptIds: [attempt.modelCallAttemptId],
      }),
    renewLease: () => Effect.void,
    commitTerminal: (_fence, decision) =>
      Effect.sync(() => {
        calls.push(`run:${decision.type === "succeed" ? "succeeded" : "failed"}`);
      }),
    commitCancellation: (_fence, cleanup) =>
      Effect.sync(() => {
        calls.push("run:canceled");
        return cleanup;
      }),
    selectPublication: () => Effect.succeed({ type: "none" as const }),
    claimPublication: () => Effect.succeed({ type: "none" as const }),
    confirmPublication: () => Effect.void,
  };
  return { calls, service };
};

describe("AgentRun worker", () => {
  it.effect("applies the profile attempt limit and commits normalized attempt evidence", () => {
    const repository = makeRepository();
    let observedAttemptLimit: number | undefined;
    let observedOutcome: unknown;
    const accountable = {
      ...repository.service,
      beginModelCallAttempt: (_fence, _modelCall, attemptLimit?: number) => {
        observedAttemptLimit = attemptLimit;
        return Effect.succeed({ type: "started" as const, attempt });
      },
      completeModelCall: (activeFence, activeAttempt, outcome) =>
        Effect.sync(() => {
          observedOutcome = outcome;
        }).pipe(
          Effect.andThen(
            repository.service.completeModelCall(activeFence, activeAttempt, unknownAttemptOutcome),
          ),
        ),
    } satisfies AgentRunRepositoryService;
    const executor = makeExecutor({
      cancel: cancelConfirmed,
      execute: () => Stream.empty,
      outcome: () =>
        Effect.succeed({
          dispatchEvidence: {
            type: "confirmed" as const,
            providerRequestId: "resp_accountable",
          },
          usage: { type: "reported" as const, inputUnits: 3, outputUnits: 2 },
        }),
    });
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      modelCallAttemptLimit: 1,
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(accountable)),
      Layer.provide(Layer.succeed(ModelCallExecutor)(executor)),
      Layer.provide(
        makeDeterministicAgentRuntimeLayer({
          executionProfileRef: "oz.deterministic.v1",
          modelBinding: "oz.deterministic.echo.v1",
        }),
      ),
    );

    return Effect.gen(function* () {
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "acknowledge",
        outcome: "succeeded",
      });
      expect(observedAttemptLimit).toBe(1);
      expect(observedOutcome).toEqual({
        dispatchEvidence: { type: "confirmed", providerRequestId: "resp_accountable" },
        usage: { type: "reported", inputUnits: 3, outputUnits: 2 },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "carries one delivery identity through committed output to one terminal outcome",
    () => {
      const repository = makeRepository();
      const executor = makeExecutor({
        cancel: cancelConfirmed,
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
        leaseRenewalIntervalMs: 10_000,
        cancellationPollIntervalMs: 5,
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
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(busy)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({ cancel: cancelConfirmed, execute: () => Stream.empty }),
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
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an incompatible execution profile before claiming the AgentRun", () => {
    const repository = makeRepository();
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v2",
      workerId: "worker-b",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(repository.service)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({ cancel: cancelConfirmed, execute: () => Stream.empty }),
        ),
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
    const executor = makeExecutor({
      cancel: cancelConfirmed,
      execute: () =>
        Stream.make({ fragmentIndex: 0, text: "Partial" }).pipe(
          Stream.concat(
            Stream.fail(
              new ModelCallExecutionError({
                cause: "provider unavailable",
                dispatchEvidence: { type: "uncertain" },
                usage: { type: "unknown" },
              }),
            ),
          ),
        ),
    });
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
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
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(unavailable)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            cancel: cancelConfirmed,
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

  it.effect("stops ordinary output and completes cleanup when cancellation wins", () => {
    const repository = makeRepository();
    const cancellation = {
      ...repository.service,
      appendModelOutput: (_fence, _attempt, observation) =>
        observation.fragmentIndex === 0
          ? Effect.sync(() => repository.calls.push("fragment:0:Partial"))
          : Effect.fail(new AgentRunCancellationObserved()),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            cancel: cancelConfirmed,
            execute: () =>
              Stream.make(
                { fragmentIndex: 0, text: "Partial" },
                { fragmentIndex: 1, text: "must not commit" },
              ),
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

      expect(disposition).toEqual({ type: "acknowledge", outcome: "canceled" });
      expect(repository.calls).toEqual([
        "claim",
        "load",
        "intent",
        "attempt",
        "fragment:0:Partial",
        "run:canceled",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("interrupts a silent executor when fenced cancellation is observed", () => {
    const repository = makeRepository();
    const cancellation = {
      ...repository.service,
      renewLease: () =>
        Effect.gen(function* () {
          repository.calls.push("poll:canceled");
          return yield* new AgentRunCancellationObserved();
        }),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 1,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({ cancel: cancelConfirmed, execute: () => Stream.never }),
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

      expect(disposition).toEqual({ type: "acknowledge", outcome: "canceled" });
      expect(repository.calls).toEqual([
        "claim",
        "load",
        "intent",
        "attempt",
        "poll:canceled",
        "run:canceled",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("returns after maintenance failure only after provider execution settles", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const executionStarted = yield* Deferred.make<void>();
      const finalizerCompleted = yield* Deferred.make<void>();
      const providerStopped = yield* Deferred.make<void>();
      let activeExecutions = 0;
      let cancellationCalls = 0;
      let renewalCount = 0;
      let recordedCleanup: AgentRunCleanupResult | undefined;
      const unavailable = {
        ...repository.service,
        renewLease: () =>
          Effect.suspend(() => {
            renewalCount += 1;
            return renewalCount === 1
              ? Effect.void
              : Deferred.await(executionStarted).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new AgentRunRepositoryUnavailable({ cause: "database unavailable" }),
                    ),
                  ),
                );
          }),
        recordModelCallCleanup: (_fence, _attempt, cleanup) =>
          Effect.sync(() => {
            recordedCleanup = cleanup;
          }),
      } satisfies AgentRunRepositoryService;
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 30_000,
        leaseRenewalIntervalMs: 10_000,
        cancellationPollIntervalMs: 5,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(unavailable)),
        Layer.provide(
          Layer.succeed(ModelCallExecutor)(
            makeExecutor({
              execute: () => {
                activeExecutions += 1;
                Deferred.doneUnsafe(executionStarted, Effect.void);
                return Stream.fromEffect(Deferred.await(providerStopped)).pipe(
                  Stream.drain,
                  Stream.ensuring(
                    Effect.sync(() => {
                      activeExecutions -= 1;
                    }).pipe(Effect.andThen(Deferred.succeed(finalizerCompleted, undefined))),
                  ),
                );
              },
              cancel: () =>
                Effect.sync(() => {
                  cancellationCalls += 1;
                  return { type: "confirmedStopped" as const };
                }),
              terminate: () => Deferred.succeed(providerStopped, undefined),
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

      const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      const disposition = yield* Fiber.join(running);

      expect(disposition).toEqual({ type: "retry" });
      expect(cancellationCalls).toBe(1);
      expect(recordedCleanup).toEqual({
        cleanupDisposition: { type: "completed" },
        externalWorkMayContinue: false,
      });
      yield* Deferred.await(finalizerCompleted);
      expect(activeExecutions).toBe(0);
    }),
  );

  it.effect("cleans provider ownership exactly once when cancellation loading fails", () => {
    const repository = makeRepository();
    let cancellationCalls = 0;
    let cleanupWrites = 0;
    const unavailable = {
      ...repository.service,
      appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
      loadCancellation: () =>
        Effect.fail(new AgentRunRepositoryUnavailable({ cause: "cancellation unavailable" })),
      recordModelCallCleanup: () =>
        Effect.sync(() => {
          cleanupWrites += 1;
        }),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(unavailable)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            execute: () => Stream.make({ fragmentIndex: 0, text: "cancel" }),
            cancel: () =>
              Effect.sync(() => {
                cancellationCalls += 1;
                return { type: "confirmedStopped" as const };
              }),
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
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "retry",
      });
      expect(cancellationCalls).toBe(1);
      expect(cleanupWrites).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not repeat provider cleanup when cleanup persistence is fenced", () => {
    const repository = makeRepository();
    let cancellationCalls = 0;
    let cleanupWrites = 0;
    const fenced = {
      ...repository.service,
      appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
      recordModelCallCleanup: () =>
        Effect.sync(() => {
          cleanupWrites += 1;
        }).pipe(Effect.andThen(Effect.fail(new AgentRunFenceRejected()))),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(fenced)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            execute: () => Stream.make({ fragmentIndex: 0, text: "cancel" }),
            cancel: () =>
              Effect.sync(() => {
                cancellationCalls += 1;
                return { type: "confirmedStopped" as const };
              }),
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
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "retry",
      });
      expect(cancellationCalls).toBe(1);
      expect(cleanupWrites).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not repeat provider cleanup when cancellation commit fails", () => {
    const repository = makeRepository();
    let cancellationCalls = 0;
    let cleanupWrites = 0;
    let terminalCommits = 0;
    const unavailable = {
      ...repository.service,
      appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
      recordModelCallCleanup: () =>
        Effect.sync(() => {
          cleanupWrites += 1;
        }),
      commitCancellation: () =>
        Effect.sync(() => {
          terminalCommits += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(new AgentRunRepositoryUnavailable({ cause: "commit unavailable" })),
          ),
        ),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(unavailable)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            execute: () => Stream.make({ fragmentIndex: 0, text: "cancel" }),
            cancel: () =>
              Effect.sync(() => {
                cancellationCalls += 1;
                return { type: "confirmedStopped" as const };
              }),
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
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "retry",
      });
      expect(cancellationCalls).toBe(1);
      expect(cleanupWrites).toBe(1);
      expect(terminalCommits).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not retry a permanently fenced cleanup write", () => {
    const repository = makeRepository();
    let cleanupWrites = 0;
    const fenced = {
      ...repository.service,
      appendModelOutput: () =>
        Effect.fail(new AgentRunRepositoryUnavailable({ cause: "database unavailable" })),
      recordModelCallCleanup: () =>
        Effect.sync(() => {
          cleanupWrites += 1;
        }).pipe(Effect.andThen(Effect.fail(new AgentRunFenceRejected()))),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(fenced)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            cancel: cancelConfirmed,
            execute: () => Stream.make({ fragmentIndex: 0, text: "unavailable" }),
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
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "retry",
      });
      expect(cleanupWrites).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns after cleanup timeout only after the cancellation effect settles", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupFinalizerCompleted = yield* Deferred.make<void>();
      const cleanupStopped = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const cleanupDeadlineAtEpochMs = (yield* Clock.currentTimeMillis) + 1_000;
      let activeCleanups = 0;
      const cancellation = {
        ...repository.service,
        appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
        loadCancellation: () =>
          Effect.succeed({
            cleanupDeadlineAtEpochMs,
            startedModelCallAttemptIds: [attempt.modelCallAttemptId],
          }),
        commitCancellation: (_fence, cleanup: AgentRunCleanupResult) =>
          Deferred.succeed(committed, undefined).pipe(Effect.as(cleanup)),
      } satisfies AgentRunRepositoryService;
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 30_000,
        leaseRenewalIntervalMs: 10_000,
        cancellationPollIntervalMs: 5,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
        Layer.provide(
          Layer.succeed(ModelCallExecutor)(
            makeExecutor({
              execute: () => Stream.make({ fragmentIndex: 0, text: "cancel" }),
              cancel: () =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    activeCleanups += 1;
                  }).pipe(Effect.andThen(Deferred.succeed(cleanupStarted, undefined))),
                  () =>
                    Deferred.await(cleanupStopped).pipe(
                      Effect.as({ type: "confirmedStopped" as const }),
                      Effect.uninterruptible,
                    ),
                  () =>
                    Effect.sync(() => {
                      activeCleanups -= 1;
                    }).pipe(Effect.andThen(Deferred.succeed(cleanupFinalizerCompleted, undefined))),
                ),
              terminate: () => Deferred.succeed(cleanupStopped, undefined),
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

      const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(cleanupStarted);
      yield* TestClock.adjust(1_000);
      yield* Deferred.await(committed);
      const disposition = yield* Fiber.join(running);

      expect(disposition).toEqual({ type: "acknowledge", outcome: "canceled" });
      yield* Deferred.await(cleanupFinalizerCompleted);
      expect(activeCleanups).toBe(0);
    }),
  );

  it.live("terminalizes cancellation only after an uninterruptible executor settles", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const committed = yield* Deferred.make<void>();
      const executionStarted = yield* Deferred.make<void>();
      const executionSettled = yield* Deferred.make<void>();
      const releaseExecution = yield* Deferred.make<void>();
      let activeExecutions = 0;
      let renewalCount = 0;
      const cancellation = {
        ...repository.service,
        renewLease: () =>
          Effect.suspend(() => {
            renewalCount += 1;
            return renewalCount === 1
              ? Effect.void
              : Deferred.await(executionStarted).pipe(
                  Effect.andThen(Effect.fail(new AgentRunCancellationObserved())),
                );
          }),
        commitCancellation: () =>
          Deferred.succeed(committed, undefined).pipe(
            Effect.as({
              cleanupDisposition: { type: "completed" as const },
              externalWorkMayContinue: true,
            }),
          ),
      } satisfies AgentRunRepositoryService;
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 30_000,
        leaseRenewalIntervalMs: 10_000,
        cancellationPollIntervalMs: 1,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
        Layer.provide(
          Layer.succeed(ModelCallExecutor)(
            makeExecutor({
              cancel: cancelConfirmed,
              execute: () => {
                activeExecutions += 1;
                Deferred.doneUnsafe(executionStarted, Effect.void);
                return Stream.fromEffect(
                  Deferred.await(releaseExecution).pipe(Effect.uninterruptible),
                ).pipe(
                  Stream.drain,
                  Stream.ensuring(
                    Effect.sync(() => {
                      activeExecutions -= 1;
                    }).pipe(Effect.andThen(Deferred.succeed(executionSettled, undefined))),
                  ),
                );
              },
              terminate: () => Deferred.succeed(releaseExecution, undefined),
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

      const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(committed);
      const disposition = yield* Fiber.join(running);

      expect(disposition).toEqual({ type: "acknowledge", outcome: "canceled" });
      yield* Deferred.await(executionSettled);
      expect(activeExecutions).toBe(0);
    }),
  );

  it.effect("persists the executor's explicit external-work cancellation acknowledgement", () => {
    const repository = makeRepository();
    let cleanup: AgentRunCleanupResult | undefined;
    const cancellation = {
      ...repository.service,
      appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
      loadCancellation: () =>
        Effect.succeed({
          cleanupDeadlineAtEpochMs: Date.now() + 30_000,
          startedModelCallAttemptIds: [attempt.modelCallAttemptId],
        }),
      commitCancellation: (_fence, result: AgentRunCleanupResult) =>
        Effect.sync(() => {
          cleanup = result;
          return result;
        }),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            execute: () => Stream.make({ fragmentIndex: 0, text: "must not commit" }),
            cancel: () => Effect.succeed({ type: "confirmedStopped" as const }),
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
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "acknowledge",
        outcome: "canceled",
      });
      expect(cleanup).toEqual({
        cleanupDisposition: { type: "completed" },
        externalWorkMayContinue: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not start executor cancellation after the cleanup deadline has expired", () => {
    const repository = makeRepository();
    let cancellationCalls = 0;
    let cleanup: AgentRunCleanupResult | undefined;
    let terminationCalls = 0;
    const cancellation = {
      ...repository.service,
      appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
      loadCancellation: () =>
        Effect.succeed({
          cleanupDeadlineAtEpochMs: 0,
          startedModelCallAttemptIds: [attempt.modelCallAttemptId],
        }),
      commitCancellation: (_fence, result: AgentRunCleanupResult) =>
        Effect.sync(() => {
          cleanup = result;
          return result;
        }),
    } satisfies AgentRunRepositoryService;
    const layer = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      leaseRenewalIntervalMs: 10_000,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
      Layer.provide(
        Layer.succeed(ModelCallExecutor)(
          makeExecutor({
            execute: () => Stream.make({ fragmentIndex: 0, text: "must not commit" }),
            cancel: () =>
              Effect.sync(() => {
                cancellationCalls += 1;
                return { type: "confirmedStopped" as const };
              }),
            terminate: () =>
              Effect.sync(() => {
                terminationCalls += 1;
              }),
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
      expect(yield* AgentRunWorker.use((worker) => worker.handle(delivery))).toEqual({
        type: "acknowledge",
        outcome: "canceled",
      });
      expect(cancellationCalls).toBe(0);
      expect(terminationCalls).toBe(1);
      expect(cleanup).toEqual({
        cleanupDisposition: { type: "deadlineExceeded" },
        externalWorkMayContinue: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "commits deadline-exceeded when executor cleanup cannot confirm before its deadline",
    () =>
      Effect.gen(function* () {
        const repository = makeRepository();
        const committed = yield* Deferred.make<AgentRunCleanupResult>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupSettled = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const cleanupDeadlineAtEpochMs = (yield* Clock.currentTimeMillis) + 1_000;
        let activeCleanups = 0;
        const cancellation = {
          ...repository.service,
          appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
          loadCancellation: () =>
            Effect.succeed({
              cleanupDeadlineAtEpochMs,
              startedModelCallAttemptIds: [attempt.modelCallAttemptId],
            }),
          commitCancellation: (_fence, result: AgentRunCleanupResult) =>
            Deferred.succeed(committed, result).pipe(Effect.as(result)),
        } satisfies AgentRunRepositoryService;
        const layer = makeAgentRunWorkerLayer({
          executionProfileRef: "oz.deterministic.v1",
          workerId: "worker-a",
          leaseDurationMs: 30_000,
          leaseRenewalIntervalMs: 10_000,
          cancellationPollIntervalMs: 5,
        }).pipe(
          Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
          Layer.provide(
            Layer.succeed(ModelCallExecutor)(
              makeExecutor({
                execute: () => Stream.make({ fragmentIndex: 0, text: "must not commit" }),
                cancel: () =>
                  Effect.sync(() => {
                    activeCleanups += 1;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(cleanupStarted, undefined)),
                    Effect.andThen(Deferred.await(releaseCleanup)),
                    Effect.as({ type: "confirmedStopped" as const }),
                    Effect.uninterruptible,
                    Effect.ensuring(
                      Effect.sync(() => {
                        activeCleanups -= 1;
                      }).pipe(Effect.andThen(Deferred.succeed(cleanupSettled, undefined))),
                    ),
                  ),
                terminate: () => Deferred.succeed(releaseCleanup, undefined),
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

        const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );
        yield* Deferred.await(cleanupStarted);
        yield* TestClock.adjust(1_000);
        const cleanup = yield* Deferred.await(committed);
        const disposition = yield* Fiber.join(running);

        expect(cleanup).toEqual({
          cleanupDisposition: { type: "deadlineExceeded" },
          externalWorkMayContinue: true,
        });
        expect(disposition).toEqual({ type: "acknowledge", outcome: "canceled" });
        yield* Deferred.await(cleanupSettled);
        expect(activeCleanups).toBe(0);
      }),
  );

  it.live("settles provider execution before a later delivery starts new work", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const firstExecutionStarted = yield* Deferred.make<void>();
      const firstExecutionSettled = yield* Deferred.make<void>();
      const releaseFirstExecution = yield* Deferred.make<void>();
      let executionCount = 0;
      let renewalCount = 0;
      const cancellation = {
        ...repository.service,
        renewLease: () =>
          Effect.suspend(() => {
            renewalCount += 1;
            return renewalCount === 1
              ? Effect.void
              : renewalCount === 2
                ? Deferred.await(firstExecutionStarted).pipe(
                    Effect.andThen(Effect.fail(new AgentRunCancellationObserved())),
                  )
                : Effect.void;
          }),
      } satisfies AgentRunRepositoryService;
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 30_000,
        leaseRenewalIntervalMs: 10_000,
        cancellationPollIntervalMs: 5,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(cancellation)),
        Layer.provide(
          Layer.succeed(ModelCallExecutor)(
            makeExecutor({
              cancel: cancelConfirmed,
              execute: () => {
                executionCount += 1;
                if (executionCount === 1) {
                  Deferred.doneUnsafe(firstExecutionStarted, Effect.void);
                  return Stream.fromEffect(
                    Deferred.await(releaseFirstExecution).pipe(Effect.uninterruptible),
                  ).pipe(
                    Stream.drain,
                    Stream.ensuring(Deferred.succeed(firstExecutionSettled, undefined)),
                  );
                }
                return Stream.empty;
              },
              terminate: () => Deferred.succeed(releaseFirstExecution, undefined),
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

      return yield* Effect.gen(function* () {
        const first = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(firstExecutionStarted);
        expect(yield* Fiber.join(first)).toEqual({
          type: "acknowledge",
          outcome: "canceled",
        });
        yield* Deferred.await(firstExecutionSettled);

        const second = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
          Effect.forkChild,
        );
        expect(yield* Fiber.join(second)).toEqual({
          type: "acknowledge",
          outcome: "succeeded",
        });
        expect(executionCount).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("renews the fenced lease beyond its original deadline", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const executionStarted = yield* Deferred.make<void>();
      const postOriginalDeadlineRenewed = yield* Deferred.make<void>();
      let originalLeaseDeadlineAt: number | undefined;
      const renewing = {
        ...repository.service,
        renewLease: (_fence, leaseDurationMs) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => {
              repository.calls.push("lease:renewed");
              if (originalLeaseDeadlineAt === undefined) {
                originalLeaseDeadlineAt = now + leaseDurationMs;
                return Effect.void;
              }
              return now >= originalLeaseDeadlineAt
                ? Deferred.succeed(postOriginalDeadlineRenewed, undefined)
                : Effect.void;
            }),
          ),
      } satisfies AgentRunRepositoryService;
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 300,
        leaseRenewalIntervalMs: 50,
        cancellationPollIntervalMs: 1,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(renewing)),
        Layer.provide(
          Layer.succeed(ModelCallExecutor)(
            makeExecutor({
              execute: () =>
                Stream.fromEffect(
                  Deferred.succeed(executionStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(postOriginalDeadlineRenewed)),
                  ),
                ).pipe(Stream.map(() => ({ fragmentIndex: 0, text: "renewed" }))),
              cancel: () => Effect.succeed({ type: "confirmedStopped" }),
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

      const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(executionStarted);
      yield* TestClock.adjust(300);
      yield* Deferred.await(postOriginalDeadlineRenewed);
      const completed = yield* Fiber.join(running);

      expect(completed).toEqual({ type: "acknowledge", outcome: "succeeded" });
      expect(repository.calls).toContain("lease:renewed");
    }),
  );
});

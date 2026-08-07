import { describe, expect, it } from "@effect/vitest";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import {
  AgentRunCancellationObserved,
  AgentRunRepository,
  AgentRunRepositoryUnavailable,
  AgentRunWorker,
  ModelCallExecutionError,
  ModelCallExecutor,
  makeAgentRunWorkerLayer,
  type AgentRunCleanupResult,
  type AgentRunRepositoryService,
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
  it.effect(
    "carries one delivery identity through committed output to one terminal outcome",
    () => {
      const repository = makeRepository();
      const executor = ModelCallExecutor.of({
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
          ModelCallExecutor.of({ cancel: cancelConfirmed, execute: () => Stream.empty }),
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
          ModelCallExecutor.of({ cancel: cancelConfirmed, execute: () => Stream.empty }),
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
    const executor = ModelCallExecutor.of({
      cancel: cancelConfirmed,
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
          ModelCallExecutor.of({
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
          ModelCallExecutor.of({
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
          ModelCallExecutor.of({ cancel: cancelConfirmed, execute: () => Stream.never }),
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

  it.live("keeps maintenance-failed executor resources tracked until they settle", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const executionStarted = yield* Deferred.make<void>();
      const finalizerStarted = yield* Deferred.make<void>();
      const releaseFinalizer = yield* Deferred.make<void>();
      let activeExecutions = 0;
      let cancellationCalls = 0;
      let recordedCleanup: AgentRunCleanupResult | undefined;
      const unavailable = {
        ...repository.service,
        renewLease: () =>
          Deferred.await(executionStarted).pipe(
            Effect.andThen(
              Effect.fail(new AgentRunRepositoryUnavailable({ cause: "database unavailable" })),
            ),
          ),
        recordModelCallCleanup: (_attempt, cleanup) =>
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
            ModelCallExecutor.of({
              execute: () =>
                Stream.fromEffect(
                  Effect.sync(() => {
                    activeExecutions += 1;
                  }).pipe(Effect.andThen(Deferred.succeed(executionStarted, undefined))),
                ).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                  Stream.ensuring(
                    Deferred.succeed(finalizerStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFinalizer)),
                      Effect.andThen(
                        Effect.sync(() => {
                          activeExecutions -= 1;
                        }),
                      ),
                    ),
                  ),
                ),
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

      const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(finalizerStarted);
      const returnedBeforeRelease = yield* Fiber.await(running).pipe(Effect.timeoutOption(10));

      expect(Option.isNone(returnedBeforeRelease)).toBe(true);
      expect(cancellationCalls).toBe(1);
      expect(recordedCleanup).toEqual({
        cleanupDisposition: { type: "completed" },
        externalWorkMayContinue: false,
      });
      yield* Deferred.succeed(releaseFinalizer, undefined);
      expect(yield* Fiber.join(running)).toEqual({ type: "retry" });
      expect(activeExecutions).toBe(0);
    }),
  );

  it.live("keeps timed-out cleanup resources tracked until they settle", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupFinalizerStarted = yield* Deferred.make<void>();
      const releaseCleanupFinalizer = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      let activeCleanups = 0;
      const cancellation = {
        ...repository.service,
        appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
        loadCancellation: () =>
          Effect.succeed({
            cleanupDeadlineAtEpochMs: Date.now() + 20,
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
            ModelCallExecutor.of({
              execute: () => Stream.make({ fragmentIndex: 0, text: "cancel" }),
              cancel: () =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    activeCleanups += 1;
                  }).pipe(Effect.andThen(Deferred.succeed(cleanupStarted, undefined))),
                  () => Effect.never,
                  () =>
                    Deferred.succeed(cleanupFinalizerStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseCleanupFinalizer)),
                      Effect.andThen(
                        Effect.sync(() => {
                          activeCleanups -= 1;
                        }),
                      ),
                    ),
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

      const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(cleanupStarted);
      yield* Deferred.await(committed);
      yield* Deferred.await(cleanupFinalizerStarted);
      const returnedBeforeRelease = yield* Fiber.await(running).pipe(Effect.timeoutOption(10));

      expect(Option.isNone(returnedBeforeRelease)).toBe(true);
      yield* Deferred.succeed(releaseCleanupFinalizer, undefined);
      expect(yield* Fiber.join(running)).toEqual({
        type: "acknowledge",
        outcome: "canceled",
      });
      expect(activeCleanups).toBe(0);
    }),
  );

  it.live("terminalizes cancellation while keeping an uninterruptible executor tracked", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const committed = yield* Deferred.make<void>();
      const executionStarted = yield* Deferred.make<void>();
      const releaseExecution = yield* Deferred.make<void>();
      const cancellation = {
        ...repository.service,
        renewLease: () =>
          Deferred.await(executionStarted).pipe(
            Effect.andThen(Effect.fail(new AgentRunCancellationObserved())),
          ),
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
            ModelCallExecutor.of({
              cancel: cancelConfirmed,
              execute: () =>
                Stream.fromEffect(
                  Deferred.succeed(executionStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseExecution)),
                    Effect.uninterruptible,
                  ),
                ).pipe(Stream.drain),
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
      const terminalized = yield* Deferred.await(committed).pipe(Effect.timeoutOption(50));
      const returnedBeforeRelease = yield* Fiber.await(running).pipe(Effect.timeoutOption(10));

      expect(Option.isSome(terminalized)).toBe(true);
      expect(Option.isNone(returnedBeforeRelease)).toBe(true);
      yield* Deferred.succeed(releaseExecution, undefined);
      expect(yield* Fiber.join(running)).toEqual({
        type: "acknowledge",
        outcome: "canceled",
      });
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
          ModelCallExecutor.of({
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

  it.live(
    "commits deadline-exceeded when executor cleanup cannot confirm before its deadline",
    () =>
      Effect.gen(function* () {
        const repository = makeRepository();
        const committed = yield* Deferred.make<AgentRunCleanupResult>();
        const releaseCleanup = yield* Deferred.make<void>();
        const cancellation = {
          ...repository.service,
          appendModelOutput: () => Effect.fail(new AgentRunCancellationObserved()),
          loadCancellation: () =>
            Effect.succeed({
              cleanupDeadlineAtEpochMs: Date.now() + 20,
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
              ModelCallExecutor.of({
                execute: () => Stream.make({ fragmentIndex: 0, text: "must not commit" }),
                cancel: () =>
                  Deferred.await(releaseCleanup).pipe(
                    Effect.as({ type: "confirmedStopped" as const }),
                    Effect.uninterruptible,
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

        const running = yield* AgentRunWorker.use((worker) => worker.handle(delivery)).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );
        const cleanup = yield* Deferred.await(committed).pipe(Effect.timeoutOption(100));
        const returnedBeforeRelease = yield* Fiber.await(running).pipe(Effect.timeoutOption(10));

        expect(Option.getOrUndefined(cleanup)).toEqual({
          cleanupDisposition: { type: "deadlineExceeded" },
          externalWorkMayContinue: true,
        });
        expect(Option.isNone(returnedBeforeRelease)).toBe(true);
        yield* Deferred.succeed(releaseCleanup, undefined);
        expect(yield* Fiber.join(running)).toEqual({
          type: "acknowledge",
          outcome: "canceled",
        });
      }),
  );

  it.live("renews the fenced lease while a healthy model call remains active", () =>
    Effect.gen(function* () {
      const repository = makeRepository();
      const renewed = yield* Deferred.make<void>();
      const renewing = {
        ...repository.service,
        renewLease: () =>
          Deferred.succeed(renewed, undefined).pipe(
            Effect.tap(() => Effect.sync(() => repository.calls.push("lease:renewed"))),
          ),
      } satisfies AgentRunRepositoryService;
      const layer = makeAgentRunWorkerLayer({
        executionProfileRef: "oz.deterministic.v1",
        workerId: "worker-a",
        leaseDurationMs: 30,
        leaseRenewalIntervalMs: 5,
        cancellationPollIntervalMs: 1,
      }).pipe(
        Layer.provide(Layer.succeed(AgentRunRepository)(renewing)),
        Layer.provide(
          Layer.succeed(ModelCallExecutor)(
            ModelCallExecutor.of({
              execute: () =>
                Stream.fromEffect(Deferred.await(renewed)).pipe(
                  Stream.map(() => ({ fragmentIndex: 0, text: "renewed" })),
                ),
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
        Effect.forkDetach,
      );
      const completed = yield* Fiber.await(running).pipe(Effect.timeoutOption(100));

      expect(Option.getOrUndefined(completed)).toMatchObject({ _tag: "Success" });
      expect(repository.calls).toContain("lease:renewed");
    }),
  );
});

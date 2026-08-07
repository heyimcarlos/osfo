import { ModelCallExecutor, type ModelCallAttempt } from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { BroadcastChannel } from "node:worker_threads";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { makeWorkerThreadModelCallExecutorLayer } from "../src/worker-thread-model-call-executor.js";

const attempt = {
  assistantOutputId: "fe147f93-9553-4f56-bab2-7505533d4ad1",
  attemptNumber: 1,
  modelBinding: "oz.deterministic.echo.v1",
  modelCallAttemptId: "dd0496f6-c20f-4c86-bc69-e3138b699f06",
  modelCallId: "0f60df64-c87c-4878-8340-001f23623491",
  prompt: "complete",
  usage: { type: "unknown" },
} as const satisfies ModelCallAttempt;

const workerSource = String.raw`
  const { BroadcastChannel, parentPort, workerData } = require("node:worker_threads");
  const attempt = workerData.attempt;
  const id = attempt.modelCallAttemptId;
  const observation = (text) => parentPort.postMessage({
    type: "observation",
    modelCallAttemptId: id,
    fragmentIndex: 0,
    text,
  });
  if (attempt.prompt === "stuck") {
    observation("started");
    while (true) {}
  } else if (attempt.prompt === "completed-before-exit") {
    const control = new BroadcastChannel(id);
    control.onmessage = (message) => {
      if (message.data === "exit") {
        control.close();
        parentPort.close();
      }
    };
    observation("ready");
    parentPort.postMessage({ type: "completed", modelCallAttemptId: id });
  } else if (attempt.prompt === "wrong-attempt") {
    parentPort.postMessage({
      type: "completed",
      modelCallAttemptId: "01234567-89ab-4def-8123-456789abcdef",
    });
    setInterval(() => {}, 60_000);
  } else if (attempt.prompt === "nonzero") {
    process.exit(7);
  } else {
    observation("complete");
    parentPort.postMessage({ type: "completed", modelCallAttemptId: id });
    parentPort.close();
  }
`;

const withPrompt = (prompt: string, modelCallAttemptId: string = attempt.modelCallAttemptId) => ({
  ...attempt,
  modelCallAttemptId,
  prompt,
});

const makeLayer = (onActiveSessionCountChange?: (count: number) => void) =>
  makeWorkerThreadModelCallExecutorLayer({
    cancellationGraceMs: 10,
    ...(onActiveSessionCountChange === undefined ? {} : { onActiveSessionCountChange }),
    source: workerSource,
    terminationDeadlineMs: 1_000,
  });

const execute = (executor: ModelCallExecutor["Service"], value: ModelCallAttempt) =>
  Stream.unwrap(executor.execute(value));

describe("worker-thread ModelCall executor", () => {
  it.live("kills an executor that ignores cancellation before releasing its session", () =>
    Effect.gen(function* () {
      const active = yield* Deferred.make<void>();
      const inactive = yield* Deferred.make<void>();
      const layer = makeLayer((count) => {
        if (count === 1) Deferred.doneUnsafe(active, Effect.void);
        if (count === 0) Deferred.doneUnsafe(inactive, Effect.void);
      });
      const program = Effect.gen(function* () {
        const executor = yield* ModelCallExecutor;
        const stuck = withPrompt("stuck");
        const execution = yield* Stream.runDrain(execute(executor, stuck)).pipe(Effect.forkScoped);
        yield* Deferred.await(active);

        expect(yield* executor.cancel(stuck)).toEqual({ type: "mayContinue" });
        yield* Deferred.await(inactive);
        expect(Exit.isSuccess(yield* Fiber.await(execution))).toBe(true);
      });

      yield* Effect.scoped(program.pipe(Effect.provide(layer)));
    }),
  );

  it.live("does not complete execution until a completed frame is followed by exit code zero", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const delayed = withPrompt("completed-before-exit");
      const control = new BroadcastChannel(delayed.modelCallAttemptId);
      const layer = makeLayer();
      const program = Effect.gen(function* () {
        const executor = yield* ModelCallExecutor;
        yield* Stream.runForEach(execute(executor, delayed), () =>
          Deferred.succeed(ready, undefined),
        ).pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.forkScoped);
        yield* Deferred.await(ready);
        expect(yield* Deferred.isDone(completed)).toBe(false);

        control.postMessage("exit");
        yield* Deferred.await(completed);
      });

      yield* Effect.scoped(program.pipe(Effect.provide(layer))).pipe(
        Effect.ensuring(Effect.sync(() => control.close())),
      );
    }),
  );

  it.live("rejects wrong-attempt frames and nonzero exits without surviving sessions", () =>
    Effect.gen(function* () {
      let activeSessionCount = 0;
      const layer = makeLayer((count) => {
        activeSessionCount = count;
      });
      const program = Effect.gen(function* () {
        const executor = yield* ModelCallExecutor;
        const wrong = withPrompt("wrong-attempt");
        const wrongExit = yield* Stream.runDrain(execute(executor, wrong)).pipe(Effect.exit);
        expect(Exit.isFailure(wrongExit)).toBe(true);
        yield* executor.terminate(wrong);
        expect(activeSessionCount).toBe(0);

        const nonzero = withPrompt("nonzero", "2514f280-1330-4ce5-84a2-345e587671df");
        const nonzeroExit = yield* Stream.runDrain(execute(executor, nonzero)).pipe(Effect.exit);
        expect(Exit.isFailure(nonzeroExit)).toBe(true);
        expect(activeSessionCount).toBe(0);
      });

      yield* Effect.scoped(program.pipe(Effect.provide(layer)));
    }),
  );

  it.live("treats an unknown takeover attempt as possibly continuing without spawning work", () =>
    Effect.gen(function* () {
      let maximumActiveSessionCount = 0;
      const layer = makeLayer((count) => {
        maximumActiveSessionCount = Math.max(maximumActiveSessionCount, count);
      });
      const program = ModelCallExecutor.use((executor) =>
        Effect.gen(function* () {
          expect(yield* executor.cancel(withPrompt("stuck"))).toEqual({ type: "mayContinue" });
          expect(maximumActiveSessionCount).toBe(0);
        }),
      );

      yield* Effect.scoped(program.pipe(Effect.provide(layer)));
    }),
  );

  it.live("kills every stuck slot concurrently before accepting new work", () =>
    Effect.gen(function* () {
      const allActive = yield* Deferred.make<void>();
      const allInactive = yield* Deferred.make<void>();
      let activeSessionCount = 0;
      const layer = makeLayer((count) => {
        activeSessionCount = count;
        if (count === 2) Deferred.doneUnsafe(allActive, Effect.void);
        if (count === 0) Deferred.doneUnsafe(allInactive, Effect.void);
      });
      const program = Effect.gen(function* () {
        const executor = yield* ModelCallExecutor;
        const first = withPrompt("stuck");
        const second = withPrompt("stuck", "8780aa4c-4a0e-4659-9910-638e8ecbc5f4");
        yield* Stream.runDrain(execute(executor, first)).pipe(Effect.forkScoped);
        yield* Stream.runDrain(execute(executor, second)).pipe(Effect.forkScoped);
        yield* Deferred.await(allActive);

        yield* Effect.all([executor.cancel(first), executor.cancel(second)], {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Deferred.await(allInactive);
        expect(activeSessionCount).toBe(0);

        const observations = yield* Stream.runCollect(execute(executor, withPrompt("complete")));
        expect([...observations]).toEqual([{ fragmentIndex: 0, text: "complete" }]);
      });

      yield* Effect.scoped(program.pipe(Effect.provide(layer)));
      expect(activeSessionCount).toBe(0);
    }),
  );

  it.live("terminates every active session when the executor scope closes", () =>
    Effect.gen(function* () {
      const active = yield* Deferred.make<void>();
      const inactive = yield* Deferred.make<void>();
      let activeSessionCount = 0;
      const layer = makeLayer((count) => {
        activeSessionCount = count;
        if (count === 1) Deferred.doneUnsafe(active, Effect.void);
        if (count === 0) Deferred.doneUnsafe(inactive, Effect.void);
      });
      const program = ModelCallExecutor.use((executor) =>
        Effect.gen(function* () {
          yield* Stream.runDrain(execute(executor, withPrompt("stuck"))).pipe(Effect.forkScoped);
          yield* Deferred.await(active);
        }),
      );

      yield* Effect.scoped(program.pipe(Effect.provide(layer)));
      yield* Deferred.await(inactive);
      expect(activeSessionCount).toBe(0);
    }),
  );
});

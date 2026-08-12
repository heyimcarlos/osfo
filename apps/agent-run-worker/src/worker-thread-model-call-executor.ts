import { Worker } from "node:worker_threads";
import {
  ModelCallExecutionError,
  ModelCallExecutor,
  type ModelCallAttempt,
  type ModelCallCancellationDisposition,
  type ModelCallObservation,
} from "@osfo/agent-run";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const Identity = Schema.String.check(Schema.isUUID());
const WorkerResponseSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("observation"),
    modelCallAttemptId: Identity,
    fragmentIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    text: Schema.String.check(Schema.isNonEmpty()),
  }),
  Schema.Struct({ type: Schema.Literal("completed"), modelCallAttemptId: Identity }),
  Schema.Struct({
    type: Schema.Literal("canceled"),
    modelCallAttemptId: Identity,
    disposition: Schema.Literals(["confirmedStopped", "mayContinue"]),
  }),
]);

type WorkerResponse = typeof WorkerResponseSchema.Type;

interface WorkerSession {
  readonly attemptId: string;
  readonly worker: Worker;
  readonly output: Queue.Queue<ModelCallObservation, ModelCallExecutionError | Cause.Done<void>>;
  readonly canceled: Deferred.Deferred<ModelCallCancellationDisposition, ModelCallExecutionError>;
  readonly exited: Deferred.Deferred<void>;
  completed: boolean;
  failureCause: unknown;
  terminating: boolean;
}

export interface WorkerThreadModelCallExecutorConfig {
  readonly cancellationGraceMs: number;
  readonly source: string;
  readonly terminationDeadlineMs: number;
  readonly failStop?: (cause: unknown) => Effect.Effect<never>;
  readonly onActiveSessionCountChange?: (activeSessionCount: number) => void;
}

const executionError = (cause: unknown) =>
  new ModelCallExecutionError({
    cause,
    dispatchEvidence: { type: "uncertain" },
    usage: { type: "unknown" },
  });

const defaultFailStop = (cause: unknown): Effect.Effect<never> =>
  Effect.logFatal("ModelCall worker isolation failed; stopping process", cause).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.abort();
      }),
    ),
    Effect.andThen(Effect.never),
  );

const workerThreadModelCallExecutorLayer = (config: WorkerThreadModelCallExecutorConfig) =>
  Layer.effect(
    ModelCallExecutor,
    Effect.gen(function* () {
      const sessions = new Map<string, WorkerSession>();
      const spawnLock = yield* Semaphore.make(1);
      const failStop = config.failStop ?? defaultFailStop;

      const failSession = (session: WorkerSession, cause: unknown) => {
        const error = executionError(cause);
        Queue.failCauseUnsafe(session.output, Cause.fail(error));
        Deferred.doneUnsafe(session.canceled, Effect.fail(error));
      };

      const terminateSession = Effect.fn("WorkerThreadModelCallExecutor.terminateSession")(
        function* (session: WorkerSession) {
          if (!session.terminating) {
            session.terminating = true;
            const termination = yield* Effect.exit(
              Effect.tryPromise({
                try: () => session.worker.terminate(),
                catch: executionError,
              }).pipe(Effect.timeoutOption(config.terminationDeadlineMs)),
            );
            if (Exit.isFailure(termination) || Option.isNone(termination.value)) {
              return yield* failStop(
                Exit.isFailure(termination)
                  ? termination.cause
                  : `Worker termination exceeded ${config.terminationDeadlineMs}ms`,
              );
            }
          }
          const exited = yield* Deferred.await(session.exited).pipe(
            Effect.timeoutOption(config.terminationDeadlineMs),
          );
          if (Option.isNone(exited)) {
            return yield* failStop(
              `Worker exit observation exceeded ${config.terminationDeadlineMs}ms`,
            );
          }
        },
      );

      const acceptResponse = (session: WorkerSession, response: WorkerResponse) => {
        if (response.modelCallAttemptId !== session.attemptId) {
          failSession(session, "Worker response carried the wrong ModelCallAttemptId");
          return;
        }
        switch (response.type) {
          case "observation":
            if (!session.completed) {
              Queue.offerUnsafe(session.output, {
                fragmentIndex: response.fragmentIndex,
                text: response.text,
              });
            }
            return;
          case "completed":
            session.completed = true;
            return;
          case "canceled":
            Deferred.doneUnsafe(session.canceled, Effect.succeed({ type: response.disposition }));
            return;
        }
      };

      const spawn = (attempt: ModelCallAttempt) =>
        spawnLock.withPermit(
          Effect.gen(function* () {
            const existing = sessions.get(attempt.modelCallAttemptId);
            if (existing !== undefined) return existing;
            const output = yield* Queue.make<
              ModelCallObservation,
              ModelCallExecutionError | Cause.Done<void>
            >();
            const canceled = yield* Deferred.make<
              ModelCallCancellationDisposition,
              ModelCallExecutionError
            >();
            const exited = yield* Deferred.make<void>();
            const worker = new Worker(config.source, { eval: true, workerData: { attempt } });
            const session: WorkerSession = {
              attemptId: attempt.modelCallAttemptId,
              worker,
              output,
              canceled,
              exited,
              completed: false,
              failureCause: undefined,
              terminating: false,
            };
            sessions.set(session.attemptId, session);
            config.onActiveSessionCountChange?.(sessions.size);
            worker.on("message", (message: unknown) => {
              const decoded = Schema.decodeUnknownExit(WorkerResponseSchema)(message);
              if (Exit.isSuccess(decoded)) acceptResponse(session, decoded.value);
              else failSession(session, decoded.cause);
            });
            worker.on("error", (cause) => {
              session.failureCause = cause;
            });
            worker.on("exit", (code) => {
              sessions.delete(session.attemptId);
              config.onActiveSessionCountChange?.(sessions.size);
              Deferred.doneUnsafe(session.exited, Effect.void);
              if (code === 0 && session.completed && session.failureCause === undefined) {
                Queue.endUnsafe(session.output);
              } else if (session.terminating) {
                Queue.endUnsafe(session.output);
              } else {
                failSession(
                  session,
                  session.failureCause ?? `ModelCall worker exited with code ${code}`,
                );
              }
              Deferred.doneUnsafe(
                session.canceled,
                Effect.fail(
                  executionError("ModelCall worker exited without cancellation disposition"),
                ),
              );
            });
            return session;
          }),
        );

      const terminate = Effect.fn("WorkerThreadModelCallExecutor.terminate")(function* (
        attempt: ModelCallAttempt,
      ) {
        const session = sessions.get(attempt.modelCallAttemptId);
        if (session !== undefined) yield* terminateSession(session);
      });

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...sessions.values()], terminateSession, {
          concurrency: "unbounded",
          discard: true,
        }).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              sessions.size === 0
                ? Effect.void
                : failStop(`${sessions.size} ModelCall workers survived layer shutdown`),
            ),
          ),
        ),
      );

      return ModelCallExecutor.of({
        execute: (attempt) =>
          spawn(attempt).pipe(Effect.map((session) => Stream.fromQueue(session.output))),
        cancel: (attempt) =>
          Effect.gen(function* () {
            const session = sessions.get(attempt.modelCallAttemptId);
            if (session === undefined) return { type: "mayContinue" as const };
            session.worker.postMessage({
              type: "cancel",
              modelCallAttemptId: attempt.modelCallAttemptId,
            });
            const acknowledged = yield* Deferred.await(session.canceled).pipe(
              Effect.option,
              Effect.timeoutOption(config.cancellationGraceMs),
            );
            yield* terminateSession(session);
            return Option.isSome(acknowledged) && Option.isSome(acknowledged.value)
              ? acknowledged.value.value
              : ({ type: "mayContinue" } as const);
          }),
        outcome: () =>
          Effect.succeed({
            dispatchEvidence: { type: "confirmed" },
            usage: { type: "unknown" },
          }),
        terminate,
      });
    }),
  );

export const makeWorkerThreadModelCallExecutorLayer = (
  config: WorkerThreadModelCallExecutorConfig,
) => workerThreadModelCallExecutorLayer(config);

export const makeDeterministicModelCallWorkerSource = (delayMs: number) => String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const attemptId = workerData.attempt.modelCallAttemptId;
  const delayMs = ${JSON.stringify(delayMs)};
  let settled = false;
  let timer;
  parentPort.on("message", (message) => {
    if (!settled && message && message.type === "cancel" && message.modelCallAttemptId === attemptId) {
      settled = true;
      clearTimeout(timer);
      parentPort.postMessage({
        type: "canceled",
        modelCallAttemptId: attemptId,
        disposition: "confirmedStopped",
      });
      parentPort.close();
    }
  });
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    parentPort.postMessage({
      type: "observation",
      modelCallAttemptId: attemptId,
      fragmentIndex: 0,
      text: "Echo: ",
    });
    parentPort.postMessage({
      type: "observation",
      modelCallAttemptId: attemptId,
      fragmentIndex: 1,
      text: workerData.attempt.prompt,
    });
    parentPort.postMessage({ type: "completed", modelCallAttemptId: attemptId });
    parentPort.close();
  }, delayMs);
`;

export const deterministicModelCallWorkerSource = makeDeterministicModelCallWorkerSource(0);

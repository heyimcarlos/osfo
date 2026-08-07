import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { Data, Deferred, Effect, Fiber, Option, Ref, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  decodeIngressLifecycleTelemetry,
  type IngressDrainTelemetry,
  type IngressLifecycleTelemetry,
  type IngressSlowConsumerTelemetry,
} from "./lifecycle-telemetry.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const readyPattern = /^OSFO_INGRESS_READY:(\d+)$/u;

export interface CompiledIngressOptions {
  readonly admissionCapacityReconciliationIntervalMs?: number;
  readonly databaseUrl: string;
  readonly executionProfileRef?: string;
  readonly globalNonTerminalLimit?: number;
  readonly maxStreamBufferedAgeMs?: number;
  readonly maxStreamBufferedBytes?: number;
  readonly maxStreamBufferedEvents?: number;
  readonly maxStreamConnectionLifetimeMs?: number;
  readonly maxStreamConnections?: number;
  readonly port?: number;
  readonly principalNonTerminalLimit?: number;
  readonly streamPollIntervalMs?: number;
}

export class CompiledIngressStartError extends Data.TaggedError("CompiledIngressStartError")<{
  readonly reason: "platform" | "exit" | "timeout" | "invalid-ready-port";
  readonly output: string;
  readonly exitCode?: number;
  readonly cause?: unknown;
}> {}

export class CompiledIngressStopError extends Data.TaggedError("CompiledIngressStopError")<{
  readonly reason: "platform" | "telemetry";
  readonly cause: unknown;
}> {}

export interface CompiledIngressTermination {
  readonly drain: IngressDrainTelemetry["status"] & { readonly httpServerListening: boolean };
  readonly exitCode: number;
  readonly fallbackInvoked: boolean;
  readonly sentSignal: "SIGTERM";
  readonly shutdownSequence: ReadonlyArray<"drained" | "http_closed">;
}

const parseReadyPort = (line: string) => {
  const match = readyPattern.exec(line);
  return match?.[1] === undefined ? Result.fail(line) : Result.succeed(Number(match[1]));
};

interface ProcessObservation {
  readonly capturedOutput: () => string;
  readonly drain: Deferred.Deferred<IngressDrainTelemetry>;
  readonly events: Ref.Ref<ReadonlyArray<IngressLifecycleTelemetry>>;
  readonly fiber: Fiber.Fiber<void, unknown>;
  readonly ready: Deferred.Deferred<number, CompiledIngressStartError>;
  readonly slowConsumerClose: Deferred.Deferred<IngressSlowConsumerTelemetry>;
}

const observeProcess = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    const output: Array<string> = [];
    const capturedOutput = () => output.join("\n");
    const ready = yield* Deferred.make<number, CompiledIngressStartError>();
    const drain = yield* Deferred.make<IngressDrainTelemetry>();
    const slowConsumerClose = yield* Deferred.make<IngressSlowConsumerTelemetry>();
    const events = yield* Ref.make<ReadonlyArray<IngressLifecycleTelemetry>>([]);
    const fiber = yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          output.push(line);
          const parsedPort = parseReadyPort(line);
          if (Result.isSuccess(parsedPort)) {
            const port = parsedPort.success;
            yield* Number.isSafeInteger(port) && port > 0 && port <= 65_535
              ? Deferred.succeed(ready, port)
              : Deferred.fail(
                  ready,
                  new CompiledIngressStartError({
                    reason: "invalid-ready-port",
                    output: capturedOutput(),
                  }),
                );
          }
          const telemetry = decodeIngressLifecycleTelemetry(line);
          if (Option.isNone(telemetry)) return;
          yield* Ref.update(events, (current) => [...current, telemetry.value]);
          if (telemetry.value.type === "drained") {
            yield* Deferred.succeed(drain, telemetry.value);
          } else if (
            telemetry.value.type === "connection_closed" &&
            telemetry.value.reason === "slow_consumer"
          ) {
            yield* Deferred.succeed(slowConsumerClose, telemetry.value);
          }
        }),
      ),
      Effect.forkScoped,
    );
    return { capturedOutput, drain, events, fiber, ready, slowConsumerClose };
  });

const waitForReady = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  observation: ProcessObservation,
) => {
  const capturedOutput = observation.capturedOutput;
  const platformError = (cause: unknown) =>
    new CompiledIngressStartError({ reason: "platform", output: capturedOutput(), cause });

  return Effect.raceFirst(
    Deferred.await(observation.ready),
    handle.exitCode.pipe(
      Effect.mapError(platformError),
      Effect.flatMap((exitCode) =>
        Effect.fail(
          new CompiledIngressStartError({
            reason: "exit",
            output: capturedOutput(),
            exitCode,
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(new CompiledIngressStartError({ reason: "timeout", output: capturedOutput() })),
    }),
  );
};

export const startCompiledIngress = (options: CompiledIngressOptions) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(process.execPath, ["dist/main.js"], {
      cwd: packageDirectory,
      env: {
        OSFO_ADMISSION_CAPACITY_RECONCILIATION_INTERVAL_MS: String(
          options.admissionCapacityReconciliationIntervalMs ?? 30_000,
        ),
        OSFO_INGRESS_PORT: String(options.port ?? 0),
        OSFO_TEST_LIFECYCLE_TELEMETRY: "true",
        OSFO_DATABASE_URL: options.databaseUrl,
        OSFO_EXECUTION_PROFILE_REF: options.executionProfileRef ?? "oz.process-test.v1",
        OSFO_GLOBAL_NON_TERMINAL_LIMIT: String(options.globalNonTerminalLimit ?? 8),
        OSFO_MAX_STREAM_BUFFERED_AGE_MS: String(options.maxStreamBufferedAgeMs ?? 5_000),
        OSFO_MAX_STREAM_BUFFERED_BYTES: String(options.maxStreamBufferedBytes ?? 1_048_576),
        OSFO_MAX_STREAM_BUFFERED_EVENTS: String(options.maxStreamBufferedEvents ?? 64),
        OSFO_MAX_STREAM_CONNECTION_LIFETIME_MS: String(
          options.maxStreamConnectionLifetimeMs ?? 1_800_000,
        ),
        OSFO_MAX_STREAM_CONNECTIONS: String(options.maxStreamConnections ?? 64),
        OSFO_PRINCIPAL_NON_TERMINAL_LIMIT: String(options.principalNonTerminalLimit ?? 4),
        OSFO_STREAM_POLL_INTERVAL_MS: String(options.streamPollIntervalMs ?? 250),
      },
      extendEnv: true,
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    }).pipe(
      Effect.mapError(
        (cause) => new CompiledIngressStartError({ reason: "platform", output: "", cause }),
      ),
    );
    const observation = yield* observeProcess(handle);
    const port = yield* waitForReady(handle, observation);
    const terminate = Effect.gen(function* () {
      const running = yield* handle.isRunning;
      if (running) yield* handle.kill({ killSignal: "SIGTERM" });
      const gracefulExit = yield* handle.exitCode.pipe(Effect.timeoutOption("3 seconds"));
      const fallbackInvoked = Option.isNone(gracefulExit);
      const exitCode = yield* Option.match(gracefulExit, {
        onNone: () => handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.andThen(handle.exitCode)),
        onSome: Effect.succeed,
      });
      yield* Fiber.join(observation.fiber);
      const drain = yield* Deferred.await(observation.drain).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () =>
            Effect.fail(
              new CompiledIngressStopError({
                reason: "telemetry",
                cause: "missing drained lifecycle telemetry",
              }),
            ),
        }),
      );
      const events = yield* Ref.get(observation.events);
      return {
        drain: { ...drain.status, httpServerListening: drain.httpServerListening },
        exitCode,
        fallbackInvoked,
        sentSignal: "SIGTERM" as const,
        shutdownSequence: events.flatMap((event) =>
          event.type === "drained" || event.type === "http_closed" ? [event.type] : [],
        ),
      } satisfies CompiledIngressTermination;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CompiledIngressStopError
          ? cause
          : new CompiledIngressStopError({ reason: "platform", cause }),
      ),
    );
    return {
      origin: `http://127.0.0.1:${port}`,
      port,
      terminate,
      waitForSlowConsumerClose: Deferred.await(observation.slowConsumerClose),
    };
  }).pipe(Effect.provide(NodeServices.layer));

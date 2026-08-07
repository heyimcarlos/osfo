import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { Data, Effect, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
  readonly cause: unknown;
}> {}

const parseReadyPort = (line: string) => {
  const match = readyPattern.exec(line);
  return match?.[1] === undefined ? Result.fail(line) : Result.succeed(Number(match[1]));
};

const waitForReady = (handle: ChildProcessSpawner.ChildProcessHandle) => {
  const output: Array<string> = [];
  const capturedOutput = () => output.join("\n");
  const platformError = (cause: unknown) =>
    new CompiledIngressStartError({ reason: "platform", output: capturedOutput(), cause });

  return handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.tap((line) => Effect.sync(() => output.push(line))),
    Stream.filterMap(parseReadyPort),
    Stream.runHead,
    Effect.mapError(platformError),
    Effect.flatMap(
      Option.match({
        onNone: () =>
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
        onSome: (port) =>
          Number.isSafeInteger(port) && port > 0 && port <= 65_535
            ? Effect.succeed(port)
            : Effect.fail(
                new CompiledIngressStartError({
                  reason: "invalid-ready-port",
                  output: capturedOutput(),
                }),
              ),
      }),
    ),
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
    const port = yield* waitForReady(handle);
    const terminate = handle.isRunning.pipe(
      Effect.flatMap((running) =>
        running ? handle.kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" }) : Effect.void,
      ),
      Effect.andThen(handle.exitCode),
      Effect.asVoid,
      Effect.mapError((cause) => new CompiledIngressStopError({ cause })),
    );
    return { origin: `http://127.0.0.1:${port}`, port, terminate };
  }).pipe(Effect.provide(NodeServices.layer));

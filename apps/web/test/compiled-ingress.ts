import { NodeServices } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { Data, Effect, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const ingressDirectory = fileURLToPath(new URL("../../ingress", import.meta.url));
const readyPattern = /^OSFO_INGRESS_READY:(\d+)$/u;

export class CompiledIngressStartError extends Data.TaggedError("CompiledIngressStartError")<{
  readonly reason: "platform" | "exit" | "timeout" | "invalid-ready-port";
  readonly output: string;
  readonly exitCode?: number;
  readonly cause?: unknown;
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

export const startCompiledIngress = (databaseUrl: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(process.execPath, ["dist/main.js"], {
      cwd: ingressDirectory,
      env: {
        OSFO_INGRESS_PORT: "0",
        OSFO_DATABASE_URL: databaseUrl,
        OSFO_EXECUTION_PROFILE_REF: "oz.reference-journey.v1",
        OSFO_GLOBAL_NON_TERMINAL_LIMIT: "8",
        OSFO_PRINCIPAL_NON_TERMINAL_LIMIT: "4",
        OSFO_STREAM_POLL_INTERVAL_MS: "10",
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
    return { origin: `http://127.0.0.1:${port}` };
  }).pipe(Effect.provide(NodeServices.layer));

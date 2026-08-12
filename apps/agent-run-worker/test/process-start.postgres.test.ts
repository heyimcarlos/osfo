import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for the worker process integration test");
}

const isTcpAddress = Schema.is(Schema.Struct({ port: Schema.Number }));

const startUnresponsiveBroker = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
    catch: (cause) => cause,
  }),
  (server) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
);

describe("AgentRun worker process role", () => {
  it.live("starts the bounded StreamingPull composition under Node", () =>
    Effect.gen(function* () {
      const broker = yield* startUnresponsiveBroker;
      const address = broker.address();
      if (!isTcpAddress(address)) {
        return yield* Effect.die("Expected a TCP broker address");
      }
      const handle = yield* ChildProcess.make(
        process.execPath,
        ["--import", "tsx", "src/main.ts"],
        {
          cwd: packageDirectory,
          env: {
            OSFO_AGENT_RUN_WORKER_ID: "process-test-worker",
            OSFO_DATABASE_URL: databaseUrl,
            OSFO_EXECUTION_PROFILE_REF: "oz.deterministic.v1",
            OSFO_PUBSUB_PROJECT_ID: "osfo-test",
            OSFO_PUBSUB_SUBSCRIPTION_ID: "agent-runs-test",
            PUBSUB_EMULATOR_HOST: `127.0.0.1:${address.port}`,
          },
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        },
      );
      const ready = yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.includes("OSFO_AGENT_RUN_WORKER_READY:streaming-pull:32")),
        Stream.runHead,
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.succeed(Option.none<string>()),
        }),
      );

      expect(Option.getOrUndefined(ready)).toContain(
        "OSFO_AGENT_RUN_WORKER_READY:streaming-pull:32",
      );
      yield* handle.kill();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an empty live-provider credential before worker startup", () =>
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(
        process.execPath,
        ["--import", "tsx", "src/main.ts"],
        {
          cwd: packageDirectory,
          env: {
            OPENROUTER_API_KEY: "",
            OSFO_AGENT_RUN_WORKER_ID: "empty-credential-worker",
            OSFO_DATABASE_URL: databaseUrl,
            OSFO_EXECUTION_PROFILE_REF: "oz.openrouter.minimax.minimax-m3.chat-completions.v1",
            OSFO_PUBSUB_PROJECT_ID: "osfo-test",
            OSFO_PUBSUB_SUBSCRIPTION_ID: "agent-runs-test",
            PUBSUB_EMULATOR_HOST: "127.0.0.1:1",
          },
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "1 second",
        },
      );
      const output = yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (combined, chunk) => combined + chunk,
        ),
        Effect.timeout("5 seconds"),
        Effect.ensuring(handle.kill().pipe(Effect.ignore)),
      );

      expect(output).toContain("missingCredential");
      expect(output).not.toContain("OSFO_AGENT_RUN_WORKER_READY");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

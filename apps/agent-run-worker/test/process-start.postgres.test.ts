import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Effect, Option, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for the worker process integration test");
}

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
      if (typeof address !== "object" || address === null) {
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
            OSFO_MODEL_BINDING: "oz.deterministic.echo.v1",
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
});

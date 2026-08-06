import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { Effect, Option, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("AgentRun worker process role", () => {
  it.live("starts an authenticated Pub/Sub push server under Node", () =>
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(
        process.execPath,
        ["--import", "tsx", "src/main.ts"],
        {
          cwd: packageDirectory,
          env: {
            OSFO_AGENT_RUN_WORKER_PORT: "0",
            OSFO_AGENT_RUN_WORKER_ID: "process-test-worker",
            OSFO_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle",
            OSFO_PUBSUB_PUSH_TOKEN: "process-test-token",
          },
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        },
      );
      const ready = yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("OSFO_AGENT_RUN_WORKER_READY:")),
        Stream.runHead,
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.succeed(Option.none<string>()),
        }),
      );

      expect(Option.getOrUndefined(ready)).toMatch(/^OSFO_AGENT_RUN_WORKER_READY:\d+$/u);
      yield* handle.kill();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

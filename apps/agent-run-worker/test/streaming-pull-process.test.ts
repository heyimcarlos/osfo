import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("StreamingPull process shutdown", () => {
  it.live("exits after SIGTERM when a delivery ignores interruption", () =>
    Effect.gen(function* () {
      const processHandle = yield* ChildProcess.make(
        process.execPath,
        ["test/fixtures/stuck-streaming-pull-process.mjs"],
        {
          cwd: packageDirectory,
          extendEnv: true,
          forceKillAfter: "2 seconds",
          stdin: "ignore",
        },
      );
      const ready = yield* processHandle.all.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.includes("STUCK_STREAMING_PULL_READY")),
        Stream.runHead,
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.succeed(Option.none<string>()),
        }),
      );
      expect(Option.getOrUndefined(ready)).toContain("STUCK_STREAMING_PULL_READY");

      yield* processHandle.kill({ killSignal: "SIGTERM" });
      const exit = yield* processHandle.exitCode.pipe(Effect.timeout("2 seconds"), Effect.exit);
      const exitEvidence = Exit.match(exit, {
        onFailure: Cause.pretty,
        onSuccess: (exitCode) => `Exited normally with code ${exitCode}`,
      });
      expect(exitEvidence).toContain("SIGABRT");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

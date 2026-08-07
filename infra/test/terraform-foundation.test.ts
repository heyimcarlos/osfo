import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

const runCheck = Effect.fnUntraced(function* (script: string) {
  const process = yield* ChildProcess.make("bash", [script], {
    cwd: repositoryRoot,
  });

  return yield* Effect.all(
    {
      exitCode: process.exitCode,
      stdout: Stream.mkString(Stream.decodeText(process.stdout)),
      stderr: Stream.mkString(Stream.decodeText(process.stderr)),
    },
    { concurrency: "unbounded" },
  );
});

const expectCheckPasses = (script: string, evidence: string) =>
  Effect.gen(function* () {
    const result = yield* runCheck(script);

    assert.strictEqual(result.exitCode, ChildProcessSpawner.ExitCode(0), result.stderr);
    assert.include(result.stdout, evidence);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Terraform foundation", () => {
  it.effect("enforces routine command and plan policy", () =>
    expectCheckPasses("infra/tests/policy.sh", "Terraform policy assertions"),
  );

  it.effect("enforces repository and isolation contracts", () =>
    expectCheckPasses("infra/tests/repository-contract.sh", "pinned toolchain"),
  );

  it.effect("enforces the disposable development platform contract", () =>
    expectCheckPasses(
      "infra/tests/development-platform-contract.sh",
      "development platform topology",
    ),
  );

  it.effect("enforces development failure diagnostics and teardown independence", () =>
    expectCheckPasses(
      "infra/tests/development-platform-repair-contract.sh",
      "development failure diagnostics",
    ),
  );

  it.effect(
    "proves a bound disposable development lifecycle",
    () => expectCheckPasses("infra/tests/development-proof.sh", "recoverable state"),
    30_000,
  );
});

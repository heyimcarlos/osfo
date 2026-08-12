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

  it.effect(
    "enforces repository and isolation contracts",
    () => expectCheckPasses("infra/tests/repository-contract.sh", "pinned toolchain"),
    30_000,
  );

  it.effect("enforces the disposable development platform contract", () =>
    expectCheckPasses(
      "infra/tests/development-platform-contract.sh",
      "development platform topology",
    ),
  );

  it.effect("retains dormant identities without runtime authority", () =>
    expectCheckPasses(
      "infra/tests/foundation-dormant-runtime-identities-contract.sh",
      "protected dormant identities",
    ),
  );

  it.effect("proves artifact overwrite verification fails closed", () =>
    expectCheckPasses(
      "infra/tests/development-artifact-overwrite-proof-contract.sh",
      "development artifact overwrite proof assertions",
    ),
  );

  it.effect("proves denied secret access fails without a payload", () =>
    expectCheckPasses(
      "infra/tests/development-denied-secret-proof-contract.sh",
      "development denied-secret runtime proof assertions",
    ),
  );

  it.effect("proves authorized secret access with sanitized evidence", () =>
    expectCheckPasses(
      "infra/tests/development-authorized-secret-proof-contract.sh",
      "development authorized-secret proof assertions",
    ),
  );

  it.effect("proves denied secret IAM authority is absent", () =>
    expectCheckPasses(
      "infra/tests/development-denied-secret-iam-preflight-contract.sh",
      "development denied-secret IAM preflight assertions",
    ),
  );

  it.effect("enforces the development runtime demo contract", () =>
    expectCheckPasses(
      "infra/tests/development-runtime-contract.sh",
      "development runtime demo topology",
    ),
  );

  it.effect("enforces the deployed SSE demo qualification contract", () =>
    expectCheckPasses(
      "infra/tests/development-sse-demo-qualification-contract.sh",
      "Development SSE demo qualification contract assertions passed",
    ),
  );

  it.effect("proves runtime absence checks fail closed", () =>
    expectCheckPasses(
      "infra/tests/development-runtime-absent-contract.sh",
      "absence proof fails closed",
    ),
  );

  it.effect("proves authorized identity has no protected-secret authority", () =>
    expectCheckPasses(
      "infra/tests/development-authorized-secret-iam-preflight-contract.sh",
      "development authorized-secret IAM preflight assertions",
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

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Sandbox } from "e2b";

const output = process.env.OSFO_E2B_EVIDENCE_FILE ?? "e2b-smoke.json";
if (!process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required");
}

const started = performance.now();
const sandbox = await Sandbox.create("base", {
  timeoutMs: 60_000,
  allowInternetAccess: false,
});
const created = performance.now();

let command;
let commandEnded;
let runningBeforeKill;
try {
  runningBeforeKill = await sandbox.isRunning();
  command = await sandbox.commands.run(
    "test \"$E2B_SANDBOX\" = true && printf osfo-e2b-conformance > /tmp/osfo-artifact && sha256sum /tmp/osfo-artifact",
    { timeoutMs: 15_000 },
  );
  commandEnded = performance.now();
} finally {
  await sandbox.kill();
}
const ended = performance.now();

if (!runningBeforeKill || command.exitCode !== 0) {
  throw new Error("E2B conformance command did not complete successfully");
}

const expectedHash = createHash("sha256")
  .update("osfo-e2b-conformance")
  .digest("hex");
if (!command.stdout.startsWith(expectedHash)) {
  throw new Error("E2B artifact hash did not match the expected content");
}

await writeFile(
  output,
  `${JSON.stringify(
    {
      schema_version: 1,
      provider: "E2B",
      sdk: "e2b",
      sdk_version: "2.38.0",
      template: "base",
      internet_access: false,
      running_before_kill: runningBeforeKill,
      command_exit_code: command.exitCode,
      artifact_sha256: expectedHash,
      create_ms: created - started,
      command_ms: commandEnded - created,
      teardown_ms: ended - commandEnded,
      total_ms: ended - started,
      conformance_passed: true,
      guarantee_scope:
        "focused provider API conformance only, not a hostile-code isolation guarantee",
    },
    null,
    2,
  )}\n`,
);

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@effect/vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("AgentRun worker process role", () => {
  it("starts under Node and exits successfully", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: packageDirectory,
    });

    expect(stdout).toContain("AgentRun worker process role is ready");
  });
});

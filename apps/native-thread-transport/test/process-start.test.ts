import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("Native Thread Transport process role", () => {
  it("starts under Node and exits successfully", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: packageDirectory,
    });

    expect(stdout).toContain("Native Thread Transport process role is ready");
  });
});

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryRoot = join(repoRoot, ".tmp", "quality-tests");

describe("Effect diagnostic policy", () => {
  it("rejects a floating Effect through the normal TypeScript command", async () => {
    await mkdir(temporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(join(temporaryRoot, "effect-diagnostic-"));

    try {
      await writeFile(
        join(fixtureRoot, "invalid.ts"),
        'import { Effect } from "effect";\n\nEffect.succeed("floating");\n',
      );
      await writeFile(
        join(fixtureRoot, "tsconfig.json"),
        JSON.stringify({
          extends: resolve(repoRoot, "tsconfig.json"),
          compilerOptions: { types: [] },
          files: ["./invalid.ts"],
        }),
      );

      const result = spawnSync(
        resolve(repoRoot, "node_modules/.bin/tsc"),
        ["--project", join(fixtureRoot, "tsconfig.json"), "--pretty", "false"],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("effect(floatingEffect)");
      expect(result.stderr).toBe("");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

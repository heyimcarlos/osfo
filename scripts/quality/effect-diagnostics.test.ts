import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryRoot = join(repoRoot, ".tmp", "quality-tests");

describe("Effect diagnostic policy", () => {
  it("configures only diagnostic keys provided by the pinned Effect compiler", async () => {
    const config = JSON.parse(await readFile(join(repoRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { plugins: Array<{ diagnosticSeverity?: Record<string, string> }> };
    };
    const schema = JSON.parse(
      await readFile(join(repoRoot, "node_modules/@effect/tsgo/schema.json"), "utf8"),
    ) as {
      definitions: {
        effectLanguageServicePluginDiagnosticSeverityDefinition: {
          properties: Record<string, unknown>;
        };
      };
    };
    const configured = Object.keys(config.compilerOptions.plugins[0]?.diagnosticSeverity ?? {});
    const supported =
      schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition.properties;

    expect(configured.filter((name) => !(name in supported))).toEqual([]);
    expect(configured).toContain("effectInFailure");
  });

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

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { executeWorkflowModel, workflowCommands, workflowJobBlock } from "./ci-workflow-model.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const gates = {
  format: "bun run format:check",
  lint: "bun run lint",
  typecheck: "bun run typecheck",
  "type-tests": "bun run test:types",
  "runtime-tests": "bun run test",
  "generated-output": "bun run generated:check",
  wrdn: "bun run wrdn:check",
  build: "bun run build",
} as const;

describe("pull-request quality workflow", () => {
  it("has valid YAML syntax", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        'const value = Bun.YAML.parse(await Bun.file(".github/workflows/quality.yml").text()); console.log(Object.keys(value.jobs).sort().join(","));',
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(Object.keys(gates).sort().join(","));
    expect(result.stderr).toBe("");
  });

  it("keeps every required gate in its own job with local command parity", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");

    expect(workflow).toContain("  pull_request:\n");
    for (const [job, command] of Object.entries(gates)) {
      const block = workflowJobBlock(workflow, job);
      expect(block).toContain(`- run: ${command}`);
      for (const otherCommand of Object.values(gates).filter((value) => value !== command)) {
        expect(block).not.toContain(`- run: ${otherCommand}\n`);
      }
    }
  });

  it("localizes the pinned runtime and dependency setup", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");
    const setup = await readFile(
      resolve(repoRoot, ".github/actions/quality-setup/action.yml"),
      "utf8",
    );

    expect(workflow).not.toContain("oven-sh/setup-bun");
    expect(workflow).not.toContain("bun install --frozen-lockfile");
    for (const job of Object.keys(gates)) {
      expect(workflowJobBlock(workflow, job)).toContain("- uses: ./.github/actions/quality-setup");
    }
    expect(setup).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(setup).toContain("bun-version: 1.3.14");
    expect(setup).toContain("bun install --frozen-lockfile");
  });

  for (const failedJob of Object.keys(gates)) {
    it(`keeps a seeded ${failedJob} command failure attributable to that job`, async () => {
      const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");
      const commands = workflowCommands(workflow, Object.keys(gates));
      const executed: Array<{ readonly job: string; readonly command: string }> = [];
      const results = executeWorkflowModel(commands, (job, command) => {
        executed.push({ job, command });
        return job === failedJob ? 1 : 0;
      });

      expect(Object.entries(results).filter(([, verdict]) => verdict === "FAIL")).toEqual([
        [failedJob, "FAIL"],
      ]);
      expect(executed).toEqual(Object.entries(gates).map(([job, command]) => ({ job, command })));
    });
  }

  it("makes a seeded failing Effect Vitest test exit nonzero", async () => {
    const fixtureRoot = join(repoRoot, ".tmp/quality-tests/failing-vitest");
    const fixturePath = join(fixtureRoot, "seeded-failure.test.ts");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(
      fixturePath,
      'import { expect, it } from "@effect/vitest";\nit("seeded failure", () => { expect("actual").toBe("expected"); });\n',
    );
    try {
      const result = spawnSync(
        resolve(repoRoot, "node_modules/.bin/vitest"),
        ["run", fixturePath, "--exclude", "**/.worktrees/**"],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("seeded failure");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

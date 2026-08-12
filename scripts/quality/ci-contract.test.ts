import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const declarationJobs = ["lint", "typecheck", "wrdn"] as const;

const expectedCommands = (job: keyof typeof gates) => [
  ...(declarationJobs.includes(job as (typeof declarationJobs)[number])
    ? ["bun run ci:declarations"]
    : []),
  ...(job === "runtime-tests" ? ["sudo apt-get update && sudo apt-get install --yes ripgrep"] : []),
  gates[job],
];

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

  it("materializes declarations visibly for isolated type-aware jobs", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");

    for (const job of declarationJobs) {
      const block = workflowJobBlock(workflow, job);
      expect(block).toContain("- run: bun run ci:declarations");
      expect(block).not.toContain("- run: bun run build");
    }
  });

  it("materializes every workspace export that resolves types from dist", async () => {
    const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const declarationCommand = rootPackage.scripts["ci:declarations"] ?? "";
    const workspaceRoots = await Promise.all(
      ["apps", "packages"].map(async (parent) =>
        (await readdir(resolve(repoRoot, parent), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${parent}/${entry.name}`),
      ),
    );

    for (const workspace of workspaceRoots.flat()) {
      const packagePath = resolve(repoRoot, workspace, "package.json");
      const source = await readFile(packagePath, "utf8").catch(() => "");
      if (!source.includes('"types": "./dist/')) continue;
      expect(declarationCommand).toContain(
        `${workspace}/tsconfig.build.json --emitDeclarationOnly --noCheck`,
      );
    }
    expect(declarationCommand.split(" && ").every((command) => command.endsWith("--noCheck"))).toBe(
      true,
    );
  });

  it("provides the pinned infrastructure tools to the runtime test job", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");
    const block = workflowJobBlock(workflow, "runtime-tests");

    expect(block).toContain("sudo apt-get update && sudo apt-get install --yes ripgrep");
    expect(block).toContain("TERRAFORM_BIN: ${{ github.workspace }}/infra/scripts/terraform-ci.sh");
  });

  for (const failedJob of Object.keys(gates)) {
    it(`keeps a seeded ${failedJob} command failure attributable to that job`, async () => {
      const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");
      const commands = workflowCommands(workflow, Object.keys(gates));
      const executed: Array<{ readonly job: string; readonly command: string }> = [];
      const results = executeWorkflowModel(commands, (job, command) => {
        executed.push({ job, command });
        return job === failedJob && command === gates[failedJob as keyof typeof gates] ? 1 : 0;
      });

      expect(Object.entries(results).filter(([, verdict]) => verdict === "FAIL")).toEqual([
        [failedJob, "FAIL"],
      ]);
      expect(executed).toEqual(
        Object.keys(gates).flatMap((job) =>
          expectedCommands(job as keyof typeof gates).map((command) => ({ job, command })),
        ),
      );
    });
  }

  for (const failedJob of declarationJobs) {
    it(`attributes a seeded declaration prerequisite failure to ${failedJob}`, async () => {
      const workflow = await readFile(resolve(repoRoot, ".github/workflows/quality.yml"), "utf8");
      const commands = workflowCommands(workflow, Object.keys(gates));
      const executed: string[] = [];
      const results = executeWorkflowModel(commands, (job, command) => {
        if (job === failedJob) executed.push(command);
        return job === failedJob && command === "bun run ci:declarations" ? 1 : 0;
      });

      expect(Object.entries(results).filter(([, verdict]) => verdict === "FAIL")).toEqual([
        [failedJob, "FAIL"],
      ]);
      expect(executed).toEqual(["bun run ci:declarations"]);
    });
  }

  it("makes a seeded failing Effect Vitest test exit nonzero", async () => {
    const fixtureParent = join(repoRoot, ".tmp/quality-tests");
    await mkdir(fixtureParent, { recursive: true });
    const fixtureRoot = await mkdtemp(join(fixtureParent, "failing-vitest-"));
    const fixturePath = join(fixtureRoot, "seeded-failure.test.ts");
    await writeFile(
      fixturePath,
      'import { expect, it } from "@effect/vitest";\nit("seeded failure", () => { expect("actual").toBe("expected"); });\n',
    );
    try {
      const result = spawnSync(
        resolve(repoRoot, "node_modules/.bin/vitest"),
        ["run", "--root", fixtureRoot, "seeded-failure.test.ts"],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("seeded failure");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

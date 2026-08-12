import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  collectChangedContent,
  discoverWrdnSkills,
  evaluateWrdnPass,
  executeWrdnPass,
  wrdnDiffDigest,
  wrdnDefinitions,
  type WrdnReview,
} from "./wrdn-pass.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

const git = (root: string, ...args: readonly string[]) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout.trim();
};

const reviewFor = (
  skill: string,
  targets: readonly string[],
  changedContent: Readonly<Record<string, string>>,
): WrdnReview => ({
  skill,
  targets,
  verdict: "PASS",
  evidence: "Representative skill trace passed.",
  diffDigest: wrdnDiffDigest(targets, changedContent),
});

describe("local WRDN pass", () => {
  it("discovers and records every installed WRDN skill without a non-applicable verdict", async () => {
    const skills = await discoverWrdnSkills(repoRoot);
    const results = evaluateWrdnPass(skills, {
      changedContent: { "README.md": "+unrelated documentation\n" },
      lintOutput: "",
      reviews: [],
    });

    expect(skills).toHaveLength(11);
    expect(results.map((result) => result.skill)).toEqual(skills.map((skill) => skill.name));
    expect(results.every((result) => result.applicability === "NOT_APPLICABLE")).toBe(true);
    expect(results.every((result) => result.verdict === undefined)).toBe(true);
    expect(results.every((result) => result.reason.length > 0)).toBe(true);
  });

  it("has representative positive applicability evidence for every installed skill", async () => {
    const changedContent = {
      "packages/react/src/pages/items.tsx": '+import { updateItem } from "./api/atoms";\n',
      "apps/web/src/reactivity.tsx": "+const setItem = useAtomSet(updateItem);\n",
      "apps/web/src/promise.tsx":
        '+const setItem = useAtomSet(updateItem, { mode: "promise" }); try { await setItem(value); } catch {}\n',
      "apps/worker/src/provider-http.ts": "+const client = yield* HttpClient.HttpClient;\n",
      "apps/worker/src/schema.ts":
        '+const value: unknown = input; Object.hasOwn(value, "error");\n',
      "apps/worker/src/schema-model.ts":
        "+const Model = Schema.Struct({ id: Schema.String }); interface ModelShape { id: string }\n",
      "apps/worker/src/failure.ts": "+promise.catch((error) => String(error));\n",
      "apps/worker/src/factory.ts":
        "+interface ClientShape { run(): void } function makeClient() { return { run() {} }; }\n",
      "apps/worker/test/runtime.test.ts": "+expect(actual).toBe(expected);\n",
      "apps/worker/src/type-bypass.ts": "+// @ts-ignore\n",
    };
    const initial = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent,
      lintOutput: "Skill: wrdn-package-boundaries.",
      reviews: [],
    });
    const reviews = initial
      .filter((result) => result.applicability === "APPLICABLE")
      .map((result) => reviewFor(result.skill, result.targets, changedContent));
    const results = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent,
      lintOutput: "Skill: wrdn-package-boundaries.",
      reviews,
    });

    expect(results).toHaveLength(wrdnDefinitions.length);
    expect(results.every((result) => result.applicability === "APPLICABLE")).toBe(true);
    expect(results.every((result) => result.verdict === "PASS")).toBe(true);
  });

  it("keeps a triggered skill MISSING until its exact targets have reviewed evidence", async () => {
    const results = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent: {
        "apps/agent-run-worker/src/provider.ts":
          '+const response = await fetch("https://example.test");\n',
      },
      lintOutput: "",
      reviews: [
        reviewFor("wrdn-effect-raw-fetch-boundary", ["wrong-target.ts"], {
          "wrong-target.ts": "unrelated",
        }),
      ],
    });

    expect(
      results.find((result) => result.skill === "wrdn-effect-raw-fetch-boundary"),
    ).toMatchObject({
      applicability: "APPLICABLE",
      verdict: "MISSING",
    });
  });

  it("invalidates reviewed evidence when a deletion changes", async () => {
    const target = "apps/agent-run-worker/src/provider.ts";
    const reviewedContent = {
      [target]:
        'diff --git a/provider.ts b/provider.ts\n--- a/provider.ts\n+++ b/provider.ts\n-old provider\n+const response = fetch("https://example.test");\n',
    };
    const changedContent = {
      [target]:
        'diff --git a/provider.ts b/provider.ts\n--- a/provider.ts\n+++ b/provider.ts\n-different provider\n+const response = fetch("https://example.test");\n',
    };
    const results = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent,
      lintOutput: "",
      reviews: [reviewFor("wrdn-effect-raw-fetch-boundary", [target], reviewedContent)],
    });

    expect(wrdnDiffDigest([target], reviewedContent)).not.toBe(
      wrdnDiffDigest([target], changedContent),
    );
    expect(
      results.find((result) => result.skill === "wrdn-effect-raw-fetch-boundary")?.verdict,
    ).toBe("MISSING");
  });

  it("runs the skill-specific rules only after a complete review", async () => {
    const target = "apps/agent-run-worker/src/provider.ts";
    const changedContent = {
      [target]: '+const response = await fetch("https://example.test");\n',
    };
    const applicability = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent,
      lintOutput: "",
      reviews: [reviewFor("wrdn-effect-raw-fetch-boundary", [target], changedContent)],
    });
    const commands: string[][] = [];
    const results = executeWrdnPass(applicability, (args) => {
      commands.push([...args]);
      return 0;
    });

    expect(
      results.find((result) => result.skill === "wrdn-effect-raw-fetch-boundary")?.verdict,
    ).toBe("PASS");
    expect(commands).toEqual([["--type-aware", "-A", "all", "-D", "osfo/no-raw-fetch", target]]);
  });

  it("includes a trigger from the first commit of a multi-commit diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "osfo-wrdn-range-"));
    temporaryRoots.add(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Quality Test");
    git(root, "config", "user.email", "quality@example.test");
    await writeFile(join(root, "README.md"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "provider.ts"), 'const response = fetch("https://example.test");\n');
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "trigger");
    await writeFile(join(root, "README.md"), "unrelated second commit\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "unrelated");

    const changed = await collectChangedContent(root, base);
    expect(changed["provider.ts"]).toContain("fetch");
    expect(changed["README.md"]).toContain("unrelated second commit");

    await writeFile(join(root, "dirty.ts"), "const dirty = true;\n");
    const changedWithDirtyWorktree = await collectChangedContent(root, base);
    expect(changedWithDirtyWorktree["provider.ts"]).toContain("fetch");
    expect(changedWithDirtyWorktree["dirty.ts"]).toContain("const dirty = true");
  });
});

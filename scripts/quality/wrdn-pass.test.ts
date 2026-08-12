import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  collectChangedContent,
  discoverWrdnSkills,
  evaluateWrdnPass,
  executeWrdnPass,
  parseWrdnReviewManifest,
  requireWrdnTrackedDiff,
  requireWrdnLintOutput,
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
  it("uses final file content when an added type relies on an existing schema or factory", async () => {
    const target = "apps/worker/src/model.ts";
    const results = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent: { [target]: "+interface ModelShape { id: string }\n" },
      changedFileContent: {
        [target]:
          "const Model = Schema.Struct({ id: Schema.String });\ninterface ModelShape { id: string }\n",
      },
      lintOutput: "",
      reviews: [],
    });

    expect(
      results.find((result) => result.skill === "wrdn-effect-schema-inferred-types"),
    ).toMatchObject({ applicability: "APPLICABLE", verdict: "MISSING" });
  });

  it("classifies a changed OpenRouter HttpClient executor as a network boundary", async () => {
    const target = "apps/agent-run-worker/src/openrouter-chat-completions-model-call-executor.ts";
    const results = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
      changedContent: { [target]: "+const normalize = true;\n" },
      changedFileContent: {
        [target]: 'import { HttpClient } from "effect/unstable/http";\nconst normalize = true;\n',
      },
      lintOutput: "",
      reviews: [],
    });

    expect(
      results.find((result) => result.skill === "wrdn-effect-raw-fetch-boundary"),
    ).toMatchObject({ applicability: "APPLICABLE", verdict: "MISSING", targets: [target] });
  });

  it("rejects malformed review manifests before evaluating a verdict", () => {
    const validReview = {
      skill: "wrdn-effect-vitest-tests",
      targets: ["test.ts"],
      verdict: "PASS",
      evidence: "Reviewed.",
      diffDigest: "digest",
    };

    expect(() =>
      parseWrdnReviewManifest(JSON.stringify({ schemaVersion: 2, reviews: [validReview] })),
    ).toThrow();
    expect(() =>
      parseWrdnReviewManifest(
        JSON.stringify({ schemaVersion: 1, reviews: [{ ...validReview, verdict: "SKIP" }] }),
      ),
    ).toThrow();
    expect(() =>
      parseWrdnReviewManifest(
        JSON.stringify({ schemaVersion: 1, reviews: [{ ...validReview, evidence: 1 }] }),
      ),
    ).toThrow();
    expect(() =>
      parseWrdnReviewManifest(
        JSON.stringify({ schemaVersion: 1, reviews: [{ ...validReview, extra: true }] }),
      ),
    ).toThrow();
    expect(() =>
      parseWrdnReviewManifest(
        JSON.stringify({ schemaVersion: 1, reviews: [validReview, validReview] }),
      ),
    ).toThrow("duplicate skill");
    expect(() => parseWrdnReviewManifest("not json")).toThrow();
  });

  it("rejects failed tracked diff evidence instead of hashing partial output", () => {
    expect(() =>
      requireWrdnTrackedDiff(
        { status: null, stdout: "partial diff", error: new Error("buffer failure") },
        "partial.ts",
      ),
    ).toThrow("Could not inspect tracked file partial.ts");
    expect(() =>
      requireWrdnTrackedDiff({ status: 1, stdout: "partial diff" }, "failed.ts"),
    ).toThrow("Could not inspect tracked file failed.ts");
  });

  it("exits nonzero when the configured review manifest is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "osfo-wrdn-manifest-"));
    temporaryRoots.add(root);
    const manifest = join(root, "reviews.json");
    const marker = join(root, "lint-invoked");
    const bunStub = join(root, "bun");
    await writeFile(bunStub, `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
    await chmod(bunStub, 0o755);
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        reviews: [
          {
            skill: "wrdn-effect-vitest-tests",
            targets: ["test.ts"],
            verdict: "SKIP",
            evidence: "Invalid verdict.",
            diffDigest: "digest",
          },
        ],
      }),
    );

    const result = spawnSync(
      "node",
      ["--import", "tsx", resolve(repoRoot, "scripts/quality/wrdn-pass.ts")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          WRDN_BASE_REF: "origin/main",
          WRDN_REVIEW_FILE: manifest,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Expected "PASS" | "FAIL"');
    await expect(access(marker)).rejects.toThrow();
  });

  it("fails closed when the lint evidence command does not complete successfully", () => {
    expect(() =>
      requireWrdnLintOutput({
        status: 1,
        stdout: "",
        stderr: "lint crashed",
      }),
    ).toThrow("WRDN lint evidence is MISSING: lint crashed");
  });

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

  it("binds review evidence to patch location and context", () => {
    const target = "apps/worker/src/flag.ts";
    const first =
      "diff --git a/apps/worker/src/flag.ts b/apps/worker/src/flag.ts\n@@ -10,3 +10,3 @@ function first() {\n-  return false;\n+  return true;\n }\n";
    const relocated =
      "diff --git a/apps/worker/src/flag.ts b/apps/worker/src/flag.ts\n@@ -30,3 +30,3 @@ function second() {\n-  return false;\n+  return true;\n }\n";

    expect(wrdnDiffDigest([target], { [target]: first })).not.toBe(
      wrdnDiffDigest([target], { [target]: relocated }),
    );
  });

  it("binds lint-only review evidence to the complete changed file set", async () => {
    const skills = await discoverWrdnSkills(repoRoot);
    const firstContent = { "packages/a/src/value.ts": "+export const value = 1;\n" };
    const secondContent = { "packages/b/src/value.ts": "+export const value = 2;\n" };
    const first = evaluateWrdnPass(skills, {
      changedContent: firstContent,
      lintOutput: "Skill: wrdn-package-boundaries.",
      reviews: [],
    });
    const firstResult = first.find((result) => result.skill === "wrdn-package-boundaries");
    if (!firstResult) throw new Error("Missing package-boundary result.");
    const second = evaluateWrdnPass(skills, {
      changedContent: secondContent,
      lintOutput: "Skill: wrdn-package-boundaries.",
      reviews: [reviewFor(firstResult.skill, firstResult.targets, firstContent)],
    });

    expect(firstResult.targets).toEqual(["packages/a/src/value.ts"]);
    expect(second.find((result) => result.skill === "wrdn-package-boundaries")?.verdict).toBe(
      "MISSING",
    );
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

    await expect(collectChangedContent(root)).rejects.toThrow("WRDN_BASE_REF is required");

    const dirtyDigest = wrdnDiffDigest(["dirty.ts"], changedWithDirtyWorktree);
    git(root, "add", "dirty.ts");
    git(root, "commit", "--quiet", "-m", "dirty");
    const changedAfterCommit = await collectChangedContent(root, base);
    expect(wrdnDiffDigest(["dirty.ts"], changedAfterCommit)).toBe(dirtyDigest);
  });
});

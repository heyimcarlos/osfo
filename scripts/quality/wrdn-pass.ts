import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

export interface WrdnSkill {
  readonly name: string;
  readonly path: string;
}

const WrdnReviewSchema = Schema.Struct({
  skill: Schema.String,
  targets: Schema.Array(Schema.String),
  verdict: Schema.Union([Schema.Literal("PASS"), Schema.Literal("FAIL")]),
  evidence: Schema.String,
  diffDigest: Schema.String,
});

const WrdnReviewManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  reviews: Schema.Array(WrdnReviewSchema),
});

export type WrdnReview = typeof WrdnReviewSchema.Type;

export const parseWrdnReviewManifest = (source: string) => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(WrdnReviewManifestSchema), {
    onExcessProperty: "error",
  })(source);
  const skills = new Set<string>();
  for (const review of manifest.reviews) {
    if (skills.has(review.skill)) {
      throw new Error(`WRDN review manifest contains duplicate skill: ${review.skill}`);
    }
    skills.add(review.skill);
  }
  return manifest;
};

export interface WrdnInput {
  readonly changedContent: Readonly<Record<string, string>>;
  readonly changedFileContent?: Readonly<Record<string, string>>;
  readonly lintOutput: string;
  readonly reviews: readonly WrdnReview[];
}

export interface WrdnResult {
  readonly skill: string;
  readonly applicability: "APPLICABLE" | "NOT_APPLICABLE";
  readonly reason: string;
  readonly execution: string;
  readonly ruleNames: readonly string[];
  readonly targets: readonly string[];
  readonly verdict?: "PASS" | "FAIL" | "MISSING";
}

interface WrdnDefinition {
  readonly name: string;
  readonly matches: (path: string, added: string, final: string) => boolean;
  readonly ruleNames: readonly string[];
  readonly trigger: string;
}

const applicationSource = /^(?:apps|packages)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/u;
const testSource = /(?:^|\/)(?:test\/.*|.*\.(?:test|spec)\.tsx?)$/u;

export const wrdnDefinitions: readonly WrdnDefinition[] = [
  {
    name: "wrdn-effect-atom-optimistic",
    ruleNames: [],
    trigger: "effect-atom optimistic mutation source changed",
    matches: (path, content) =>
      path === "packages/react/src/api/atoms.tsx" ||
      /^packages\/react\/src\/pages\/.*\.tsx$/u.test(path) ||
      /from\s+["']\.\/api\/atoms["']/u.test(content),
  },
  {
    name: "wrdn-effect-atom-reactivity-keys",
    ruleNames: [],
    trigger: "effect-atom write mutation without explicit invalidation changed",
    matches: (path, content) =>
      applicationSource.test(path) &&
      /useAtomSet/u.test(content) &&
      !/reactivityKeys/u.test(content),
  },
  {
    name: "wrdn-effect-promise-exit",
    ruleNames: [],
    trigger: "promise-mode effect-atom try/catch handler changed",
    matches: (path, content) =>
      applicationSource.test(path) &&
      /useAtomSet/u.test(content) &&
      /mode:\s*["']promise["']/u.test(content) &&
      /\btry\b|\.catch\s*\(/u.test(content),
  },
  {
    name: "wrdn-effect-raw-fetch-boundary",
    ruleNames: ["osfo/no-raw-fetch"],
    trigger: "networked protocol or provider boundary changed",
    matches: (path, content, final) =>
      applicationSource.test(path) &&
      (/(?:^|[^.\w])fetch\s*\(/mu.test(content) ||
        (/(?:provider|protocol|http|openrouter)/iu.test(path) &&
          /HttpClient|Request|Response/u.test(final))),
  },
  {
    name: "wrdn-effect-schema-boundaries",
    ruleNames: ["osfo/no-unknown-shape-probing"],
    trigger: "unknown-data normalization boundary changed",
    matches: (path, content) =>
      applicationSource.test(path) &&
      /Schema\.decodeUnknown|Object\.hasOwn|Reflect\.get|JSON\.parse|as unknown as/u.test(content),
  },
  {
    name: "wrdn-effect-schema-inferred-types",
    ruleNames: [],
    trigger: "schema and manual shape changed together",
    matches: (path, content, final) =>
      applicationSource.test(path) &&
      ((/Schema\.(?:Struct|Union|TaggedStruct)/u.test(content) &&
        /(?:interface|type)\s+\w+\s*(?:=\s*\{|\{)/u.test(final)) ||
        (/(?:interface|type)\s+\w+\s*(?:=\s*\{|\{)/u.test(content) &&
          /Schema\.(?:Struct|Union|TaggedStruct)/u.test(final))),
  },
  {
    name: "wrdn-effect-typed-errors",
    ruleNames: ["osfo/no-untyped-effect-errors"],
    trigger: "Effect failure boundary changed",
    matches: (path, content) =>
      applicationSource.test(path) &&
      /\b(?:throw|try)\b|new Error|Promise\.(?:reject)|\.catch\s*\(|String\s*\(\s*(?:error|cause|reason)\s*\)|(?:error|cause|reason)\.message|instanceof Error|Effect\.(?:die|dieMessage|orDie|orDieWith)/u.test(
        content,
      ),
  },
  {
    name: "wrdn-effect-value-inferred-types",
    ruleNames: [],
    trigger: "object factory and manual API shape changed together",
    matches: (path, content, final) =>
      applicationSource.test(path) &&
      ((/(?:interface|type)\s+\w+\s*(?:=\s*\{|\{)/u.test(content) &&
        /return\s*\{|=>\s*\(\{/u.test(final)) ||
        (/return\s*\{|=>\s*\(\{/u.test(content) &&
          /(?:interface|type)\s+\w+\s*(?:=\s*\{|\{)/u.test(final))),
  },
  {
    name: "wrdn-effect-vitest-tests",
    ruleNames: ["no-restricted-imports", "vitest/no-conditional-expect"],
    trigger: "runtime test changed",
    matches: (path) => testSource.test(path),
  },
  {
    name: "wrdn-package-boundaries",
    ruleNames: ["osfo/no-cross-package-relative-imports"],
    trigger: "cross-package relative import lint finding",
    matches: () => false,
  },
  {
    name: "wrdn-typescript-type-safety",
    ruleNames: ["typescript/ban-ts-comment"],
    trigger: "TypeScript escape hatch changed",
    matches: (_path, content) => /@ts-(?:nocheck|ignore|expect-error)/u.test(content),
  },
];

export const discoverWrdnSkills = async (repoRoot: string): Promise<readonly WrdnSkill[]> => {
  const skillsRoot = join(repoRoot, ".agents/skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("wrdn-"))
      .map(async (entry) => {
        const path = join(skillsRoot, entry.name, "SKILL.md");
        const source = await readFile(path, "utf8");
        const name = /^name:\s*(wrdn-[^\s]+)$/mu.exec(source)?.[1];
        if (!name) throw new Error(`WRDN skill has no valid frontmatter name: ${path}`);
        return { name, path };
      }),
  );
  return skills.sort((left, right) => left.name.localeCompare(right.name));
};

const sameTargets = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export const wrdnDiffDigest = (
  targets: readonly string[],
  changedContent: Readonly<Record<string, string>>,
) => {
  const hash = createHash("sha256");
  for (const target of [...targets].sort()) {
    hash.update(`${target}\0${reviewContent(changedContent[target] ?? "")}\0`);
  }
  return hash.digest("hex");
};

export const evaluateWrdnPass = (
  skills: readonly WrdnSkill[],
  input: WrdnInput,
): readonly WrdnResult[] => {
  const configured = new Map(wrdnDefinitions.map((definition) => [definition.name, definition]));
  return skills.map((skill) => {
    const definition = configured.get(skill.name);
    if (!definition) {
      return {
        skill: skill.name,
        applicability: "APPLICABLE",
        reason: "Installed skill has no executable applicability policy.",
        execution: "No check was run.",
        ruleNames: [],
        targets: [],
        verdict: "MISSING",
      };
    }
    const matchingFiles = Object.entries(input.changedContent)
      .filter(
        ([path, content]) =>
          (definition.name === "wrdn-effect-vitest-tests" ||
            path !== "scripts/quality/wrdn-pass.test.ts") &&
          definition.matches(
            path,
            addedContent(content),
            input.changedFileContent?.[path] ?? addedContent(content),
          ),
      )
      .map(([path]) => path)
      .sort();
    const lintTriggered = input.lintOutput.includes(`Skill: ${skill.name}`);
    if (matchingFiles.length === 0 && !lintTriggered) {
      return {
        skill: skill.name,
        applicability: "NOT_APPLICABLE",
        reason: `No ${definition.trigger} and no matching lint finding.`,
        execution: "Not run.",
        ruleNames: definition.ruleNames,
        targets: [],
      };
    }
    const targets =
      matchingFiles.length > 0 ? matchingFiles : Object.keys(input.changedContent).sort();
    const review = input.reviews.find((candidate) => candidate.skill === skill.name);
    const validReview =
      review !== undefined &&
      review.evidence.trim().length > 0 &&
      sameTargets(review.targets, targets) &&
      review.diffDigest === wrdnDiffDigest(targets, input.changedContent);
    return {
      skill: skill.name,
      applicability: "APPLICABLE",
      reason: `${definition.trigger}: ${targets.join(", ")}.`,
      execution: `Read ${skill.path}; ${wrdnCommand(definition.ruleNames, targets)}`,
      ruleNames: definition.ruleNames,
      targets,
      verdict: validReview ? review.verdict : "MISSING",
    };
  });
};

const wrdnCommand = (ruleNames: readonly string[], targets: readonly string[]) =>
  ruleNames.length === 0
    ? "manual trace required"
    : [
        "oxlint",
        "--type-aware",
        "-A",
        "all",
        ...ruleNames.flatMap((rule) => ["-D", rule]),
        ...targets,
      ].join(" ");

export const executeWrdnPass = (
  results: readonly WrdnResult[],
  execute: (args: readonly string[]) => number,
): readonly WrdnResult[] =>
  results.map((result) => {
    if (
      result.applicability === "NOT_APPLICABLE" ||
      result.verdict !== "PASS" ||
      result.ruleNames.length === 0
    ) {
      return result;
    }
    const args = [
      "--type-aware",
      "-A",
      "all",
      ...result.ruleNames.flatMap((rule) => ["-D", rule]),
      ...result.targets,
    ];
    return { ...result, verdict: execute(args) === 0 ? "PASS" : "FAIL" };
  });

const addedContent = (content: string) =>
  content.startsWith("diff --git ")
    ? content
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n")
    : content;

const reviewContent = (content: string) => content.replace(/\r\n/gu, "\n").replace(/\n$/u, "");

export const requireWrdnTrackedDiff = (
  result: {
    readonly status: number | null;
    readonly stdout: string;
    readonly error?: Error | undefined;
  },
  path: string,
) => {
  if (result.error || result.status !== 0) {
    throw new Error(`Could not inspect tracked file ${path}.`);
  }
  return result.stdout;
};

export const collectChangedContent = async (repoRoot: string, baseRef?: string) => {
  if (!baseRef) throw new Error("WRDN_BASE_REF is required for every WRDN pass.");
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (status.status !== 0) throw new Error("Could not inspect repository status.");
  const dirty = status.stdout.trim().length > 0;
  const mergeBase = spawnSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (mergeBase.status !== 0) {
    throw new Error(`Could not resolve the merge base for ${baseRef}.`);
  }
  const range = mergeBase.stdout.trim();
  const trackedArgs = ["diff", "--name-only", range];
  const tracked = spawnSync("git", trackedArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const untracked = dirty
    ? spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
    : { status: 0, stdout: "" };
  if (tracked.status !== 0 || untracked.status !== 0) {
    throw new Error(`Could not inspect the final diff from ${range}.`);
  }
  const paths = [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean))];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        const diffArgs = ["diff", range, "--", path];
        const diff = spawnSync("git", diffArgs, {
          cwd: repoRoot,
          encoding: "utf8",
        });
        const trackedDiff = requireWrdnTrackedDiff(diff, path);
        const untrackedDiff = trackedDiff
          ? undefined
          : spawnSync("git", ["diff", "--no-index", "--", "/dev/null", path], {
              cwd: repoRoot,
              encoding: "utf8",
            });
        if (untrackedDiff && untrackedDiff.status !== 0 && untrackedDiff.status !== 1) {
          throw new Error(`Could not inspect untracked file ${path}.`);
        }
        const content = trackedDiff || untrackedDiff?.stdout || "";
        return [path, content] as const;
      }),
    ),
  );
};

export const collectChangedFileContent = async (
  repoRoot: string,
  paths: readonly string[],
): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        existsSync(join(repoRoot, path)) ? await readFile(join(repoRoot, path), "utf8") : "",
      ]),
    ),
  );

export const resolveWrdnBaseRef = (repoRoot: string, explicit?: string) => {
  if (explicit) return explicit;
  const remoteHead = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (remoteHead.status === 0) return remoteHead.stdout.trim();
  for (const candidate of ["origin/main", "origin/master"]) {
    const resolved = spawnSync("git", ["rev-parse", "--verify", candidate], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (resolved.status === 0) return candidate;
  }
  throw new Error("WRDN_BASE_REF is required because no remote default branch was found.");
};

const renderTable = (results: readonly WrdnResult[]) =>
  [
    "| Skill | Applicable | Reason | Execution | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.skill} | ${result.applicability === "APPLICABLE" ? "Yes" : "No"} | ${result.reason} | ${result.execution} | ${result.verdict ?? ""} |`,
    ),
  ].join("\n");

export const requireWrdnLintOutput = (lint: {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}) => {
  const output = `${lint.stdout}${lint.stderr}`;
  if (lint.status !== 0) {
    const detail = output.trim() || `lint command exited with status ${lint.status ?? "unknown"}`;
    throw new Error(`WRDN lint evidence is MISSING: ${detail}`);
  }
  return output;
};

const main = async () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const reviewPath = process.env.WRDN_REVIEW_FILE
    ? resolve(repoRoot, process.env.WRDN_REVIEW_FILE)
    : join(repoRoot, ".wrdn-reviews.json");
  const reviewFile = parseWrdnReviewManifest(await readFile(reviewPath, "utf8"));
  const lint = spawnSync("bun", ["run", "lint"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const changedContent = await collectChangedContent(
    repoRoot,
    resolveWrdnBaseRef(repoRoot, process.env.WRDN_BASE_REF),
  );
  const applicability = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
    changedContent,
    changedFileContent: await collectChangedFileContent(repoRoot, Object.keys(changedContent)),
    lintOutput: requireWrdnLintOutput(lint),
    reviews: reviewFile.reviews,
  });
  const results = executeWrdnPass(applicability, (args) => {
    const execution = spawnSync(resolve(repoRoot, "node_modules/.bin/oxlint"), args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return execution.status ?? 1;
  });
  const outputPath = join(repoRoot, ".tmp/quality/wrdn-report.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`);
  console.log(renderTable(results));
  console.log(`WRDN report: ${outputPath}`);
  if (results.some((result) => result.verdict === "FAIL" || result.verdict === "MISSING")) {
    process.exitCode = 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

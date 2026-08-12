import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WrdnSkill {
  readonly name: string;
  readonly path: string;
}

export interface WrdnReview {
  readonly skill: string;
  readonly targets: readonly string[];
  readonly verdict: "PASS" | "FAIL";
  readonly evidence: string;
  readonly diffDigest: string;
}

export interface WrdnInput {
  readonly changedContent: Readonly<Record<string, string>>;
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
  readonly matches: (path: string, content: string) => boolean;
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
    matches: (path, content) =>
      applicationSource.test(path) &&
      (/(?:^|[^.\w])fetch\s*\(/mu.test(content) ||
        (/(?:provider|protocol|http)/iu.test(path) &&
          /HttpClient|Request|Response/u.test(content))),
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
    matches: (path, content) =>
      applicationSource.test(path) &&
      /Schema\.(?:Struct|Union|TaggedStruct)/u.test(content) &&
      /(?:interface|type)\s+\w+\s*(?:=\s*\{|\{)/u.test(content),
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
    matches: (path, content) =>
      applicationSource.test(path) &&
      /(?:interface|type)\s+\w+\s*(?:=\s*\{|\{)/u.test(content) &&
      /return\s*\{|=>\s*\(\{/u.test(content),
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
          definition.matches(path, addedContent(content)),
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
    const targets = matchingFiles.length > 0 ? matchingFiles : ["."];
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
  content.includes("diff --git")
    ? content
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n")
    : content;

const reviewContent = (content: string) =>
  content.includes("diff --git")
    ? content
        .split("\n")
        .filter(
          (line) =>
            (line.startsWith("+") && !line.startsWith("+++")) ||
            (line.startsWith("-") && !line.startsWith("---")),
        )
        .join("\n")
    : content
        .replace(/\n$/u, "")
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n");

export const collectChangedContent = async (repoRoot: string, baseRef?: string) => {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (status.status !== 0) throw new Error("Could not inspect repository status.");
  const dirty = status.stdout.trim().length > 0;
  if (!dirty && !baseRef) {
    throw new Error("WRDN_BASE_REF is required for a clean checkout.");
  }
  const mergeBase = baseRef
    ? spawnSync("git", ["merge-base", baseRef, "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
    : undefined;
  if (mergeBase && mergeBase.status !== 0) {
    throw new Error(`Could not resolve the merge base for ${baseRef}.`);
  }
  const range = mergeBase?.stdout.trim() || "HEAD";
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
        const content = diff.stdout || (await readFile(join(repoRoot, path), "utf8"));
        return [path, content] as const;
      }),
    ),
  );
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

const main = async () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const lint = spawnSync("bun", ["run", "lint"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const reviewFile = JSON.parse(await readFile(join(repoRoot, ".wrdn-reviews.json"), "utf8")) as {
    readonly reviews: readonly WrdnReview[];
  };
  const applicability = evaluateWrdnPass(await discoverWrdnSkills(repoRoot), {
    changedContent: await collectChangedContent(repoRoot, process.env.WRDN_BASE_REF),
    lintOutput: `${lint.stdout}${lint.stderr}`,
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

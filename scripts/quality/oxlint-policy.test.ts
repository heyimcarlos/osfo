import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const lint = (path: string) => {
  const result = spawnSync(
    resolve(repoRoot, "node_modules/.bin/oxlint"),
    [
      "--config",
      resolve(repoRoot, ".oxlintrc.jsonc"),
      "--type-aware",
      "--deny-warnings",
      "--report-unused-disable-directives",
      "--no-ignore",
      path,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const lintFixture = async (name: string, source: string) => {
  const fixtureRoot = await mkdtemp(join(repoRoot, "packages/agent-run/src/.quality-fixtures-"));
  const path = join(fixtureRoot, name);
  await writeFile(path, source);
  try {
    return lint(path);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await expect(access(fixtureRoot)).rejects.toThrow();
  }
};

const cases = [
  {
    policy: "Effect Vitest import",
    rule: "eslint(no-restricted-imports)",
    name: "vitest-import.test.ts",
    invalid: 'import { expect, it } from "vitest";\nit("checks", () => { expect(1).toBe(1); });\n',
    valid:
      'import { expect, it } from "@effect/vitest";\nit("checks", () => { expect(1).toBe(1); });\n',
  },
  {
    policy: "conditional test assertion",
    rule: "vitest(no-conditional-expect)",
    name: "conditional.test.ts",
    invalid:
      'import { expect, it } from "@effect/vitest";\nit("checks", () => { if (true) { expect("actual").toBe("expected"); } });\n',
    valid:
      'import { expect, it } from "@effect/vitest";\nconst select = (flag: boolean) => flag ? "expected" : "other";\nit("checks", () => { const actual = select(true); expect(actual).toBe("expected"); });\n',
  },
  {
    policy: "package boundary",
    rule: "osfo(no-cross-package-relative-imports)",
    name: "cross-package.ts",
    invalid: 'import { OsfoApi } from "../../../api/src/index.js";\nvoid OsfoApi;\n',
    valid: 'import { OsfoApi } from "@osfo/api";\nvoid OsfoApi;\n',
  },
  {
    policy: "TypeScript escape hatch",
    rule: "typescript(ban-ts-comment)",
    name: "type-bypass.ts",
    invalid: `// @ts-${"nocheck"}\nexport const value = 1;\n`,
    valid: "export const value: number = 1;\n",
  },
  {
    policy: "untyped Effect error",
    rule: "osfo(no-untyped-effect-errors)",
    name: "untyped-error.ts",
    invalid: 'export const fail = () => { throw new Error("failed"); };\n',
    valid:
      'import { Data, Effect } from "effect";\nclass Failure extends Data.TaggedError("Failure") {}\nexport const fail = Effect.fail(new Failure());\n',
  },
  {
    policy: "Promise catch error",
    rule: "osfo(no-untyped-effect-errors)",
    name: "promise-catch.ts",
    invalid:
      "export const recover = (promise: Promise<void>) => promise.catch((error) => String(error));\n",
    valid:
      'import { Data, Effect } from "effect";\nclass Failure extends Data.TaggedError("Failure") {}\nexport const recover = Effect.fail(new Failure());\n',
  },
  {
    policy: "unknown error message",
    rule: "osfo(no-untyped-effect-errors)",
    name: "unknown-error-message.ts",
    invalid: "export const message = (error: unknown) => error.message;\n",
    valid:
      'import { Schema } from "effect";\nconst Failure = Schema.Struct({ message: Schema.String });\nexport const decode = Schema.decodeUnknownEffect(Failure);\n',
  },
  {
    policy: "unknown double cast",
    rule: "osfo(no-unknown-shape-probing)",
    name: "unknown-shape.ts",
    invalid:
      "export const decode = (input: string) => JSON.parse(input) as unknown as { value: string };\n",
    valid:
      'import { Schema } from "effect";\nconst Input = Schema.Struct({ value: Schema.String });\nexport const decode = Schema.decodeUnknownEffect(Input);\n',
  },
  {
    policy: "inline object assertion",
    rule: "osfo(no-unknown-shape-probing)",
    name: "inline-object-assertion.ts",
    invalid:
      "export const endpoint = (input: unknown) => (input as { endpoint: string }).endpoint;\n",
    valid:
      'import { Schema } from "effect";\nconst Input = Schema.Struct({ endpoint: Schema.String });\nexport const decode = Schema.decodeUnknownEffect(Input);\n',
  },
  {
    policy: "inline Record assertion",
    rule: "osfo(no-unknown-shape-probing)",
    name: "inline-record-assertion.ts",
    invalid:
      'export const endpoint = (input: unknown) => (input as Record<string, unknown>)["endpoint"];\n',
    valid:
      'import { Schema } from "effect";\nconst Input = Schema.Record({ key: Schema.String, value: Schema.Unknown });\nexport const decode = Schema.decodeUnknownEffect(Input);\n',
  },
  {
    policy: "raw fetch",
    rule: "osfo(no-raw-fetch)",
    name: "raw-fetch.ts",
    invalid: 'export const load = () => fetch("https://example.test");\n',
    valid:
      'import { HttpClient, HttpClientRequest } from "effect/unstable/http";\nexport const load = HttpClient.HttpClient.use((client) => client.execute(HttpClientRequest.get("https://example.test")));\n',
  },
] as const;

describe("Osfo Oxlint policy", () => {
  for (const fixture of cases) {
    it(`rejects the ${fixture.policy} positive fixture`, async () => {
      const result = await lintFixture(fixture.name, fixture.invalid);

      expect(result.status).toBe(1);
      expect(result.output).toContain(fixture.rule);
    });

    it(`accepts the ${fixture.policy} negative fixture`, async () => {
      const result = await lintFixture(fixture.name, fixture.valid);

      expect(result).toMatchObject({ status: 0 });
      expect(result.output).not.toContain(fixture.rule);
    });
  }

  it("rejects an unused suppression", async () => {
    const result = await lintFixture(
      "unused-suppression.ts",
      "// oxlint-disable-next-line osfo/no-raw-fetch\nexport const value = 1;\n",
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain("Unused oxlint-disable directive");
  });

  it("keeps the browser entry-point exception narrow", async () => {
    const boundary = lint(join(repoRoot, "apps/web/src/main.tsx"));
    const application = await lintFixture(
      "application-throw.ts",
      'throw new Error("domain failure");\n',
    );

    expect(boundary.status).toBe(0);
    expect(application.status).toBe(1);
    expect(application.output).toContain("osfo(no-untyped-effect-errors)");
  });
});

import { resolve } from "node:path";

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "./no-cross-package-relative-imports.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
describe("osfo/no-cross-package-relative-imports", () => {
  it.effect("accepts public exports and rejects relative workspace crossings", () =>
    Effect.sync(() => {
      const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
      tester.run("osfo/no-cross-package-relative-imports", rule, {
        valid: [
          {
            code: 'import { OsfoApi } from "@osfo/api"; void OsfoApi;',
            filename: resolve(repoRoot, "packages/agent-run/src/fixture.ts"),
          },
        ],
        invalid: [
          {
            code: 'import { OsfoApi } from "../../api/src/index.js"; void OsfoApi;',
            filename: resolve(repoRoot, "packages/agent-run/src/fixture.ts"),
            errors: 1,
          },
        ],
      });
    }),
  );
});

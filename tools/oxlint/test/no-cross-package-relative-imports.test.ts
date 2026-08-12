import { describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";
import { resolve } from "node:path";
import { Effect } from "effect";

import rule from "../rules/no-cross-package-relative-imports.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-cross-package-relative-imports", () => {
  it.effect("accepts package exports and rejects relative workspace crossings", () =>
    Effect.sync(() => {
      tester.run("osfo/no-cross-package-relative-imports", rule, {
        valid: [
          {
            code: 'import { Button } from "@osfo/ui/components/button"; void Button;',
            filename: resolve(repositoryRoot, "apps/web/src/fixture.ts"),
          },
          {
            code: 'import { App } from "./App"; void App;',
            filename: resolve(repositoryRoot, "apps/web/src/fixture.ts"),
          },
        ],
        invalid: [
          {
            code: 'import { Button } from "../../../packages/ui/src/components/button"; void Button;',
            filename: resolve(repositoryRoot, "apps/web/src/fixture.ts"),
            errors: [{ messageId: "crossPackageImport" }],
          },
        ],
      });
    }),
  );
});

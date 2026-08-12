import { resolve } from "node:path";

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "./no-raw-fetch.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
describe("osfo/no-raw-fetch", () => {
  it.effect("accepts Effect clients and rejects application fetch calls", () =>
    Effect.sync(() => {
      const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
      tester.run("osfo/no-raw-fetch", rule, {
        valid: [
          {
            code: "const response = client.execute(request);",
            filename: resolve(repoRoot, "apps/ingress/src/fixture.ts"),
          },
        ],
        invalid: [
          {
            code: 'const response = fetch("https://example.test");',
            filename: resolve(repoRoot, "apps/ingress/src/fixture.ts"),
            errors: 1,
          },
        ],
      });
    }),
  );
});

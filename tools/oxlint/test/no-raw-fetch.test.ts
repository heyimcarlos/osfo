import { describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";
import { resolve } from "node:path";
import { Effect } from "effect";

import rule from "../rules/no-raw-fetch.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-raw-fetch", () => {
  it.effect("accepts explicit clients and rejects raw application fetch", () =>
    Effect.sync(() => {
      tester.run("osfo/no-raw-fetch", rule, {
        valid: [
          {
            code: "const response = client.execute(request); void response;",
            filename: resolve(repositoryRoot, "apps/web/src/fixture.ts"),
          },
          {
            code: 'const response = fetch("https://example.test"); void response;',
            filename: resolve(repositoryRoot, "apps/web/src/fixture.test.ts"),
          },
        ],
        invalid: [
          {
            code: 'const response = fetch("https://example.test"); void response;',
            filename: resolve(repositoryRoot, "apps/web/src/fixture.ts"),
            errors: [{ messageId: "rawFetch" }],
          },
          {
            code: "const request = globalThis.fetch; void request;",
            filename: resolve(repositoryRoot, "packages/ui/src/fixture.ts"),
            errors: [{ messageId: "rawFetch" }],
          },
        ],
      });
    }),
  );
});

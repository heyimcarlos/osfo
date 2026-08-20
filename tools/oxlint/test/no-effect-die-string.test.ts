import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "../rules/no-effect-die-string.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-effect-die-string", () => {
  it.effect("requires Error values for literal defects", () =>
    Effect.sync(() => {
      tester.run("osfo/no-effect-die-string", rule, {
        valid: ['Effect.die(new Error("failed"));', "Effect.die(cause);", 'Other.die("failed");'],
        invalid: [
          {
            code: 'Effect.die("failed");',
            errors: [{ messageId: "stringDefect" }],
          },
          {
            code: "Effect.die(`failed: ${reason}`);",
            errors: [{ messageId: "stringDefect" }],
          },
        ],
      });
    }),
  );
});

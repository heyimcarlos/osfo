import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "../rules/no-star-import.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-star-import", () => {
  it.effect("accepts named namespaces and rejects namespace imports", () =>
    Effect.sync(() => {
      tester.run("osfo/no-star-import", rule, {
        valid: [
          'import { Onboarding } from "./onboarding"; void Onboarding;',
          'export * as Onboarding from "./onboarding";',
          'const module = import("./onboarding"); void module;',
        ],
        invalid: [
          {
            code: 'import * as Onboarding from "./onboarding"; void Onboarding;',
            errors: [{ messageId: "starImport" }],
          },
          {
            code: 'import type * as Onboarding from "./onboarding"; type Value = Onboarding.Interface;',
            errors: [{ messageId: "starImport" }],
          },
        ],
      });
    }),
  );
});

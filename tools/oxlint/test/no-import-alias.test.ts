import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "../rules/no-import-alias.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-import-alias", () => {
  it.effect("keeps value imports canonical and permits dedicated type collisions", () =>
    Effect.sync(() => {
      tester.run("osfo/no-import-alias", rule, {
        valid: [
          'import { Service } from "./service"; void Service;',
          'import type { Interface as ServiceInterface } from "./service"; type Value = ServiceInterface;',
        ],
        invalid: [
          {
            code: 'import { Service as AuthSession } from "./service"; void AuthSession;',
            errors: [{ messageId: "importAlias" }],
          },
          {
            code: 'import { type Interface as ServiceInterface } from "./service"; type Value = ServiceInterface;',
            errors: [{ messageId: "importAlias" }],
          },
        ],
      });
    }),
  );
});

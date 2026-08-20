import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "../rules/no-nested-effect-service-yield.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-nested-effect-service-yield", () => {
  it.effect("requires a named service binding before method calls", () =>
    Effect.sync(() => {
      tester.run("osfo/no-nested-effect-service-yield", rule, {
        valid: [
          "Effect.gen(function* () { const service = yield* Onboarding.Service; yield* service.complete(input); });",
          "Effect.gen(function* () { yield* workflow.complete(input); });",
          "Effect.gen(function* () { const db = (yield* Database.Service).db; yield* db.run(); });",
        ],
        invalid: [
          {
            code: "Effect.gen(function* () { yield* (yield* Onboarding.Service).complete(input); });",
            errors: [{ messageId: "nestedServiceYield" }],
          },
          {
            code: "Effect.gen(function* () { yield* (yield* Onboarding.Service).commands.complete(input); });",
            errors: [{ messageId: "nestedServiceYield" }],
          },
        ],
      });
    }),
  );
});

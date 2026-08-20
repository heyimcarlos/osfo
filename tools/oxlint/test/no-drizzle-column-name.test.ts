import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import rule from "../rules/no-drizzle-column-name.ts";
import { repositoryRoot } from "../shared/repository.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("osfo/no-drizzle-column-name", () => {
  it.effect("checks owned schemas and leaves adapter-owned schemas alone", () =>
    Effect.sync(() => {
      tester.run("osfo/no-drizzle-column-name", rule, {
        valid: [
          {
            filename: resolve(repositoryRoot, "packages/db/src/schema/onboarding.ts"),
            code: "const value = { invitation_id: text() }; void value;",
          },
          {
            filename: resolve(repositoryRoot, "packages/db/src/schema/onboarding.ts"),
            code: "const value = { created_at: timestamp({ withTimezone: true }) }; void value;",
          },
          {
            filename: resolve(repositoryRoot, "packages/db/src/schema/auth.ts"),
            code: 'const value = { userId: text("user_id") }; void value;',
          },
          {
            filename: resolve(repositoryRoot, "apps/worker/src/services/example.ts"),
            code: 'const value = text("external_name"); void value;',
          },
        ],
        invalid: [
          {
            filename: resolve(repositoryRoot, "packages/db/src/schema/onboarding.ts"),
            code: 'const value = { invitationId: text("invitation_id") }; void value;',
            errors: [{ messageId: "explicitColumn" }],
          },
          {
            filename: resolve(repositoryRoot, "apps/worker/src/agents/osfo/db/schema.ts"),
            code: 'const value = { createdAt: integer("created_at", { mode: "timestamp" }) }; void value;',
            errors: [{ messageId: "explicitColumn" }],
          },
          {
            filename: resolve(repositoryRoot, "apps/worker/src/agents/osfo/db/schema.ts"),
            code: 'const value = { routeId: routeId("route_id") }; void value;',
            errors: [{ messageId: "explicitColumn" }],
          },
        ],
      });
    }),
  );
});

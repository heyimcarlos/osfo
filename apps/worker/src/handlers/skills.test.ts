/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest executes generator assertions inside each test. */

import { describe, expect, it } from "@effect/vitest";
import { SkillsSummary } from "@osfo/api";
import { DateTime, Effect } from "effect";

import { validateSkillRpcResponse } from "./skills";

describe("Skills RPC boundary", () => {
  it.effect("accepts a used Skill with a Type-side Date", () =>
    Effect.gen(function* () {
      const lastUsedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-26T12:00:00.000Z"));
      const result = yield* validateSkillRpcResponse(
        Promise.resolve({
          skills: [
            {
              availability: { state: "available" },
              behavior: "Put the summary before the details.",
              canUndo: false,
              capabilities: ["Generate one bounded PDF or DOCX."],
              lastUsedAt,
              purpose: "Prepare the weekly report.",
              reference: "private-skill-id",
              revisionReference: "private-version-id",
              status: "active",
            },
          ],
        }),
        SkillsSummary,
      );

      expect(result.skills[0]?.lastUsedAt).toEqual(lastUsedAt);
    }),
  );
});

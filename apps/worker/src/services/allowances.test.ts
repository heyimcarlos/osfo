import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AllowancePeriodId, PlanPolicyVersion, UserId } from "../domain";
import { retainedCatalog } from "../domain/plan-policy";
import { make } from "./allowances";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- Fixed period fixtures and Effect callbacks prove exact reset presentation. */

describe("Allowances", () => {
  it.effect("presents one shared pool and the 20 percent warning without internal quantities", () =>
    Effect.gen(function* () {
      const userId = UserId.make("usage-user");
      const resetsAt = new Date("2026-09-22T00:00:00.000Z");
      const allowances = make({
        billing: {
          inspect: () =>
            Effect.succeed({
              allowancePeriodId: AllowancePeriodId.make("period-1"),
              endsAt: resetsAt,
              plan: "free" as const,
              planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
              usage: [{ allowanceKind: "planUsageMicros" as const, quantity: 1_600_000n }],
              userId,
            }),
          recordUsage: () => Effect.die(new Error("recordUsage is not used by this test")),
          recordUsageForUser: () =>
            Effect.die(new Error("recordUsageForUser is not used by this test")),
        },
        catalog: retainedCatalog,
        now: Effect.succeed(new Date("2026-08-23T00:00:00.000Z")),
      });

      const inspection = yield* allowances.inspect(userId);

      expect(inspection).toEqual({
        _tag: "PlanUsage",
        allowancePeriodId: "period-1",
        plan: "free",
        remainingLabel: "20%",
        remainingPercent: 20,
        resetsAt,
        userId: "usage-user",
        warning: "twentyPercent",
      });
      expect(inspection).not.toHaveProperty("recorded");
      expect(inspection).not.toHaveProperty("limit");
      expect(inspection).not.toHaveProperty("usagePolicyVersion");
    }),
  );

  it.effect("uses whole percentages, less-than-one, and zero only at exhaustion", () =>
    Effect.gen(function* () {
      const cases = [
        { label: "100%", percentage: 100, recorded: 0n, warning: null },
        { label: "66%", percentage: 66, recorded: 666_667n, warning: null },
        { label: "<1%", percentage: 0, recorded: 1_999_999n, warning: "twentyPercent" },
        { label: "0%", percentage: 0, recorded: 2_000_000n, warning: "exhausted" },
      ] as const;
      for (const expected of cases) {
        const inspection = yield* makeInspection(expected.recorded);
        expect(inspection).toMatchObject({
          _tag: "PlanUsage",
          remainingLabel: expected.label,
          remainingPercent: expected.percentage,
          warning: expected.warning,
        });
      }
    }),
  );
});

const makeInspection = (recorded: bigint) => {
  const userId = UserId.make("percentage-user");
  return make({
    billing: {
      inspect: () =>
        Effect.succeed({
          allowancePeriodId: AllowancePeriodId.make("percentage-period"),
          endsAt: new Date("2026-09-22T00:00:00.000Z"),
          plan: "free" as const,
          planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
          usage: [{ allowanceKind: "planUsageMicros" as const, quantity: recorded }],
          userId,
        }),
      recordUsage: () => Effect.die(new Error("recordUsage is not used by this test")),
      recordUsageForUser: () =>
        Effect.die(new Error("recordUsageForUser is not used by this test")),
    },
    catalog: retainedCatalog,
    now: Effect.succeed(new Date("2026-08-23T00:00:00.000Z")),
  }).inspect(userId);
};

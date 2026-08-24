import { describe, expect, it } from "@effect/vitest";

import { AllowancePeriodId } from "../domain";
import { selectActiveResources, startFreePeriodAfterDowngrade } from "./downgrade";

/* oxlint-disable effecttsgo/global-date -- Fixed resource and period order proves downgrade behavior. */

describe("Adventurer downgrade", () => {
  it("starts fresh Free Usage while admitted work keeps its original period", () => {
    const result = startFreePeriodAfterDowngrade({
      admittedAllowancePeriodId: AllowancePeriodId.make("adventurer-period"),
      newFreeAllowancePeriodId: AllowancePeriodId.make("free-period"),
    });
    expect(result).toEqual({
      admittedWorkAllowancePeriodId: "adventurer-period",
      includedPlanUsageMicros: 2_000_000n,
      newPeriodAllowancePeriodId: "free-period",
      recordedPlanUsageMicros: 0n,
    });
  });

  it("keeps oldest resources active by default and permits explicit reselection", () => {
    const resources = [
      { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: "oldest" },
      { createdAt: new Date("2026-02-01T00:00:00.000Z"), id: "middle" },
      { createdAt: new Date("2026-03-01T00:00:00.000Z"), id: "newest" },
    ];
    expect(selectActiveResources(resources, 2, null)).toEqual({
      active: ["oldest", "middle"],
      paused: ["newest"],
    });
    expect(selectActiveResources(resources, 2, ["middle", "newest"])).toEqual({
      active: ["middle", "newest"],
      paused: ["oldest"],
    });
  });
});

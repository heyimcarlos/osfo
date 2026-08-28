import { expect, it } from "@effect/vitest";

import { PlanPolicyVersion } from "../../domain";
import { activeReminderLimit } from "./reminder-policy";

it("preserves launch limits and interprets inactive shared-usage limits", () => {
  expect(
    activeReminderLimit({ plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") }),
  ).toBe(1);
  expect(
    activeReminderLimit({
      plan: "adventurer",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    }),
  ).toBe(25);
  expect(
    activeReminderLimit({
      plan: "free",
      planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
    }),
  ).toBe(5);
  expect(
    activeReminderLimit({
      plan: "adventurer",
      planPolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
    }),
  ).toBe(25);
});

import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import { WhatsAppWakeUps } from "../../src/services/whatsapp-wakeups";

it("accepts exactly the four source-owned v1 Wake-up variants", () => {
  const allowed = ["Reminder", "ResearchReport", "DocumentBuild", "ScheduledEmail"];
  expect(
    allowed.map((_tag) =>
      Result.isSuccess(
        Schema.decodeUnknownResult(WhatsAppWakeUps.Source)({ _tag, identity: "committed-1" }),
      ),
    ),
  ).toEqual([true, true, true, true]);

  expect(
    ["Help", "Human", "GmSummon", "Billing", "Marketing", "AllowanceWarning", "Onboarding"].map(
      (_tag) =>
        Result.isFailure(
          Schema.decodeUnknownResult(WhatsAppWakeUps.Source)({ _tag, identity: "forbidden-1" }),
        ),
    ),
  ).toEqual([true, true, true, true, true, true, true]);
});

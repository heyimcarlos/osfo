import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import { ReminderManageInput } from "./reminder-tool-contracts";

const createInput = (body: string) => ({
  _tag: "CreateOneTime" as const,
  body,
  firstDueAt: "2026-08-29T12:00:00.000Z",
});

it("enforces the exact 2,000 UTF-8 byte Reminder body boundary", () => {
  expect(
    Result.isSuccess(Schema.decodeResult(ReminderManageInput)(createInput("😀".repeat(500)))),
  ).toBe(true);
  expect(
    Result.isFailure(Schema.decodeResult(ReminderManageInput)(createInput("😀".repeat(501)))),
  ).toBe(true);
  expect(Result.isFailure(Schema.decodeResult(ReminderManageInput)(createInput("")))).toBe(true);
});

it.each([
  "tomorrow",
  "2026-09-05",
  "2026-09-05T12:00:00",
  "2026-02-30T12:00:00.000Z",
  "2026-09-05T25:00:00.000Z",
])("rejects invalid or ambiguous Reminder time %s before Approval", (firstDueAt) => {
  expect(
    Result.isFailure(
      Schema.decodeResult(ReminderManageInput)({ ...createInput("Remember this"), firstDueAt }),
    ),
  ).toBe(true);
});

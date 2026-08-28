import { Schema } from "effect";

import { ReminderId } from "./reminders";

export const reminderManageActionName = "osfoManageReminder";
export const reminderCancelToolName = "osfoCancelReminder";
export const reminderInspectToolName = "osfoInspectReminder";

const ReminderBody = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (body) =>
      new TextEncoder().encode(body).byteLength <= 2_000 ||
      "Reminder bodies must not exceed 2,000 encoded bytes",
  ),
);
const ReminderRevision = Schema.Int.check(Schema.isGreaterThan(0));
const ReminderInterval = Schema.Int.check(Schema.isGreaterThanOrEqualTo(86_400_000));

const OneTimeFacts = {
  body: ReminderBody,
  firstDueAt: Schema.DateFromString,
} as const;

const RecurringFacts = {
  ...OneTimeFacts,
  intervalMilliseconds: ReminderInterval,
} as const;

export const ReminderManageInput = Schema.TaggedUnion({
  CreateOneTime: OneTimeFacts,
  CreateRecurring: RecurringFacts,
  ChangeOneTime: {
    ...OneTimeFacts,
    expectedRevision: ReminderRevision,
    reminderId: ReminderId,
  },
  ChangeRecurring: {
    ...RecurringFacts,
    expectedRevision: ReminderRevision,
    reminderId: ReminderId,
  },
  ReactivateOneTime: {
    ...OneTimeFacts,
    expectedRevision: ReminderRevision,
    reminderId: ReminderId,
  },
  ReactivateRecurring: {
    ...RecurringFacts,
    expectedRevision: ReminderRevision,
    reminderId: ReminderId,
  },
});

export type ReminderManageInput = typeof ReminderManageInput.Type;

export const ReminderCancelInput = Schema.Struct({
  expectedRevision: ReminderRevision,
  reminderId: ReminderId,
});

export type ReminderCancelInput = typeof ReminderCancelInput.Type;

export const ReminderInspectInput = Schema.Struct({ reminderId: ReminderId });

export type ReminderInspectInput = typeof ReminderInspectInput.Type;

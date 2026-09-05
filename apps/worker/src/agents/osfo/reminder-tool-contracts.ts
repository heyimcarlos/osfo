import { DateTime, Option, Schema } from "effect";

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

const ReminderDueAt = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) &&
      DateTime.formatIso(parsed.value) === value.replace(/(?<=:\d{2})Z$/u, ".000Z")
    );
  }),
).pipe(Schema.decodeTo(Schema.DateFromString));

const OneTimeFacts = {
  body: ReminderBody,
  firstDueAt: ReminderDueAt,
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

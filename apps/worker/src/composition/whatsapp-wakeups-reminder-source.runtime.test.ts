import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../domain";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";
import { reminderSourceAuthorityLayer } from "./whatsapp-wakeups";

/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside @effect/vitest Effect test callbacks. */
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date-in-effect, effecttsgo/strict-effect-provide -- This runtime test owns Promise RPC fakes, fixed instants, and its complete test Layer. */

const userId = UserId.make("reminder-source-user");
const source = WhatsAppWakeUps.Source.cases.Reminder.make({
  identity: WhatsAppWakeUps.SourceIdentity.make("reminder:one:1:2026-08-28T12:00:00.000Z"),
});

it.effect("delegates Reminder source snapshots through the Directory RPC boundary", () => {
  const exposed: Array<{
    readonly committed: ReadonlyArray<{
      readonly committedAt: string;
      readonly sourceIdentity: string;
    }>;
    readonly userId: string;
  }> = [];
  const directory = {
    exposeReminderWakeUpSources: async (
      encodedUserId: string,
      committed: ReadonlyArray<{ readonly committedAt: string; readonly sourceIdentity: string }>,
    ) => {
      exposed.push({ committed, userId: encodedUserId });
    },
    inspectReminderWakeUpSource: async (encodedUserId: string, sourceIdentity: string) => ({
      committedAt: "2026-08-28T12:00:01.000Z",
      sourceIdentity,
      userId: encodedUserId,
    }),
    pendingReminderWakeUpSources: async (encodedUserId: string) => [
      {
        committedAt: "2026-08-28T12:00:01.000Z",
        sourceIdentity: source.identity,
        userId: encodedUserId,
      },
    ],
  };

  return Effect.gen(function* () {
    const authority = yield* WhatsAppWakeUps.SourceAuthority;
    const inspected = yield* authority.inspect(userId, source);
    const pending = yield* authority.pendingForUser(userId);
    yield* authority.exposePending(userId, pending);

    expect(inspected).toEqual({
      committedAt: new Date("2026-08-28T12:00:01.000Z"),
      source,
    });
    expect(pending).toEqual([inspected]);
    expect(exposed).toEqual([
      {
        committed: [
          {
            committedAt: "2026-08-28T12:00:01.000Z",
            sourceIdentity: source.identity,
          },
        ],
        userId,
      },
    ]);
  }).pipe(Effect.provide(reminderSourceAuthorityLayer(directory)));
});

it.effect("ignores non-Reminder sources without crossing the Directory boundary", () => {
  const inspected: Array<unknown> = [];
  const directory = {
    exposeReminderWakeUpSources: async () => undefined,
    inspectReminderWakeUpSource: async (...input: ReadonlyArray<unknown>) => {
      inspected.push(input);
      return null;
    },
    pendingReminderWakeUpSources: async () => [],
  };
  const nonReminder = WhatsAppWakeUps.Source.cases.ScheduledEmail.make({
    identity: WhatsAppWakeUps.SourceIdentity.make("email-draft:one"),
  });

  return Effect.gen(function* () {
    const authority = yield* WhatsAppWakeUps.SourceAuthority;
    expect(yield* authority.inspect(userId, nonReminder)).toBeNull();
    yield* authority.exposePending(userId, [
      { committedAt: new Date("2026-08-28T12:00:01.000Z"), source: nonReminder },
    ]);
    expect(inspected).toEqual([]);
  }).pipe(Effect.provide(reminderSourceAuthorityLayer(directory)));
});

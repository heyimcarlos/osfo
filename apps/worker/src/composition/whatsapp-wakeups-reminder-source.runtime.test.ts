import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../domain";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";
import { combinedSourceAuthority, reminderSourceAuthorityLayer } from "./whatsapp-wakeups";

/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside @effect/vitest Effect test callbacks. */
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/strict-effect-provide -- This runtime test owns Promise RPC fakes, fixed instants, and its complete test Layer. */

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

it.effect("routes Reminder and Research Report sources to their distinct owners", () => {
  const calls: Array<string> = [];
  const committedAt = new Date("2026-08-28T12:00:01.000Z");
  const report = WhatsAppWakeUps.Source.cases.ResearchReport.make({
    identity: WhatsAppWakeUps.SourceIdentity.make("report-notification"),
  });
  const owner = (kind: "reminder" | "report"): WhatsAppWakeUps.SourceAuthorityInterface => ({
    exposePending: () => Effect.sync(() => calls.push(`${kind}.expose`)),
    inspect: (_ownerUserId, ownedSource) =>
      Effect.sync(() => {
        calls.push(`${kind}.inspect`);
        return { committedAt, source: ownedSource };
      }),
    pendingForUser: () =>
      Effect.sync(() => {
        calls.push(`${kind}.pending`);
        return kind === "reminder" ? [{ committedAt, source }] : [{ committedAt, source: report }];
      }),
  });
  const combined = combinedSourceAuthority(owner("reminder"), owner("report"));

  return Effect.gen(function* () {
    expect(yield* combined.inspect(userId, source)).toEqual({ committedAt, source });
    expect(yield* combined.inspect(userId, report)).toEqual({ committedAt, source: report });
    expect(yield* combined.pendingForUser(userId)).toEqual([
      { committedAt, source },
      { committedAt, source: report },
    ]);
    yield* combined.exposePending(userId, [
      { committedAt, source },
      { committedAt, source: report },
    ]);
    expect(calls).toEqual([
      "reminder.inspect",
      "report.inspect",
      "reminder.pending",
      "report.pending",
      "reminder.expose",
      "report.expose",
    ]);
  });
});

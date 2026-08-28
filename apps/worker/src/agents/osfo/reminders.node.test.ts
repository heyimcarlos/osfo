/* oxlint-disable osfo/no-runtime-typeof -- The test adapter normalizes node:sqlite's closed value union. */
/* oxlint-disable typescript/no-unnecessary-type-parameters -- SqlStorageCursor requires its generic method shape. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The node:sqlite adapter proves its closed value conversions beside each cast. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside @effect/vitest Effect test callbacks. */
/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed native Date fixtures prove exact scheduler instants. */

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";

import {
  AllowancePeriodId,
  ChannelLinkId,
  PlanPolicyVersion,
  ThinkSubmissionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { deleteAgentOwnedUserData } from "./agent-owned-data-deletion";
import {
  type ReminderDeliveryPorts,
  makeReminderAuthority,
  ReminderCallbackCapability,
  ReminderId,
  ReminderUnavailable,
  type ReminderSchedule,
  type ReminderSchedulePort,
} from "./reminders";
import { reminderSchedulerDate, reminderSchedulerEpochSecond } from "./reminder-scheduler-time";

interface ReminderAuthorityStorage {
  readonly sql: Pick<SqlStorage, "exec">;
  readonly transactionSync: <A>(transaction: () => A) => A;
}

it.effect(
  "creates one approved one-time Reminder exactly once and enforces the active limit atomically",
  () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const scheduled: Array<{ readonly at: Date; readonly payload: unknown }> = [];
        const scheduler: ReminderSchedulePort = {
          arm: (at, payload) =>
            Effect.sync(() => {
              scheduled.push({ at, payload });
              return `schedule-${scheduled.length}`;
            }),
          cancel: () => Effect.void,
          list: () =>
            Effect.sync(() =>
              scheduled.map(({ at, payload }, index) => ({
                callback: "deliverReminder",
                id: `schedule-${index + 1}`,
                payload,
                timeEpochSeconds: Math.ceil(at.getTime() / 1_000),
                type: "scheduled" as const,
              })),
            ),
        };
        const reminders = makeReminderAuthority({
          delivery: unusedDeliveryPorts,
          makeCallbackCapability: deterministicCallbackCapabilities(),
          now: Effect.succeed(new Date("2026-08-28T12:00:00.000Z")),
          scheduler,
          storage,
        });
        const input = {
          actionId: ActionId.make("action-create-one-time"),
          activeLimit: 1,
          body: "Bring the signed lease to the appointment.",
          firstDueAt: new Date("2026-08-29T12:00:00.000Z"),
          originalPeriodId: AllowancePeriodId.make("period-launch"),
          ownerUserId: UserId.make("user-1"),
          plan: "free" as const,
          policyVersion: PlanPolicyVersion.make("launch-v1"),
          reminderId: ReminderId.make("reminder-action-create-one-time"),
        };

        expect(yield* reminders.createOneTime(input)).toMatchObject({
          _tag: "Created",
          reminderId: input.reminderId,
          revision: 1,
          state: "active",
        });
        expect(scheduled).toEqual([
          {
            at: input.firstDueAt,
            payload: {
              callbackCapability: testCallbackCapability(1),
              nominalDueAt: input.firstDueAt.toISOString(),
              reminderId: input.reminderId,
              revision: 1,
            },
          },
        ]);

        expect(yield* reminders.createOneTime(input)).toMatchObject({
          _tag: "Replayed",
          reminderId: input.reminderId,
          revision: 1,
        });
        expect(scheduled).toHaveLength(1);

        const changedReplay = yield* Effect.exit(
          reminders.createOneTime({ ...input, body: "A changed private body." }),
        );
        expect(Exit.isFailure(changedReplay)).toBe(true);

        const overLimit = yield* Effect.exit(
          reminders.createOneTime({
            ...input,
            actionId: ActionId.make("action-create-over-limit"),
            reminderId: ReminderId.make("reminder-action-create-over-limit"),
          }),
        );
        expect(Exit.isFailure(overLimit)).toBe(true);

        expect(yield* reminders.inspect(input.ownerUserId, input.reminderId)).toMatchObject({
          body: input.body,
          firstDueAt: input.firstDueAt,
          nextDueAt: input.firstDueAt,
          reminderId: input.reminderId,
          revision: 1,
          scheduleKind: "oneTime",
          schedulerId: "schedule-1",
          state: "active",
        });
      }),
    ),
);

it.effect("repairs create, change, and reactivate schedules before returning Action replay", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const rows = new Map<string, ReminderSchedule>();
      const failNextArm = yield* Ref.make(true);
      let sequence = 0;
      const scheduler: ReminderSchedulePort = {
        arm: (at, payload) =>
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(failNextArm, false)) {
              return yield* new ReminderUnavailable({
                cause: new Error("injected scheduler failure"),
                operation: "scheduler.arm",
              });
            }
            const id = `repair-${++sequence}`;
            rows.set(id, {
              callback: "deliverReminder",
              id,
              payload,
              timeEpochSeconds: Math.ceil(at.getTime() / 1_000),
              type: "scheduled",
            });
            return id;
          }),
        cancel: (id) => Effect.sync(() => void rows.delete(id)),
        list: () => Effect.sync(() => [...rows.values()]),
      };
      const reminders = makeReminderAuthority({
        delivery: unusedDeliveryPorts,
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Effect.succeed(new Date("2026-08-28T12:00:00.000Z")),
        scheduler,
        storage,
      });
      const ownerUserId = UserId.make("user-replay-repair");
      const reminderId = ReminderId.make("reminder-replay-repair");
      const create = {
        actionId: ActionId.make("action-replay-create"),
        activeLimit: 1,
        body: "Repair this exact approved Reminder.",
        firstDueAt: new Date("2026-08-29T12:00:00.000Z"),
        originalPeriodId: AllowancePeriodId.make("period-replay-repair"),
        ownerUserId,
        plan: "free" as const,
        policyVersion: PlanPolicyVersion.make("launch-v1"),
        reminderId,
      };

      expect(Exit.isFailure(yield* Effect.exit(reminders.createOneTime(create)))).toBe(true);
      expect(yield* reminders.inspect(ownerUserId, reminderId)).toMatchObject({
        schedulerId: null,
        state: "active",
      });
      expect(yield* reminders.createOneTime(create)).toMatchObject({ _tag: "Replayed" });
      expect(rows.size).toBe(1);

      const change = {
        actionId: ActionId.make("action-replay-change"),
        body: "Repair this approved material change.",
        expectedRevision: 1,
        firstDueAt: new Date("2026-08-30T12:00:00.000Z"),
        intervalMilliseconds: null,
        ownerUserId,
        reminderId,
        scheduleKind: "oneTime" as const,
      };
      yield* Ref.set(failNextArm, true);
      expect(Exit.isFailure(yield* Effect.exit(reminders.change(change)))).toBe(true);
      expect(yield* reminders.change(change)).toMatchObject({ _tag: "Replayed", revision: 2 });
      expect(rows.size).toBe(1);

      yield* reminders.reconcileActiveLimit({ activeLimit: 0, ownerUserId });
      const reactivate = {
        ...change,
        actionId: ActionId.make("action-replay-reactivate"),
        activeLimit: 1,
        expectedRevision: 2,
        firstDueAt: new Date("2026-08-31T12:00:00.000Z"),
      };
      yield* Ref.set(failNextArm, true);
      expect(Exit.isFailure(yield* Effect.exit(reminders.reactivate(reactivate)))).toBe(true);
      expect(yield* reminders.reactivate(reactivate)).toMatchObject({
        _tag: "Replayed",
        revision: 3,
      });
      expect(rows.size).toBe(1);
    }),
  ),
);

it.effect("accepts only fixed recurring intervals of at least 24 hours", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const scheduled: Array<{ readonly at: Date; readonly payload: unknown }> = [];
      const reminders = makeReminderAuthority({
        delivery: unusedDeliveryPorts,
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Effect.succeed(new Date("2026-08-28T12:00:00.000Z")),
        scheduler: {
          arm: (at, payload) =>
            Effect.sync(() => {
              scheduled.push({ at, payload });
              return `schedule-${scheduled.length}`;
            }),
          cancel: () => Effect.void,
          list: () => Effect.succeed([]),
        },
        storage,
      });
      const input = {
        actionId: ActionId.make("action-create-recurring"),
        activeLimit: 5,
        body: "Review the household budget.",
        firstDueAt: new Date("2026-08-29T12:00:00.000Z"),
        intervalMilliseconds: 86_400_000,
        originalPeriodId: AllowancePeriodId.make("period-launch"),
        ownerUserId: UserId.make("user-1"),
        plan: "free" as const,
        policyVersion: PlanPolicyVersion.make("launch-v1"),
        reminderId: ReminderId.make("reminder-action-create-recurring"),
      };

      expect(yield* reminders.createRecurring(input)).toMatchObject({
        _tag: "Created",
        revision: 1,
      });
      expect(yield* reminders.inspect(input.ownerUserId, input.reminderId)).toMatchObject({
        intervalMilliseconds: 86_400_000,
        scheduleKind: "recurring",
      });

      const tooFrequent = yield* Effect.exit(
        reminders.createRecurring({
          ...input,
          actionId: ActionId.make("action-too-frequent"),
          intervalMilliseconds: 86_399_999,
          reminderId: ReminderId.make("reminder-too-frequent"),
        }),
      );
      expect(Exit.isFailure(tooFrequent)).toBe(true);
      expect(scheduled).toHaveLength(1);
    }),
  ),
);

it.effect("revises exact approved facts, pauses by creation order, reactivates, and cancels", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const armed: Array<string> = [];
      const canceled: Array<string> = [];
      const reminders = makeReminderAuthority({
        delivery: unusedDeliveryPorts,
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Effect.succeed(new Date("2026-08-28T12:00:00.000Z")),
        scheduler: {
          arm: (_at, payload) =>
            Effect.sync(() => {
              const id = `schedule-${payload.reminderId}-${payload.revision}`;
              armed.push(id);
              return id;
            }),
          cancel: (schedulerId) => Effect.sync(() => void canceled.push(schedulerId)),
          list: () => Effect.succeed([]),
        },
        storage,
      });
      const base = {
        activeLimit: 3,
        body: "Review the household budget.",
        firstDueAt: new Date("2026-08-29T12:00:00.000Z"),
        originalPeriodId: AllowancePeriodId.make("period-launch"),
        ownerUserId: UserId.make("user-1"),
        plan: "free" as const,
        policyVersion: PlanPolicyVersion.make("launch-v1"),
      };
      const firstId = ReminderId.make("reminder-a");
      yield* reminders.createRecurring({
        ...base,
        actionId: ActionId.make("action-create-a"),
        intervalMilliseconds: 86_400_000,
        reminderId: firstId,
      });
      yield* reminders.createOneTime({
        ...base,
        actionId: ActionId.make("action-create-b"),
        reminderId: ReminderId.make("reminder-b"),
      });
      yield* reminders.createOneTime({
        ...base,
        actionId: ActionId.make("action-create-c"),
        reminderId: ReminderId.make("reminder-c"),
      });

      const change = {
        actionId: ActionId.make("action-change-a"),
        body: "Review the household budget and savings plan.",
        expectedRevision: 1,
        firstDueAt: new Date("2026-08-30T12:00:00.000Z"),
        intervalMilliseconds: 172_800_000,
        ownerUserId: base.ownerUserId,
        reminderId: firstId,
        scheduleKind: "recurring" as const,
      };
      expect(yield* reminders.change(change)).toMatchObject({ _tag: "Changed", revision: 2 });
      expect(yield* reminders.change(change)).toMatchObject({ _tag: "Replayed", revision: 2 });
      expect(yield* reminders.inspect(base.ownerUserId, firstId)).toMatchObject({
        body: change.body,
        firstDueAt: change.firstDueAt,
        intervalMilliseconds: change.intervalMilliseconds,
        revision: 2,
        schedulerId: "schedule-reminder-a-2",
      });
      expect(canceled).toContain("schedule-reminder-a-1");

      const paused = yield* reminders.reconcileActiveLimit({
        activeLimit: 1,
        ownerUserId: base.ownerUserId,
      });
      expect(paused.map(({ reminderId }) => reminderId)).toEqual(["reminder-b", "reminder-c"]);
      expect(yield* reminders.inspect(base.ownerUserId, firstId)).toMatchObject({
        state: "active",
      });
      expect(
        yield* reminders.inspect(base.ownerUserId, ReminderId.make("reminder-b")),
      ).toMatchObject({ state: "paused" });

      expect(
        yield* reminders.reactivate({
          actionId: ActionId.make("action-reactivate-b"),
          activeLimit: 3,
          body: "Review the household budget.",
          expectedRevision: 1,
          firstDueAt: new Date("2026-08-31T12:00:00.000Z"),
          intervalMilliseconds: null,
          ownerUserId: base.ownerUserId,
          reminderId: ReminderId.make("reminder-b"),
          scheduleKind: "oneTime",
        }),
      ).toMatchObject({ _tag: "Reactivated", revision: 2 });

      expect(
        yield* reminders.cancel({
          expectedRevision: 2,
          ownerUserId: base.ownerUserId,
          reminderId: firstId,
        }),
      ).toMatchObject({ _tag: "Canceled", revision: 3 });
      expect(yield* reminders.inspect(base.ownerUserId, firstId)).toMatchObject({
        revision: 3,
        schedulerId: null,
        state: "canceled",
      });
      expect(armed).toContain("schedule-reminder-b-2");
      expect(canceled).toContain("schedule-reminder-a-2");
    }),
  ),
);

it.effect("commits one recurring occurrence before accounting and one prompt Wake-up", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const accounting: Array<string> = [];
      const wakeUps: Array<string> = [];
      const prompts: Array<string> = [];
      const scheduled: Array<{ readonly at: Date; readonly payload: unknown }> = [];
      const delivery: ReminderDeliveryPorts = {
        authorize: () =>
          Effect.succeed({
            _tag: "Authorized" as const,
            channelLinkId: ChannelLinkId.make("whatsapp-link-1"),
          }),
        cancelSource: () => Effect.void,
        promptWakeUp: (sourceIdentity) => Effect.sync(() => void prompts.push(sourceIdentity)),
        recordLaunchDelivery: ({ sourceIdentity }) =>
          Effect.sync(() => void accounting.push(sourceIdentity)),
        requestWakeUp: ({ sourceIdentity }) => Effect.sync(() => void wakeUps.push(sourceIdentity)),
      };
      const clock = yield* Ref.make(new Date("2026-08-29T11:59:59.000Z"));
      const reminders = makeReminderAuthority({
        delivery,
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Ref.get(clock),
        scheduler: {
          arm: (at, payload) =>
            Effect.sync(() => {
              scheduled.push({ at, payload });
              return `schedule-${scheduled.length}`;
            }),
          cancel: () => Effect.void,
          list: () => Effect.succeed([]),
        },
        storage,
      });
      const reminderId = ReminderId.make("reminder-recurring-due");
      const ownerUserId = UserId.make("user-due");
      const nominalDueAt = new Date("2026-08-29T12:00:00.000Z");
      yield* reminders.createRecurring({
        actionId: ActionId.make("action-recurring-due"),
        activeLimit: 5,
        body: "Send the landlord the water-meter reading.",
        firstDueAt: nominalDueAt,
        intervalMilliseconds: 86_400_000,
        originalPeriodId: AllowancePeriodId.make("period-launch"),
        ownerUserId,
        plan: "free",
        policyVersion: PlanPolicyVersion.make("launch-v1"),
        reminderId,
      });
      yield* Ref.set(clock, new Date("2026-08-29T12:00:01.000Z"));

      expect(
        yield* reminders.deliver({
          nominalDueAt: nominalDueAt.toISOString(),
          reminderId,
          revision: 1,
        }),
      ).toMatchObject({ _tag: "Noop", reason: "unauthorizedCallback" });
      expect(accounting).toEqual([]);
      expect(wakeUps).toEqual([]);
      expect(prompts).toEqual([]);

      const payload = {
        callbackCapability: testCallbackCapability(1),
        nominalDueAt: nominalDueAt.toISOString(),
        reminderId,
        revision: 1,
      };
      const delivered = yield* reminders.deliver(payload);
      expect(delivered).toMatchObject({
        _tag: "Committed",
        nextDueAt: new Date("2026-08-30T12:00:00.000Z"),
      });
      expect(yield* reminders.deliver(payload)).toMatchObject({ _tag: "Replayed" });
      expect(accounting).toHaveLength(1);
      expect(wakeUps).toHaveLength(1);
      expect(prompts).toHaveLength(1);
      expect(scheduled.at(-1)).toEqual({
        at: new Date("2026-08-30T12:00:00.000Z"),
        payload: {
          callbackCapability: testCallbackCapability(2),
          nominalDueAt: "2026-08-30T12:00:00.000Z",
          reminderId,
          revision: 1,
        },
      });

      const pending = yield* reminders.pendingSources(ownerUserId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.committedAt).toEqual(new Date("2026-08-29T12:00:01.000Z"));
      yield* reminders.exposeSources(ownerUserId, pending);
      expect(yield* reminders.pendingSources(ownerUserId)).toEqual([]);
      const submissionId = ThinkSubmissionId.make("reminder-think-one");
      const exposures = [
        {
          body: "Send the landlord the water-meter reading.",
          committedAt: new Date("2026-08-29T12:00:01.000Z"),
          sourceIdentity: pending[0]?.sourceIdentity,
        },
      ];
      expect(yield* reminders.claimThinkExposures(ownerUserId, submissionId)).toEqual(exposures);
      expect(yield* reminders.claimThinkExposures(ownerUserId, submissionId)).toEqual(exposures);
      expect(
        yield* reminders.claimThinkExposures(
          ownerUserId,
          ThinkSubmissionId.make("reminder-think-two"),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("reauthorizes partial committed delivery and revokes a denied crash replay", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const authorization = yield* Ref.make<"Authorized" | "Blocked">("Authorized");
      const clock = yield* Ref.make(new Date("2026-08-29T11:59:59.000Z"));
      const accounting: Array<string> = [];
      const requests: Array<string> = [];
      const prompts: Array<string> = [];
      const failedSources = new Set<string>();
      const reminders = makeReminderAuthority({
        delivery: {
          authorize: () =>
            Ref.get(authorization).pipe(
              Effect.map((decision) =>
                decision === "Authorized"
                  ? {
                      _tag: "Authorized" as const,
                      channelLinkId: ChannelLinkId.make("whatsapp-link-1"),
                    }
                  : { _tag: "Blocked" as const, reason: "subscriptionSuspended" },
              ),
            ),
          cancelSource: () => Effect.void,
          promptWakeUp: (sourceIdentity) => Effect.sync(() => void prompts.push(sourceIdentity)),
          recordLaunchDelivery: ({ sourceIdentity }) =>
            Effect.sync(() => void accounting.push(sourceIdentity)),
          requestWakeUp: ({ sourceIdentity }) =>
            Effect.gen(function* () {
              requests.push(sourceIdentity);
              if (!failedSources.has(sourceIdentity)) {
                failedSources.add(sourceIdentity);
                return yield* new ReminderUnavailable({
                  cause: new Error("injected Wake-up failure"),
                  operation: "deliver.wakeUp",
                });
              }
              return undefined;
            }),
        },
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Ref.get(clock),
        scheduler: {
          arm: (_at, payload) => Effect.succeed(`schedule-${payload.reminderId}`),
          cancel: () => Effect.void,
          list: () => Effect.succeed([]),
        },
        storage,
      });
      const due = new Date("2026-08-29T12:00:00.000Z");
      const ownerUserId = UserId.make("user-partial-replay");
      const base = {
        activeLimit: 2,
        body: "Resume this occurrence only with current authority.",
        firstDueAt: due,
        originalPeriodId: AllowancePeriodId.make("period-partial-replay"),
        ownerUserId,
        plan: "free" as const,
        policyVersion: PlanPolicyVersion.make("launch-v1"),
      };
      const resumableId = ReminderId.make("reminder-partial-resumable");
      const deniedId = ReminderId.make("reminder-partial-denied");
      yield* reminders.createOneTime({
        ...base,
        actionId: ActionId.make("action-partial-resumable"),
        reminderId: resumableId,
      });
      yield* reminders.createOneTime({
        ...base,
        actionId: ActionId.make("action-partial-denied"),
        reminderId: deniedId,
      });
      yield* Ref.set(clock, new Date("2026-08-29T12:00:01.000Z"));
      const resumablePayload = {
        callbackCapability: testCallbackCapability(1),
        nominalDueAt: due.toISOString(),
        reminderId: resumableId,
        revision: 1,
      };
      expect(Exit.isFailure(yield* Effect.exit(reminders.deliver(resumablePayload)))).toBe(true);
      expect(yield* reminders.deliver(resumablePayload)).toMatchObject({ _tag: "Replayed" });
      expect(accounting).toHaveLength(1);
      expect(requests).toHaveLength(2);
      expect(prompts).toHaveLength(1);

      const deniedPayload = {
        callbackCapability: testCallbackCapability(2),
        nominalDueAt: due.toISOString(),
        reminderId: deniedId,
        revision: 1,
      };
      expect(Exit.isFailure(yield* Effect.exit(reminders.deliver(deniedPayload)))).toBe(true);
      yield* Ref.set(authorization, "Blocked");
      expect(yield* reminders.deliver(deniedPayload)).toMatchObject({
        _tag: "Noop",
        reason: "authorityRevoked",
      });
      yield* Ref.set(authorization, "Authorized");
      expect(yield* reminders.deliver(deniedPayload)).toMatchObject({
        _tag: "Noop",
        reason: "unauthorizedCallback",
      });
      expect(accounting).toHaveLength(2);
      expect(requests).toHaveLength(3);
      expect(prompts).toHaveLength(1);
    }),
  ),
);

it.effect(
  "retains blocked evidence, skips shared accounting, and completes one-time delivery",
  () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const accounting: Array<string> = [];
        const authorization = yield* Ref.make<"Authorized" | "Blocked">("Blocked");
        const now = new Date("2026-09-01T12:00:01.000Z");
        const clock = yield* Ref.make(new Date("2026-09-01T11:59:59.000Z"));
        const delivery: ReminderDeliveryPorts = {
          authorize: () =>
            Ref.get(authorization).pipe(
              Effect.map((decision) =>
                decision === "Authorized"
                  ? {
                      _tag: "Authorized" as const,
                      channelLinkId: ChannelLinkId.make("whatsapp-link-1"),
                    }
                  : { _tag: "Blocked" as const, reason: "subscriptionSuspended" },
              ),
            ),
          cancelSource: () => Effect.void,
          promptWakeUp: () => Effect.void,
          recordLaunchDelivery: ({ sourceIdentity }) =>
            Effect.sync(() => void accounting.push(sourceIdentity)),
          requestWakeUp: () => Effect.void,
        };
        const reminders = makeReminderAuthority({
          delivery,
          makeCallbackCapability: deterministicCallbackCapabilities(),
          now: Ref.get(clock),
          scheduler: {
            arm: (_at, payload) => Effect.succeed(`schedule-${payload.reminderId}`),
            cancel: () => Effect.void,
            list: () => Effect.succeed([]),
          },
          storage,
        });
        const ownerUserId = UserId.make("user-adversarial");
        const due = new Date("2026-09-01T12:00:00.000Z");
        const blockedId = ReminderId.make("reminder-blocked");
        yield* reminders.createOneTime({
          actionId: ActionId.make("action-blocked"),
          activeLimit: 5,
          body: "This must never be exposed.",
          firstDueAt: due,
          originalPeriodId: AllowancePeriodId.make("period-launch"),
          ownerUserId,
          plan: "free",
          policyVersion: PlanPolicyVersion.make("launch-v1"),
          reminderId: blockedId,
        });
        yield* Ref.set(clock, now);
        expect(
          yield* reminders.deliver({
            callbackCapability: testCallbackCapability(1),
            nominalDueAt: due.toISOString(),
            reminderId: blockedId,
            revision: 1,
          }),
        ).toMatchObject({ _tag: "Blocked" });
        expect(yield* reminders.pendingSources(ownerUserId)).toEqual([]);
        expect(yield* reminders.inspect(ownerUserId, blockedId)).toMatchObject({ state: "paused" });

        yield* Ref.set(authorization, "Authorized");
        yield* Ref.set(clock, new Date("2026-09-01T11:59:59.000Z"));
        const sharedId = ReminderId.make("reminder-shared");
        yield* reminders.createOneTime({
          actionId: ActionId.make("action-shared"),
          activeLimit: 5,
          body: "A shared-policy reminder.",
          firstDueAt: due,
          originalPeriodId: AllowancePeriodId.make("period-shared"),
          ownerUserId,
          plan: "adventurer",
          policyVersion: PlanPolicyVersion.make("shared-usage-v1"),
          reminderId: sharedId,
        });
        yield* Ref.set(clock, now);
        expect(
          yield* reminders.deliver({
            callbackCapability: testCallbackCapability(2),
            nominalDueAt: due.toISOString(),
            reminderId: sharedId,
            revision: 1,
          }),
        ).toMatchObject({ _tag: "Committed", nextDueAt: null });
        expect(yield* reminders.inspect(ownerUserId, sharedId)).toMatchObject({
          nextDueAt: null,
          state: "completed",
        });
        expect(accounting).toEqual([]);
        expect(
          yield* reminders.deliver({
            callbackCapability: testCallbackCapability(2),
            nominalDueAt: due.toISOString(),
            reminderId: sharedId,
            revision: 2,
          }),
        ).toMatchObject({ _tag: "Noop", reason: "stale" });
      }),
    ),
);

it.effect("rejects a changed source snapshot and permanently fences deleted Reminder state", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const canceledSchedules: Array<string> = [];
      const canceledSources: Array<string> = [];
      const deletedPersonalSkills: Array<UserId> = [];
      const clock = yield* Ref.make(new Date("2026-09-02T11:59:59.000Z"));
      const reminders = makeReminderAuthority({
        delivery: {
          authorize: () =>
            Effect.succeed({
              _tag: "Authorized" as const,
              channelLinkId: ChannelLinkId.make("whatsapp-link-1"),
            }),
          cancelSource: ({ sourceIdentity }) =>
            Effect.sync(() => void canceledSources.push(sourceIdentity)),
          promptWakeUp: () => Effect.void,
          recordLaunchDelivery: () => Effect.void,
          requestWakeUp: () => Effect.void,
        },
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Ref.get(clock),
        scheduler: {
          arm: (_at, payload) => Effect.succeed(`schedule-${payload.reminderId}`),
          cancel: (id) => Effect.sync(() => void canceledSchedules.push(id)),
          list: () => Effect.succeed([]),
        },
        storage,
      });
      const ownerUserId = UserId.make("user-delete");
      const reminderId = ReminderId.make("reminder-delete");
      const due = new Date("2026-09-02T12:00:00.000Z");
      yield* reminders.createRecurring({
        actionId: ActionId.make("action-delete"),
        activeLimit: 5,
        body: "Delete this private body.",
        firstDueAt: due,
        intervalMilliseconds: 86_400_000,
        originalPeriodId: AllowancePeriodId.make("period-delete"),
        ownerUserId,
        plan: "free",
        policyVersion: PlanPolicyVersion.make("launch-v1"),
        reminderId,
      });
      yield* Ref.set(clock, new Date("2026-09-02T12:00:01.000Z"));
      yield* reminders.deliver({
        callbackCapability: testCallbackCapability(1),
        nominalDueAt: due.toISOString(),
        reminderId,
        revision: 1,
      });
      const snapshot = yield* reminders.pendingSources(ownerUserId);
      const changedSnapshot = snapshot.map((source) => ({
        ...source,
        committedAt: new Date(source.committedAt.getTime() + 1),
      }));
      expect(
        Exit.isFailure(yield* Effect.exit(reminders.exposeSources(ownerUserId, changedSnapshot))),
      ).toBe(true);

      yield* deleteAgentOwnedUserData(
        reminders,
        {
          deleteUserData: (userId) => Effect.sync(() => void deletedPersonalSkills.push(userId)),
        },
        ownerUserId,
      );
      expect(yield* reminders.inspect(ownerUserId, reminderId)).toBeNull();
      expect(yield* reminders.pendingSources(ownerUserId)).toEqual([]);
      expect(
        yield* reminders.claimThinkExposures(
          ownerUserId,
          ThinkSubmissionId.make("deleted-reminder-think"),
        ),
      ).toEqual([]);
      expect(canceledSchedules).toContain(`schedule-${reminderId}`);
      expect(canceledSources).toEqual([snapshot[0]?.sourceIdentity]);
      expect(deletedPersonalSkills).toEqual([ownerUserId]);
      expect(
        yield* reminders.deliver({
          callbackCapability: testCallbackCapability(1),
          nominalDueAt: due.toISOString(),
          reminderId,
          revision: 1,
        }),
      ).toMatchObject({ _tag: "Noop", reason: "missing" });
    }),
  ),
);

it.effect(
  "exposes committed bodies once and fences revoked, superseded, and downgrade-paused sources",
  () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const canceledSources: Array<string> = [];
        const clock = yield* Ref.make(new Date("2026-09-05T11:59:59.000Z"));
        const authorization = yield* Ref.make<"Authorized" | "Canceled">("Authorized");
        const reminders = makeReminderAuthority({
          delivery: {
            authorize: () =>
              Ref.get(authorization).pipe(
                Effect.map((decision) =>
                  decision === "Authorized"
                    ? {
                        _tag: "Authorized" as const,
                        channelLinkId: ChannelLinkId.make("whatsapp-link-1"),
                      }
                    : { _tag: "Canceled" as const, reason: "channelRevoked" },
                ),
              ),
            cancelSource: ({ sourceIdentity }) =>
              Effect.sync(() => void canceledSources.push(sourceIdentity)),
            promptWakeUp: () => Effect.void,
            recordLaunchDelivery: () => Effect.void,
            requestWakeUp: () => Effect.void,
          },
          makeCallbackCapability: deterministicCallbackCapabilities(),
          now: Ref.get(clock),
          scheduler: {
            arm: (_at, payload) => Effect.succeed(`schedule-${payload.reminderId}`),
            cancel: () => Effect.void,
            list: () => Effect.succeed([]),
          },
          storage,
        });
        const ownerUserId = UserId.make("user-source-fences");
        const firstDueAt = new Date("2026-09-05T12:00:00.000Z");
        const firstId = ReminderId.make("reminder-source-first");
        const secondId = ReminderId.make("reminder-source-second");
        const thirdId = ReminderId.make("reminder-source-revoked");
        const base = {
          activeLimit: 3,
          firstDueAt,
          originalPeriodId: AllowancePeriodId.make("period-source-fences"),
          ownerUserId,
          plan: "free" as const,
          policyVersion: PlanPolicyVersion.make("launch-v1"),
        };
        yield* reminders.createRecurring({
          ...base,
          actionId: ActionId.make("action-source-first"),
          body: "First private body.",
          intervalMilliseconds: 86_400_000,
          reminderId: firstId,
        });
        yield* reminders.createRecurring({
          ...base,
          actionId: ActionId.make("action-source-second"),
          body: "Second private body.",
          intervalMilliseconds: 86_400_000,
          reminderId: secondId,
        });
        yield* Ref.set(clock, new Date("2026-09-05T12:00:01.000Z"));
        yield* reminders.deliver({
          callbackCapability: testCallbackCapability(1),
          nominalDueAt: firstDueAt.toISOString(),
          reminderId: firstId,
          revision: 1,
        });
        yield* reminders.deliver({
          callbackCapability: testCallbackCapability(2),
          nominalDueAt: firstDueAt.toISOString(),
          reminderId: secondId,
          revision: 1,
        });
        const pending = yield* reminders.pendingSources(ownerUserId);
        yield* reminders.exposeSources(ownerUserId, pending);

        yield* reminders.change({
          actionId: ActionId.make("action-source-first-change"),
          body: "First revised private body.",
          expectedRevision: 1,
          firstDueAt: new Date("2026-09-07T12:00:00.000Z"),
          intervalMilliseconds: 86_400_000,
          ownerUserId,
          reminderId: firstId,
          scheduleKind: "recurring",
        });
        yield* reminders.reconcileActiveLimit({ activeLimit: 0, ownerUserId });

        expect(
          yield* reminders.claimThinkExposures(
            ownerUserId,
            ThinkSubmissionId.make("fenced-source-think"),
          ),
        ).toEqual([]);
        expect(canceledSources).toEqual(
          expect.arrayContaining(pending.map(({ sourceIdentity }) => sourceIdentity)),
        );

        yield* Ref.set(authorization, "Canceled");
        yield* Ref.set(clock, new Date("2026-09-06T11:59:59.000Z"));
        yield* reminders.createOneTime({
          ...base,
          actionId: ActionId.make("action-source-revoked"),
          activeLimit: 1,
          body: "Revoked private body.",
          firstDueAt: new Date("2026-09-06T12:00:00.000Z"),
          reminderId: thirdId,
        });
        yield* Ref.set(clock, new Date("2026-09-06T12:00:01.000Z"));
        expect(
          yield* reminders.deliver({
            callbackCapability: testCallbackCapability(6),
            nominalDueAt: "2026-09-06T12:00:00.000Z",
            reminderId: thirdId,
            revision: 1,
          }),
        ).toMatchObject({ _tag: "Canceled" });
        expect(yield* reminders.pendingSources(ownerUserId)).toEqual([]);
      }),
    ),
);

it("normalizes fractional nominal due instants to the next Agents scheduler second", () => {
  const nominalDueAt = new Date("2026-09-04T12:00:00.123Z");

  expect(reminderSchedulerDate(nominalDueAt).toISOString()).toBe("2026-09-04T12:00:01.000Z");
  expect(reminderSchedulerEpochSecond(nominalDueAt)).toBe(1_788_523_201);
});

it.effect("repairs a missing one-time schedule and cancels stale Reminder callbacks", () =>
  withDatabase((storage) =>
    Effect.gen(function* () {
      const armed: Array<string> = [];
      const canceled: Array<string> = [];
      const listed = yield* Ref.make<ReadonlyArray<ReminderSchedule>>([]);
      const reminders = makeReminderAuthority({
        delivery: unusedDeliveryPorts,
        makeCallbackCapability: deterministicCallbackCapabilities(),
        now: Effect.succeed(new Date("2026-09-03T11:00:00.000Z")),
        scheduler: {
          arm: (_at, payload) =>
            Effect.sync(() => {
              const id = `replacement-${payload.revision}-${armed.length + 1}`;
              armed.push(id);
              return id;
            }),
          cancel: (id) => Effect.sync(() => void canceled.push(id)),
          list: () => Ref.get(listed),
        },
        storage,
      });
      const ownerUserId = UserId.make("user-reconcile");
      const reminderId = ReminderId.make("reminder-reconcile");
      const due = new Date("2026-09-04T12:00:00.000Z");
      yield* reminders.createOneTime({
        actionId: ActionId.make("action-reconcile"),
        activeLimit: 5,
        body: "Repair my schedule.",
        firstDueAt: due,
        originalPeriodId: AllowancePeriodId.make("period-reconcile"),
        ownerUserId,
        plan: "free",
        policyVersion: PlanPolicyVersion.make("launch-v1"),
        reminderId,
      });
      yield* Ref.set(listed, [
        {
          callback: "deliverReminder",
          id: "stale-revision",
          payload: {
            callbackCapability: testCallbackCapability(9),
            nominalDueAt: due.toISOString(),
            reminderId,
            revision: 9,
          },
          timeEpochSeconds: Math.ceil(due.getTime() / 1_000),
          type: "scheduled",
        },
        {
          callback: "anotherCallback",
          id: "unrelated",
          payload: {},
          timeEpochSeconds: Math.ceil(due.getTime() / 1_000),
          type: "scheduled",
        },
      ]);

      expect(yield* reminders.reconcileSchedules()).toEqual({ armed: 1, canceled: 1 });
      expect(canceled).toEqual(["stale-revision"]);
      expect(armed).toEqual(["replacement-1-1", "replacement-1-2"]);
      expect(yield* reminders.inspect(ownerUserId, reminderId)).toMatchObject({
        schedulerId: "replacement-1-2",
      });
      expect(
        storage.sql
          .exec<{ callbackCapability: string }>(
            `SELECT callback_capability AS callbackCapability
               FROM osfo_reminders WHERE reminder_id = ?`,
            reminderId,
          )
          .one().callbackCapability,
      ).toBe(testCallbackCapability(2));
      expect(
        yield* reminders.deliver({
          callbackCapability: testCallbackCapability(1),
          nominalDueAt: due.toISOString(),
          reminderId,
          revision: 1,
        }),
      ).toMatchObject({ _tag: "Noop", reason: "stale" });
    }),
  ),
);

const withDatabase = <A, E>(
  use: (storage: ReminderAuthorityStorage) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const database = new DatabaseSync(":memory:");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`CREATE TABLE osfo_reminders (
        reminder_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        creation_action_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('oneTime', 'recurring')),
        body TEXT NOT NULL,
        first_due_at TEXT NOT NULL,
        next_due_at TEXT,
        interval_milliseconds INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'canceled', 'completed')),
        callback_capability TEXT,
        scheduler_id TEXT,
        original_period_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        plan TEXT NOT NULL CHECK (plan IN ('free', 'adventurer')),
        updated_at TEXT NOT NULL
      ) STRICT`);
      database.exec(`CREATE TABLE osfo_reminder_actions (
        action_id TEXT PRIMARY KEY,
        reminder_id TEXT NOT NULL REFERENCES osfo_reminders(reminder_id) ON DELETE CASCADE,
        fingerprint_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0)
      ) STRICT`);
      database.exec(`CREATE TABLE osfo_reminder_occurrences (
        reminder_id TEXT NOT NULL REFERENCES osfo_reminders(reminder_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        nominal_due_at TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        channel_link_id TEXT,
        callback_capability TEXT NOT NULL,
        callback_capability_revoked_at TEXT,
        source_identity TEXT NOT NULL UNIQUE,
        source_revoked_at TEXT,
        body_snapshot TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('oneTime', 'recurring')),
        original_period_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        committed_at TEXT,
        exposed_at TEXT,
        blocked_at TEXT,
        canceled_at TEXT,
        accounting_recorded_at TEXT,
        wakeup_requested_at TEXT,
        wakeup_prompted_at TEXT,
        think_presented_at TEXT,
        think_submission_id TEXT,
        disposition_reason TEXT,
        PRIMARY KEY (reminder_id, revision, nominal_due_at)
      ) STRICT`);
      return { database, storage: nodeStorage(database) };
    }),
    ({ storage }) => use(storage),
    ({ database }) => Effect.sync(() => database.close()),
  );

const nodeStorage = (database: DatabaseSync): ReminderAuthorityStorage => ({
  sql: {
    exec: <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: Array<SqlStorageValue>
    ): SqlStorageCursor<T> => {
      const statement = database.prepare(query);
      const rows = statement.all(...bindings.map(toNodeBinding)).map(normalizeRow);
      // SAFETY: normalizeRow maps node:sqlite's closed row union to SqlStorageValue.
      return new NodeSqlCursor(
        rows as Array<T>,
        statement.columns().map(({ name }) => name),
      );
    },
  },
  transactionSync: <A>(transaction: () => A): A => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = transaction();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  },
});

class NodeSqlCursor<T extends Record<string, SqlStorageValue>> implements SqlStorageCursor<T> {
  readonly columnNames: Array<string>;
  readonly rowsRead: number;
  readonly rowsWritten = 0;
  readonly #rows: Array<T>;

  constructor(rows: Array<T>, columnNames: Array<string>) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rows.length;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#rows.values();
  }

  next(): { done?: false; value: T } | { done: true; value?: never } {
    const result = this.#rows.values().next();
    return result.done ? { done: true } : { done: false, value: result.value };
  }

  one(): T {
    const [only, ...remaining] = this.#rows;
    if (only === undefined || remaining.length > 0) throw new Error("Expected exactly one row");
    return only;
  }

  raw<U extends Array<SqlStorageValue>>(): IterableIterator<U> {
    // SAFETY: tuples follow columnNames and contain only normalized SqlStorageValue values.
    return this.#rows.map((row) => this.columnNames.map((name) => row[name]) as U).values();
  }

  toArray(): Array<T> {
    return [...this.#rows];
  }
}

const normalizeRow = (row: Record<string, SQLOutputValue>): Record<string, SqlStorageValue> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? value.slice().buffer
        : typeof value === "bigint"
          ? Number(value)
          : value,
    ]),
  );

const toNodeBinding = (value: SqlStorageValue): SQLInputValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const testCallbackCapability = (sequence: number) =>
  ReminderCallbackCapability.make(sequence.toString(16).padStart(64, "0"));

const deterministicCallbackCapabilities = () => {
  let sequence = 0;
  return () => Effect.sync(() => testCallbackCapability(++sequence));
};

const unusedDeliveryPorts: ReminderDeliveryPorts = {
  authorize: () => Effect.die(new Error("Unexpected Reminder delivery authorization")),
  cancelSource: () => Effect.void,
  promptWakeUp: () => Effect.die(new Error("Unexpected Reminder Wake-up prompt")),
  recordLaunchDelivery: () => Effect.die(new Error("Unexpected Reminder accounting")),
  requestWakeUp: () => Effect.die(new Error("Unexpected Reminder Wake-up request")),
};

import { Effect, Option, Schema } from "effect";

import {
  AllowancePeriodId,
  type ChannelLinkId,
  type Plan,
  PlanPolicyVersion,
  type ThinkSubmissionId,
  type UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import {
  makeReminderStorage,
  type OccurrenceRow,
  type RawReminderStorage,
  type ReminderRow,
  type ReminderStorageUnavailable,
} from "./reminder-storage";
import { reminderSchedulerEpochSecond } from "./reminder-scheduler-time";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and Reminder outcomes use the canonical _tag discriminator. */
/* oxlint-disable osfo/no-unknown-parameters -- The scheduler payload is decoded immediately at this owned trust boundary. */
/* oxlint-disable effecttsgo/global-date-in-effect -- Agent scheduling and SQLite persistence use native absolute Date values. */
/* oxlint-disable effecttsgo/lazy-effect -- Scheduler listing must be deferred until reconciliation reads the external Agent store. */

type ActionIdType = ActionId;
type AllowancePeriodIdType = AllowancePeriodId;
type ChannelLinkIdType = ChannelLinkId;
type PlanPolicyVersionType = PlanPolicyVersion;
type PlanType = Plan;
type UserIdType = UserId;

/** Stable identity of one User-owned Reminder. */
export const ReminderId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand("ReminderId"),
);

/** Stable identity of one User-owned Reminder. */
export type ReminderId = typeof ReminderId.Type;

/** Opaque one-occurrence capability retained only to authenticate a scheduler callback. */
export const ReminderCallbackCapability = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
).pipe(Schema.brand("ReminderCallbackCapability"));

export type ReminderCallbackCapability = typeof ReminderCallbackCapability.Type;

/** Privacy-safe payload retained by the Agents scheduler. */
export const ReminderSchedulePayload = Schema.Struct({
  callbackCapability: ReminderCallbackCapability,
  nominalDueAt: Schema.DateFromString,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** Privacy-safe payload retained by the Agents scheduler. */
export type ReminderSchedulePayload = typeof ReminderSchedulePayload.Encoded;

const ReminderScheduleEnvelope = Schema.Struct({
  callbackCapability: Schema.optionalKey(Schema.String),
  nominalDueAt: Schema.DateFromString,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** Scheduler row visible to Reminder activation reconciliation. */
export interface ReminderSchedule {
  readonly callback: string;
  readonly id: string;
  readonly payload: unknown;
  readonly timeEpochSeconds: number;
  readonly type: "scheduled";
}

/** Narrow adapter over the installed Agents one-time scheduler. */
export interface ReminderSchedulePort {
  readonly arm: (
    at: Date,
    payload: ReminderSchedulePayload,
  ) => Effect.Effect<string, ReminderUnavailable>;
  readonly cancel: (schedulerId: string) => Effect.Effect<void, ReminderUnavailable>;
  readonly list: () => Effect.Effect<ReadonlyArray<ReminderSchedule>, ReminderUnavailable>;
}

/** Product boundaries invoked only after an occurrence is durably committed. */
export interface ReminderDeliveryPorts {
  readonly authorize: (input: {
    readonly nominalDueAt: Date;
    readonly ownerUserId: UserIdType;
    readonly reminderId: ReminderId;
    readonly revision: number;
    readonly scheduleKind: "oneTime" | "recurring";
  }) => Effect.Effect<
    | { readonly _tag: "Authorized"; readonly channelLinkId: ChannelLinkIdType }
    | { readonly _tag: "Blocked" | "Canceled"; readonly reason: string },
    ReminderUnavailable
  >;
  readonly cancelSource: (input: {
    readonly ownerUserId: UserIdType;
    readonly sourceIdentity: string;
  }) => Effect.Effect<void, ReminderUnavailable>;
  readonly promptWakeUp: (sourceIdentity: string) => Effect.Effect<void, ReminderUnavailable>;
  readonly recordLaunchDelivery: (input: {
    readonly originalPeriodId: AllowancePeriodIdType;
    readonly ownerUserId: UserIdType;
    readonly sourceIdentity: string;
  }) => Effect.Effect<void, ReminderUnavailable>;
  readonly requestWakeUp: (input: {
    readonly channelLinkId: ChannelLinkIdType;
    readonly ownerUserId: UserIdType;
    readonly sourceIdentity: string;
  }) => Effect.Effect<void, ReminderUnavailable>;
}

export interface ReminderCommittedSource {
  readonly committedAt: Date;
  readonly sourceIdentity: string;
}

export interface ReminderThinkExposure extends ReminderCommittedSource {
  readonly body: string;
}

/** Minimal Durable Object SQLite interface used by Reminder authority. */
/** Expected persistence, scheduler, or authority-boundary failure. */
export class ReminderUnavailable extends Schema.TaggedError<ReminderUnavailable>()(
  "ReminderUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

/** Exact Action identity was already bound to different Reminder facts. */
export class ReminderConflict extends Schema.TaggedError<ReminderConflict>()("ReminderConflict", {
  actionId: Schema.String,
  reminderId: ReminderId,
}) {}

/** The current Plan's active Reminder bound was reached under the serialized owner write. */
export class ReminderLimitReached extends Schema.TaggedError<ReminderLimitReached>()(
  "ReminderLimitReached",
  { activeLimit: Schema.Int, ownerUserId: Schema.String },
) {}

/** The proposed Reminder facts are outside the bounded v1 contract. */
export class ReminderInputInvalid extends Schema.TaggedError<ReminderInputInvalid>()(
  "ReminderInputInvalid",
  { message: Schema.String },
) {}

export interface CreateOneTimeInput {
  readonly actionId: ActionIdType;
  readonly activeLimit: number;
  readonly body: string;
  readonly firstDueAt: Date;
  readonly originalPeriodId: AllowancePeriodIdType;
  readonly ownerUserId: UserIdType;
  readonly plan: PlanType;
  readonly policyVersion: PlanPolicyVersionType;
  readonly reminderId: ReminderId;
}

export interface CreateRecurringInput extends CreateOneTimeInput {
  readonly intervalMilliseconds: number;
}

interface CreateInput extends CreateOneTimeInput {
  readonly intervalMilliseconds: number | null;
  readonly scheduleKind: "oneTime" | "recurring";
}

export type ReminderMutationResult = {
  readonly _tag: "Changed" | "Created" | "Reactivated" | "Replayed";
  readonly reminderId: ReminderId;
  readonly revision: number;
  readonly state: "active";
};

export interface MaterialChangeInput {
  readonly actionId: ActionIdType;
  readonly body: string;
  readonly expectedRevision: number;
  readonly firstDueAt: Date;
  readonly intervalMilliseconds: number | null;
  readonly ownerUserId: UserIdType;
  readonly reminderId: ReminderId;
  readonly scheduleKind: "oneTime" | "recurring";
}

export interface ReactivateInput extends MaterialChangeInput {
  readonly activeLimit: number;
}

export interface CancelInput {
  readonly expectedRevision: number;
  readonly ownerUserId: UserIdType;
  readonly reminderId: ReminderId;
}

export interface ReconcileActiveLimitInput {
  readonly activeLimit: number;
  readonly ownerUserId: UserIdType;
}

/** Complete private Reminder record exposed only inside its owning Agent. */
export interface ReminderRecord {
  readonly body: string;
  readonly creationActionId: ActionIdType;
  readonly createdAt: Date;
  readonly firstDueAt: Date;
  readonly intervalMilliseconds: number | null;
  readonly nextDueAt: Date | null;
  readonly originalPeriodId: AllowancePeriodIdType;
  readonly ownerUserId: UserIdType;
  readonly plan: PlanType;
  readonly policyVersion: PlanPolicyVersionType;
  readonly reminderId: ReminderId;
  readonly revision: number;
  readonly scheduleKind: "oneTime" | "recurring";
  readonly schedulerId: string | null;
  readonly state: "active" | "paused" | "canceled" | "completed";
  readonly updatedAt: Date;
}

/** Privacy-safe Reminder lifecycle facts exposed only to the local verifier. */
export interface ReminderVerificationState {
  readonly activeScheduleBindingCount: number;
  readonly occurrenceCount: number;
  readonly occurrences: ReadonlyArray<{
    readonly callbackCapabilityRevokedAt: Date | null;
    readonly committedAt: Date | null;
    readonly exposedAt: Date | null;
    readonly nominalDueAt: Date;
    readonly sourceIdentity: string;
    readonly sourceRevokedAt: Date | null;
    readonly thinkPresentedAt: Date | null;
    readonly thinkSubmissionId: string | null;
  }>;
  readonly reminderCount: number;
}

/** Construct the Agent-local Reminder authority behind one compact interface. */
export const makeReminderAuthority = (options: {
  readonly delivery: ReminderDeliveryPorts;
  readonly makeCallbackCapability: () => Effect.Effect<
    ReminderCallbackCapability,
    ReminderUnavailable
  >;
  readonly now: Effect.Effect<Date>;
  readonly scheduler: ReminderSchedulePort;
  readonly storage: RawReminderStorage;
}) => {
  const storage = makeReminderStorage(options.storage);
  const inspect = Effect.fn("Reminders.inspect")(function* (
    ownerUserId: UserIdType,
    reminderId: ReminderId,
  ) {
    return yield* fromStorage(storage.inspect(ownerUserId, reminderId)).pipe(
      Effect.map((row) => (row === null ? null : decodeReminder(row))),
    );
  });

  const countActive = Effect.fn("Reminders.countActive")(function* (ownerUserId: UserIdType) {
    return yield* fromStorage(storage.countActive(ownerUserId));
  });

  const create = Effect.fn("Reminders.create")(function* (input: CreateInput) {
    const now = yield* options.now;
    yield* validateCreate(input, now);
    const fingerprintJson = createFingerprint(input);
    const inserted = yield* fromStorage(storage.persistCreate({ ...input, fingerprintJson, now }));

    if (inserted._tag === "Limit") {
      return yield* new ReminderLimitReached({
        activeLimit: input.activeLimit,
        ownerUserId: input.ownerUserId,
      });
    }
    if (inserted._tag === "Existing") {
      const existing = inserted.row;
      if (
        existing.fingerprintJson !== fingerprintJson ||
        existing.reminderId !== input.reminderId ||
        existing.revision !== 1
      ) {
        return yield* new ReminderConflict({
          actionId: input.actionId,
          reminderId: input.reminderId,
        });
      }
      yield* reconcileSchedules();
      return mutationResult("Replayed", input.reminderId, 1);
    }

    const callbackCapability = yield* options.makeCallbackCapability();
    const payload = {
      callbackCapability,
      nominalDueAt: input.firstDueAt.toISOString(),
      reminderId: input.reminderId,
      revision: 1,
    } satisfies ReminderSchedulePayload;
    const schedulerId = yield* options.scheduler.arm(input.firstDueAt, payload);
    const bound = yield* fromStorage(
      storage.bindSchedule(
        input.ownerUserId,
        input.reminderId,
        1,
        input.firstDueAt,
        callbackCapability,
        schedulerId,
        now,
      ),
    );
    if (!bound) {
      yield* options.scheduler.cancel(schedulerId);
      return yield* new ReminderConflict({
        actionId: input.actionId,
        reminderId: input.reminderId,
      });
    }
    return mutationResult("Created", input.reminderId, 1);
  });

  const createOneTime = Effect.fn("Reminders.createOneTime")(function* (input: CreateOneTimeInput) {
    return yield* create({ ...input, intervalMilliseconds: null, scheduleKind: "oneTime" });
  });

  const createRecurring = Effect.fn("Reminders.createRecurring")(function* (
    input: CreateRecurringInput,
  ) {
    return yield* create({ ...input, scheduleKind: "recurring" });
  });

  const mutate = Effect.fn("Reminders.mutate")(function* (
    input: MaterialChangeInput,
    mode: "change" | "reactivate",
    activeLimit?: number,
  ) {
    const now = yield* options.now;
    yield* validateMaterialChange(input, now, activeLimit);
    const revision = input.expectedRevision + 1;
    const fingerprintJson = materialFingerprint(input, mode);
    const persisted = yield* fromStorage(
      storage.persistMutation(
        activeLimit === undefined
          ? { ...input, fingerprintJson, mode, now }
          : { ...input, activeLimit, fingerprintJson, mode, now },
      ),
    );
    if (persisted._tag === "Existing") {
      const existing = persisted.row;
      if (
        existing.fingerprintJson !== fingerprintJson ||
        existing.reminderId !== input.reminderId ||
        existing.revision !== revision
      ) {
        return yield* new ReminderConflict({
          actionId: input.actionId,
          reminderId: input.reminderId,
        });
      }
      yield* reconcileSchedules();
      return mutationResult("Replayed", input.reminderId, revision);
    }
    if (persisted._tag === "Limit") {
      return yield* new ReminderLimitReached({
        activeLimit: activeLimit ?? 0,
        ownerUserId: input.ownerUserId,
      });
    }
    if (persisted._tag === "Conflict") {
      return yield* new ReminderConflict({
        actionId: input.actionId,
        reminderId: input.reminderId,
      });
    }
    if (persisted.schedulerId !== null) yield* options.scheduler.cancel(persisted.schedulerId);
    yield* Effect.forEach(
      persisted.sourceIdentities,
      ({ sourceIdentity }) =>
        options.delivery.cancelSource({ ownerUserId: input.ownerUserId, sourceIdentity }),
      { concurrency: 1, discard: true },
    );
    const callbackCapability = yield* options.makeCallbackCapability();
    const payload = {
      callbackCapability,
      nominalDueAt: input.firstDueAt.toISOString(),
      reminderId: input.reminderId,
      revision,
    } satisfies ReminderSchedulePayload;
    const schedulerId = yield* options.scheduler.arm(input.firstDueAt, payload);
    const bound = yield* bindSchedule(
      input.ownerUserId,
      input.reminderId,
      revision,
      input.firstDueAt,
      callbackCapability,
      schedulerId,
      now,
    );
    if (!bound) {
      yield* options.scheduler.cancel(schedulerId);
      return yield* new ReminderConflict({
        actionId: input.actionId,
        reminderId: input.reminderId,
      });
    }
    return mutationResult(
      mode === "change" ? "Changed" : "Reactivated",
      input.reminderId,
      revision,
    );
  });

  const bindSchedule = Effect.fn("Reminders.bindSchedule")(function* (
    ownerUserId: UserIdType,
    reminderId: ReminderId,
    revision: number,
    nominalDueAt: Date,
    callbackCapability: ReminderCallbackCapability,
    schedulerId: string,
    now: Date,
  ) {
    return yield* fromStorage(
      storage.bindSchedule(
        ownerUserId,
        reminderId,
        revision,
        nominalDueAt,
        callbackCapability,
        schedulerId,
        now,
      ),
    );
  });

  const change = Effect.fn("Reminders.change")(function* (input: MaterialChangeInput) {
    return yield* mutate(input, "change");
  });

  const reactivate = Effect.fn("Reminders.reactivate")(function* (input: ReactivateInput) {
    return yield* mutate(input, "reactivate", input.activeLimit);
  });

  const cancel = Effect.fn("Reminders.cancel")(function* (input: CancelInput) {
    const now = yield* options.now;
    const result = yield* fromStorage(
      storage.persistCancel(input.ownerUserId, input.reminderId, input.expectedRevision, now),
    );
    if (result === null) {
      return yield* new ReminderConflict({
        actionId: ActionId.make(`cancel:${input.reminderId}:${input.expectedRevision}`),
        reminderId: input.reminderId,
      });
    }
    if (result.schedulerId !== null) yield* options.scheduler.cancel(result.schedulerId);
    yield* Effect.forEach(
      result.sourceIdentities,
      ({ sourceIdentity }) =>
        options.delivery.cancelSource({ ownerUserId: input.ownerUserId, sourceIdentity }),
      { concurrency: 1, discard: true },
    );
    return {
      _tag: "Canceled" as const,
      reminderId: input.reminderId,
      revision: result.revision,
      state: "canceled" as const,
    };
  });

  const markOccurrenceStep = Effect.fn("Reminders.markOccurrenceStep")(function* (
    sourceIdentity: string,
    column: "accounting_recorded_at" | "wakeup_requested_at" | "wakeup_prompted_at",
    at: Date,
  ) {
    return yield* fromStorage(storage.markOccurrenceStep(sourceIdentity, column, at));
  });

  const completeCommittedOccurrence = Effect.fn("Reminders.completeCommittedOccurrence")(function* (
    occurrence: OccurrenceRow,
  ) {
    const channelLinkId = occurrence.channelLinkId;
    if (channelLinkId === null || occurrence.committedAt === null) {
      return yield* new ReminderUnavailable({
        cause: new Error("Committed Reminder occurrence lacks delivery authority"),
        operation: "deliver.resume",
      });
    }
    if (
      occurrence.policyVersion === PlanPolicyVersion.make("launch-v1") &&
      occurrence.accountingRecordedAt === null
    ) {
      yield* options.delivery.recordLaunchDelivery({
        originalPeriodId: occurrence.originalPeriodId,
        ownerUserId: occurrence.ownerUserId,
        sourceIdentity: occurrence.sourceIdentity,
      });
      yield* markOccurrenceStep(
        occurrence.sourceIdentity,
        "accounting_recorded_at",
        yield* options.now,
      );
    }
    if (occurrence.wakeupRequestedAt === null) {
      yield* options.delivery.requestWakeUp({
        channelLinkId,
        ownerUserId: occurrence.ownerUserId,
        sourceIdentity: occurrence.sourceIdentity,
      });
      yield* markOccurrenceStep(
        occurrence.sourceIdentity,
        "wakeup_requested_at",
        yield* options.now,
      );
    }
    if (occurrence.wakeupPromptedAt === null) {
      yield* options.delivery.promptWakeUp(occurrence.sourceIdentity);
      yield* markOccurrenceStep(
        occurrence.sourceIdentity,
        "wakeup_prompted_at",
        yield* options.now,
      );
    }
    return undefined;
  });

  const readOccurrence = Effect.fn("Reminders.readOccurrence")(function* (
    reminderId: ReminderId,
    revision: number,
    nominalDueAt: Date,
  ) {
    return yield* fromStorage(storage.readOccurrence(reminderId, revision, nominalDueAt));
  });

  const deliver = Effect.fn("Reminders.deliver")(function* (encoded: unknown) {
    const envelope = yield* Schema.decodeUnknownEffect(ReminderScheduleEnvelope)(encoded).pipe(
      Effect.mapError(
        (cause) => new ReminderUnavailable({ cause, operation: "deliver.decodePayload" }),
      ),
    );
    if (
      envelope.callbackCapability === undefined ||
      !Schema.is(ReminderCallbackCapability)(envelope.callbackCapability)
    ) {
      return { _tag: "Noop" as const, reason: "unauthorizedCallback" as const };
    }
    const payload = { ...envelope, callbackCapability: envelope.callbackCapability };
    const existing = yield* readOccurrence(
      payload.reminderId,
      payload.revision,
      payload.nominalDueAt,
    );
    if (existing !== null) {
      if (
        existing.callbackCapability !== payload.callbackCapability ||
        existing.callbackCapabilityRevokedAt !== null
      ) {
        return { _tag: "Noop" as const, reason: "unauthorizedCallback" as const };
      }
      if (existing.committedAt !== null) {
        const current = yield* fromStorage(storage.readDueReminder(payload.reminderId));
        if (
          current === null ||
          current.revision !== existing.revision ||
          (current.state !== "active" && current.state !== "completed")
        ) {
          const now = yield* options.now;
          yield* fromStorage(
            storage.revokeOccurrence(existing.sourceIdentity, "reminderAuthorityChanged", now),
          );
          yield* options.delivery.cancelSource({
            ownerUserId: existing.ownerUserId,
            sourceIdentity: existing.sourceIdentity,
          });
          return { _tag: "Noop" as const, reason: "authorityRevoked" as const };
        }
        const authorization = yield* options.delivery.authorize({
          nominalDueAt: existing.nominalDueAt,
          ownerUserId: existing.ownerUserId,
          reminderId: existing.reminderId,
          revision: existing.revision,
          scheduleKind: existing.scheduleKind,
        });
        if (
          authorization._tag !== "Authorized" ||
          authorization.channelLinkId !== existing.channelLinkId
        ) {
          const reason =
            authorization._tag === "Authorized" ? "channelLinkChanged" : authorization.reason;
          const now = yield* options.now;
          yield* fromStorage(storage.revokeOccurrence(existing.sourceIdentity, reason, now));
          yield* options.delivery.cancelSource({
            ownerUserId: existing.ownerUserId,
            sourceIdentity: existing.sourceIdentity,
          });
          return { _tag: "Noop" as const, reason: "authorityRevoked" as const };
        }
        if (
          current.state === "active" &&
          current.nextDueAt !== null &&
          current.schedulerId === null
        ) {
          const nextCapability = yield* options.makeCallbackCapability();
          const schedulerId = yield* options.scheduler.arm(current.nextDueAt, {
            callbackCapability: nextCapability,
            nominalDueAt: current.nextDueAt.toISOString(),
            reminderId: current.reminderId,
            revision: current.revision,
          });
          if (
            !(yield* bindSchedule(
              current.ownerUserId,
              current.reminderId,
              current.revision,
              current.nextDueAt,
              nextCapability,
              schedulerId,
              yield* options.now,
            ))
          ) {
            yield* options.scheduler.cancel(schedulerId);
          }
        }
        yield* completeCommittedOccurrence(existing);
      }
      return {
        _tag: "Replayed" as const,
        nextDueAt: null,
        sourceIdentity: existing.sourceIdentity,
      };
    }

    const reminder = yield* fromStorage(storage.readDueReminder(payload.reminderId));
    if (reminder === null) return { _tag: "Noop" as const, reason: "missing" as const };
    if (
      reminder.state !== "active" ||
      reminder.revision !== payload.revision ||
      reminder.callbackCapability !== payload.callbackCapability ||
      reminder.nextDueAt?.getTime() !== payload.nominalDueAt.getTime()
    ) {
      return { _tag: "Noop" as const, reason: "stale" as const };
    }
    const now = yield* options.now;
    if (now < payload.nominalDueAt) return { _tag: "Noop" as const, reason: "notDue" as const };

    const authorization = yield* options.delivery.authorize({
      nominalDueAt: payload.nominalDueAt,
      ownerUserId: reminder.ownerUserId,
      reminderId: reminder.reminderId,
      revision: reminder.revision,
      scheduleKind: reminder.scheduleKind,
    });
    const sourceIdentity = occurrenceSourceIdentity(payload);
    if (authorization._tag !== "Authorized") {
      const retained = yield* fromStorage(
        storage.retainDisposition({
          disposition: authorization._tag,
          callbackCapability: payload.callbackCapability,
          due: reminder,
          nominalDueAt: payload.nominalDueAt,
          now,
          reason: authorization.reason,
          sourceIdentity,
        }),
      );
      if (!retained) return { _tag: "Noop" as const, reason: "stale" as const };
      return { _tag: authorization._tag, reason: authorization.reason, sourceIdentity };
    }

    const nextDueAt =
      reminder.scheduleKind === "recurring" && reminder.intervalMilliseconds !== null
        ? new Date(payload.nominalDueAt.getTime() + reminder.intervalMilliseconds)
        : null;
    const committed = yield* fromStorage(
      storage.commitOccurrence({
        callbackCapability: payload.callbackCapability,
        channelLinkId: authorization.channelLinkId,
        due: reminder,
        nextDueAt,
        nominalDueAt: payload.nominalDueAt,
        now,
        sourceIdentity,
      }),
    );
    if (!committed) return { _tag: "Noop" as const, reason: "stale" as const };

    if (nextDueAt !== null) {
      const callbackCapability = yield* options.makeCallbackCapability();
      const schedulerId = yield* options.scheduler.arm(nextDueAt, {
        callbackCapability,
        nominalDueAt: nextDueAt.toISOString(),
        reminderId: reminder.reminderId,
        revision: reminder.revision,
      });
      if (
        !(yield* bindSchedule(
          reminder.ownerUserId,
          reminder.reminderId,
          reminder.revision,
          nextDueAt,
          callbackCapability,
          schedulerId,
          now,
        ))
      ) {
        yield* options.scheduler.cancel(schedulerId);
      }
    }
    const occurrence = yield* readOccurrence(
      reminder.reminderId,
      reminder.revision,
      payload.nominalDueAt,
    );
    if (occurrence === null) {
      return yield* new ReminderUnavailable({
        cause: new Error("Committed Reminder occurrence disappeared"),
        operation: "deliver.reloadOccurrence",
      });
    }
    yield* completeCommittedOccurrence(occurrence);
    return { _tag: "Committed" as const, nextDueAt, sourceIdentity };
  });

  const pendingSources = Effect.fn("Reminders.pendingSources")(function* (ownerUserId: UserIdType) {
    return yield* fromStorage(storage.pendingSources(ownerUserId));
  });

  const inspectSource = Effect.fn("Reminders.inspectSource")(function* (
    ownerUserId: UserIdType,
    sourceIdentity: string,
  ) {
    return yield* fromStorage(storage.inspectSource(ownerUserId, sourceIdentity));
  });

  const exposeSources = Effect.fn("Reminders.exposeSources")(function* (
    ownerUserId: UserIdType,
    selected: ReadonlyArray<ReminderCommittedSource>,
  ) {
    const current = yield* pendingSources(ownerUserId);
    if (!sameCommittedSources(current, selected)) {
      return yield* new ReminderUnavailable({
        cause: new Error("Reminder source snapshot changed before exposure"),
        operation: "sources.exposeSnapshot",
      });
    }
    const now = yield* options.now;
    return yield* fromStorage(
      storage.exposeSources(
        ownerUserId,
        selected.map(({ sourceIdentity }) => sourceIdentity),
        now,
      ),
    );
  });

  const claimThinkExposures = Effect.fn("Reminders.claimThinkExposures")(function* (
    ownerUserId: UserIdType,
    submissionId: ThinkSubmissionId,
  ) {
    const now = yield* options.now;
    return yield* fromStorage(storage.claimThinkExposures(ownerUserId, submissionId, now));
  });

  const deleteUser = Effect.fn("Reminders.deleteUser")(function* (ownerUserId: UserIdType) {
    const now = yield* options.now;
    const fenced = yield* fromStorage(storage.fenceDeletion(ownerUserId, now));
    yield* Effect.forEach(
      fenced.reminders,
      ({ schedulerId }) =>
        schedulerId === null ? Effect.void : options.scheduler.cancel(schedulerId),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      fenced.sources,
      ({ sourceIdentity }) => options.delivery.cancelSource({ ownerUserId, sourceIdentity }),
      { concurrency: 1, discard: true },
    );
    yield* fromStorage(storage.eraseUser(ownerUserId));
  });

  const reconcileSchedules = Effect.fn("Reminders.reconcileSchedules")(function* () {
    const now = yield* options.now;
    const listed = yield* options.scheduler.list();
    const active = yield* fromStorage(storage.readActiveSchedules());
    const byId = new Map(active.map((reminder) => [reminder.reminderId, reminder]));
    const validIds = new Set<string>();
    const staleIds: Array<string> = [];
    for (const schedule of listed) {
      if (schedule.callback !== "deliverReminder") continue;
      const decoded = Schema.decodeUnknownOption(ReminderSchedulePayload)(schedule.payload);
      if (Option.isNone(decoded)) {
        staleIds.push(schedule.id);
        continue;
      }
      const reminder = byId.get(decoded.value.reminderId);
      if (
        reminder === undefined ||
        reminder.schedulerId !== schedule.id ||
        reminder.callbackCapability !== decoded.value.callbackCapability ||
        reminder.revision !== decoded.value.revision ||
        reminder.nextDueAt.getTime() !== decoded.value.nominalDueAt.getTime() ||
        schedule.timeEpochSeconds !== reminderSchedulerEpochSecond(reminder.nextDueAt)
      ) {
        staleIds.push(schedule.id);
        continue;
      }
      validIds.add(schedule.id);
    }
    yield* Effect.forEach(staleIds, options.scheduler.cancel, { concurrency: 1, discard: true });

    let armed = 0;
    for (const reminder of active) {
      if (reminder.schedulerId !== null && validIds.has(reminder.schedulerId)) continue;
      yield* fromStorage(storage.clearScheduleBinding(reminder, now));
      const callbackCapability = yield* options.makeCallbackCapability();
      const schedulerId = yield* options.scheduler.arm(reminder.nextDueAt, {
        callbackCapability,
        nominalDueAt: reminder.nextDueAt.toISOString(),
        reminderId: reminder.reminderId,
        revision: reminder.revision,
      });
      if (
        yield* bindSchedule(
          reminder.ownerUserId,
          reminder.reminderId,
          reminder.revision,
          reminder.nextDueAt,
          callbackCapability,
          schedulerId,
          now,
        )
      ) {
        armed += 1;
      } else {
        yield* options.scheduler.cancel(schedulerId);
      }
    }
    return { armed, canceled: staleIds.length };
  });

  const reconcileActiveLimit = Effect.fn("Reminders.reconcileActiveLimit")(function* (
    input: ReconcileActiveLimitInput,
  ) {
    if (!Number.isSafeInteger(input.activeLimit) || input.activeLimit < 0) {
      return yield* new ReminderInputInvalid({ message: "Active Reminder limit is invalid" });
    }
    const now = yield* options.now;
    const paused = yield* fromStorage(
      storage.pauseExcess(input.ownerUserId, input.activeLimit, now),
    );
    yield* Effect.forEach(
      paused.reminders,
      ({ schedulerId }) =>
        schedulerId === null ? Effect.void : options.scheduler.cancel(schedulerId),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      paused.sources,
      ({ sourceIdentity }) =>
        options.delivery.cancelSource({ ownerUserId: input.ownerUserId, sourceIdentity }),
      { concurrency: 1, discard: true },
    );
    return paused.reminders.map(({ reminderId }) => ({ reminderId }));
  });

  const verificationState = (ownerUserId: UserIdType) =>
    fromStorage(storage.verificationState(ownerUserId));

  return {
    cancel,
    change,
    countActive,
    createOneTime,
    createRecurring,
    deleteUser,
    deliver,
    exposeSources,
    inspect,
    inspectSource,
    pendingSources,
    claimThinkExposures,
    reactivate,
    reconcileActiveLimit,
    reconcileSchedules,
    verificationState,
  };
};

export type ReminderAuthority = ReturnType<typeof makeReminderAuthority>;

const validateCreate = (
  input: CreateInput,
  now: Date,
): Effect.Effect<void, ReminderInputInvalid> => {
  if (!Number.isSafeInteger(input.activeLimit) || input.activeLimit <= 0) {
    return Effect.fail(new ReminderInputInvalid({ message: "Active Reminder limit is invalid" }));
  }
  if (new TextEncoder().encode(input.body).byteLength === 0) {
    return Effect.fail(new ReminderInputInvalid({ message: "Reminder body is empty" }));
  }
  if (new TextEncoder().encode(input.body).byteLength > 2_000) {
    return Effect.fail(new ReminderInputInvalid({ message: "Reminder body exceeds 2,000 bytes" }));
  }
  if (!Number.isFinite(input.firstDueAt.getTime()) || input.firstDueAt <= now) {
    return Effect.fail(
      new ReminderInputInvalid({ message: "One-time Reminder due instant must be in the future" }),
    );
  }
  const intervalMilliseconds = input.intervalMilliseconds;
  if (
    input.scheduleKind === "recurring" &&
    (intervalMilliseconds === null ||
      !Number.isSafeInteger(intervalMilliseconds) ||
      intervalMilliseconds < 86_400_000)
  ) {
    return Effect.fail(
      new ReminderInputInvalid({
        message: "Recurring Reminder interval must be at least 86,400,000 milliseconds",
      }),
    );
  }
  return Effect.void;
};

const createFingerprint = (input: CreateInput) =>
  JSON.stringify({
    body: input.body,
    firstDueAt: input.firstDueAt.toISOString(),
    intervalMilliseconds: input.intervalMilliseconds,
    originalPeriodId: input.originalPeriodId,
    ownerUserId: input.ownerUserId,
    plan: input.plan,
    policyVersion: input.policyVersion,
    reminderId: input.reminderId,
    scheduleKind: input.scheduleKind,
  });

const validateMaterialChange = (
  input: MaterialChangeInput,
  now: Date,
  activeLimit?: number,
): Effect.Effect<void, ReminderInputInvalid> => {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    return Effect.fail(new ReminderInputInvalid({ message: "Reminder revision is invalid" }));
  }
  if (activeLimit !== undefined && (!Number.isSafeInteger(activeLimit) || activeLimit <= 0)) {
    return Effect.fail(new ReminderInputInvalid({ message: "Active Reminder limit is invalid" }));
  }
  return validateCreate(
    {
      actionId: input.actionId,
      activeLimit: activeLimit ?? 1,
      body: input.body,
      firstDueAt: input.firstDueAt,
      intervalMilliseconds: input.intervalMilliseconds,
      originalPeriodId: AllowancePeriodId.make("validation-only"),
      ownerUserId: input.ownerUserId,
      plan: "free",
      policyVersion: PlanPolicyVersion.make("validation-only"),
      reminderId: input.reminderId,
      scheduleKind: input.scheduleKind,
    },
    now,
  );
};

const materialFingerprint = (input: MaterialChangeInput, mode: "change" | "reactivate") =>
  JSON.stringify({
    body: input.body,
    expectedRevision: input.expectedRevision,
    firstDueAt: input.firstDueAt.toISOString(),
    intervalMilliseconds: input.intervalMilliseconds,
    mode,
    ownerUserId: input.ownerUserId,
    reminderId: input.reminderId,
    scheduleKind: input.scheduleKind,
  });

const sameCommittedSources = (
  left: ReadonlyArray<ReminderCommittedSource>,
  right: ReadonlyArray<ReminderCommittedSource>,
) =>
  left.length === right.length &&
  left.every(
    (source, index) =>
      source.sourceIdentity === right[index]?.sourceIdentity &&
      source.committedAt.getTime() === right[index]?.committedAt.getTime(),
  );

const mutationResult = (
  tag: ReminderMutationResult["_tag"],
  reminderId: ReminderId,
  revision: number,
): ReminderMutationResult => ({ _tag: tag, reminderId, revision, state: "active" });

const occurrenceSourceIdentity = (payload: typeof ReminderSchedulePayload.Type): string =>
  `reminder:${payload.reminderId.length}:${payload.reminderId}:${payload.revision}:${payload.nominalDueAt.toISOString()}`;

const decodeReminder = (stored: ReminderRow): ReminderRecord => stored;

const fromStorage = <A>(
  effect: Effect.Effect<A, ReminderStorageUnavailable>,
): Effect.Effect<A, ReminderUnavailable> =>
  effect.pipe(
    Effect.mapError(
      (failure) => new ReminderUnavailable({ cause: failure.cause, operation: failure.operation }),
    ),
  );

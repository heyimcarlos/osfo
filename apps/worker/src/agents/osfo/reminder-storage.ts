import { Effect, Schema } from "effect";

import {
  AllowancePeriodId,
  ChannelLinkId,
  Plan,
  PlanPolicyVersion,
  UserId,
  type ThinkSubmissionId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";

/* oxlint-disable osfo/no-unknown-returns -- Raw SQLite values stay unknown only until the adjacent Effect Schema decoder. */

type ActionIdType = ActionId;
type AllowancePeriodIdType = AllowancePeriodId;
type ChannelLinkIdType = ChannelLinkId;
type PlanPolicyVersionType = PlanPolicyVersion;
type PlanType = Plan;
type UserIdType = UserId;

export interface RawReminderStorage {
  readonly sql: Pick<SqlStorage, "exec">;
  readonly transactionSync: <A>(transaction: () => A) => A;
}

const ReminderId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand("ReminderId"),
);
export type StoredReminderId = typeof ReminderId.Type;

const ReminderCallbackCapability = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("ReminderCallbackCapability"),
);
export type StoredReminderCallbackCapability = typeof ReminderCallbackCapability.Type;

const ReminderRow = Schema.Struct({
  body: Schema.String,
  creationActionId: ActionId,
  createdAt: Schema.DateFromString,
  firstDueAt: Schema.DateFromString,
  intervalMilliseconds: Schema.NullOr(Schema.Int),
  nextDueAt: Schema.NullOr(Schema.DateFromString),
  originalPeriodId: AllowancePeriodId,
  ownerUserId: UserId,
  plan: Plan,
  policyVersion: PlanPolicyVersion,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  scheduleKind: Schema.Literals(["oneTime", "recurring"]),
  schedulerId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "paused", "canceled", "completed"]),
  updatedAt: Schema.DateFromString,
});
export type ReminderRow = typeof ReminderRow.Type;

const ActionRow = Schema.Struct({
  fingerprintJson: Schema.String,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ActionRow = typeof ActionRow.Type;

const MutationTarget = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  schedulerId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "paused", "canceled", "completed"]),
});

const DueReminderRow = Schema.Struct({
  body: Schema.String,
  callbackCapability: Schema.NullOr(ReminderCallbackCapability),
  intervalMilliseconds: Schema.NullOr(Schema.Int),
  nextDueAt: Schema.NullOr(Schema.DateFromString),
  originalPeriodId: AllowancePeriodId,
  ownerUserId: UserId,
  policyVersion: PlanPolicyVersion,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  scheduleKind: Schema.Literals(["oneTime", "recurring"]),
  schedulerId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "paused", "canceled", "completed"]),
});
export type DueReminderRow = typeof DueReminderRow.Type;

const OccurrenceRow = Schema.Struct({
  accountingRecordedAt: Schema.NullOr(Schema.String),
  blockedAt: Schema.NullOr(Schema.String),
  canceledAt: Schema.NullOr(Schema.String),
  channelLinkId: Schema.NullOr(ChannelLinkId),
  callbackCapability: ReminderCallbackCapability,
  callbackCapabilityRevokedAt: Schema.NullOr(Schema.String),
  committedAt: Schema.NullOr(Schema.DateFromString),
  originalPeriodId: AllowancePeriodId,
  ownerUserId: UserId,
  policyVersion: PlanPolicyVersion,
  nominalDueAt: Schema.DateFromString,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  scheduleKind: Schema.Literals(["oneTime", "recurring"]),
  sourceIdentity: Schema.String,
  wakeupPromptedAt: Schema.NullOr(Schema.String),
  wakeupRequestedAt: Schema.NullOr(Schema.String),
});
export type OccurrenceRow = typeof OccurrenceRow.Type;

const PendingSourceRow = Schema.Struct({
  committedAt: Schema.DateFromString,
  sourceIdentity: Schema.String,
});
export type PendingSourceRow = typeof PendingSourceRow.Type;

const ThinkExposureRow = Schema.Struct({
  body: Schema.String,
  committedAt: Schema.DateFromString,
  sourceIdentity: Schema.String,
});
export type ThinkExposureRow = typeof ThinkExposureRow.Type;

const VerificationOccurrenceRow = Schema.Struct({
  callbackCapabilityRevokedAt: Schema.NullOr(Schema.DateFromString),
  committedAt: Schema.NullOr(Schema.DateFromString),
  exposedAt: Schema.NullOr(Schema.DateFromString),
  nominalDueAt: Schema.DateFromString,
  sourceIdentity: Schema.String,
  sourceRevokedAt: Schema.NullOr(Schema.DateFromString),
  thinkPresentedAt: Schema.NullOr(Schema.DateFromString),
  thinkSubmissionId: Schema.NullOr(Schema.String),
});
export type VerificationOccurrenceRow = typeof VerificationOccurrenceRow.Type;

const ActiveScheduleRow = Schema.Struct({
  callbackCapability: Schema.NullOr(ReminderCallbackCapability),
  nextDueAt: Schema.DateFromString,
  ownerUserId: UserId,
  reminderId: ReminderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  schedulerId: Schema.NullOr(Schema.String),
});
export type ActiveScheduleRow = typeof ActiveScheduleRow.Type;

const DeletionReminderRow = Schema.Struct({ schedulerId: Schema.NullOr(Schema.String) });
const DeletionSourceRow = Schema.Struct({ sourceIdentity: Schema.String });

const cancelCommittedSources = (
  raw: RawReminderStorage,
  ownerUserId: UserIdType,
  reminderId: StoredReminderId,
  revision: number,
  now: Date,
) => {
  const sources = Schema.decodeUnknownSync(Schema.Array(DeletionSourceRow))(
    raw.sql
      .exec(
        `SELECT source_identity AS sourceIdentity FROM osfo_reminder_occurrences
          WHERE owner_user_id = ? AND reminder_id = ? AND revision = ?
            AND committed_at IS NOT NULL AND source_revoked_at IS NULL
          ORDER BY source_identity`,
        ownerUserId,
        reminderId,
        revision,
      )
      .toArray(),
  );
  raw.sql.exec(
    `UPDATE osfo_reminder_occurrences
        SET source_revoked_at = COALESCE(source_revoked_at, ?),
            callback_capability_revoked_at = COALESCE(callback_capability_revoked_at, ?),
            disposition_reason = 'authoritySuperseded'
      WHERE owner_user_id = ? AND reminder_id = ? AND revision = ?
        AND committed_at IS NOT NULL AND source_revoked_at IS NULL`,
    now.toISOString(),
    now.toISOString(),
    ownerUserId,
    reminderId,
    revision,
  );
  return sources;
};

export interface PersistCreateInput {
  readonly actionId: ActionIdType;
  readonly activeLimit: number;
  readonly body: string;
  readonly fingerprintJson: string;
  readonly firstDueAt: Date;
  readonly intervalMilliseconds: number | null;
  readonly now: Date;
  readonly originalPeriodId: AllowancePeriodIdType;
  readonly ownerUserId: UserIdType;
  readonly plan: PlanType;
  readonly policyVersion: PlanPolicyVersionType;
  readonly reminderId: StoredReminderId;
  readonly scheduleKind: "oneTime" | "recurring";
}

export interface PersistMutationInput {
  readonly actionId: ActionIdType;
  readonly activeLimit?: number;
  readonly body: string;
  readonly expectedRevision: number;
  readonly fingerprintJson: string;
  readonly firstDueAt: Date;
  readonly intervalMilliseconds: number | null;
  readonly mode: "change" | "reactivate";
  readonly now: Date;
  readonly ownerUserId: UserIdType;
  readonly reminderId: StoredReminderId;
  readonly scheduleKind: "oneTime" | "recurring";
}

export const makeReminderStorage = (raw: RawReminderStorage) => {
  const inspect = (ownerUserId: UserIdType, reminderId: StoredReminderId) =>
    queryOptional(
      "inspect",
      ReminderRow,
      () =>
        raw.sql
          .exec(
            `SELECT reminder_id AS reminderId, owner_user_id AS ownerUserId,
                    creation_action_id AS creationActionId, created_at AS createdAt,
                    revision, schedule_kind AS scheduleKind, body,
                    first_due_at AS firstDueAt, next_due_at AS nextDueAt,
                    interval_milliseconds AS intervalMilliseconds, state,
                    scheduler_id AS schedulerId, original_period_id AS originalPeriodId,
                    policy_version AS policyVersion, plan, updated_at AS updatedAt
               FROM osfo_reminders
              WHERE owner_user_id = ? AND reminder_id = ? LIMIT 1`,
            ownerUserId,
            reminderId,
          )
          .toArray()[0],
    );

  const countActive = (ownerUserId: UserIdType) =>
    attempt(
      "countActive",
      () =>
        raw.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM osfo_reminders
            WHERE owner_user_id = ? AND state = 'active'`,
            ownerUserId,
          )
          .one().count,
    );

  const persistCreate = (input: PersistCreateInput) =>
    attempt("create.persist", () =>
      raw.transactionSync(() => {
        const existing = raw.sql
          .exec(
            `SELECT reminder_id AS reminderId, revision, fingerprint_json AS fingerprintJson
               FROM osfo_reminder_actions WHERE action_id = ? LIMIT 1`,
            input.actionId,
          )
          .toArray()[0];
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: Schema.decodeUnknownSync(ActionRow)(existing) };
        }
        const active = raw.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM osfo_reminders
              WHERE owner_user_id = ? AND state = 'active'`,
            input.ownerUserId,
          )
          .one().count;
        if (active >= input.activeLimit) return { _tag: "Limit" as const };
        const timestamp = input.now.toISOString();
        raw.sql.exec(
          `INSERT INTO osfo_reminders (
             reminder_id, owner_user_id, creation_action_id, created_at, revision,
             schedule_kind, body, first_due_at, next_due_at, interval_milliseconds,
             state, scheduler_id, original_period_id, policy_version, plan, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`,
          input.reminderId,
          input.ownerUserId,
          input.actionId,
          timestamp,
          input.scheduleKind,
          input.body,
          input.firstDueAt.toISOString(),
          input.firstDueAt.toISOString(),
          input.intervalMilliseconds,
          input.originalPeriodId,
          input.policyVersion,
          input.plan,
          timestamp,
        );
        raw.sql.exec(
          `INSERT INTO osfo_reminder_actions (action_id, reminder_id, fingerprint_json, revision)
           VALUES (?, ?, ?, 1)`,
          input.actionId,
          input.reminderId,
          input.fingerprintJson,
        );
        return { _tag: "Inserted" as const };
      }),
    );

  const persistMutation = (input: PersistMutationInput) =>
    attempt(`${input.mode}.persist`, () =>
      raw.transactionSync(() => {
        const existing = raw.sql
          .exec(
            `SELECT reminder_id AS reminderId, revision, fingerprint_json AS fingerprintJson
               FROM osfo_reminder_actions WHERE action_id = ? LIMIT 1`,
            input.actionId,
          )
          .toArray()[0];
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: Schema.decodeUnknownSync(ActionRow)(existing) };
        }
        const row = raw.sql
          .exec(
            `SELECT revision, scheduler_id AS schedulerId, state FROM osfo_reminders
              WHERE owner_user_id = ? AND reminder_id = ? LIMIT 1`,
            input.ownerUserId,
            input.reminderId,
          )
          .toArray()[0];
        if (row === undefined) return { _tag: "Conflict" as const };
        const target = Schema.decodeUnknownSync(MutationTarget)(row);
        if (
          target.revision !== input.expectedRevision ||
          target.state !== (input.mode === "change" ? "active" : "paused")
        ) {
          return { _tag: "Conflict" as const };
        }
        if (input.mode === "reactivate") {
          const active = raw.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM osfo_reminders
                WHERE owner_user_id = ? AND state = 'active'`,
              input.ownerUserId,
            )
            .one().count;
          if (input.activeLimit === undefined || active >= input.activeLimit) {
            return { _tag: "Limit" as const };
          }
        }
        const sourceIdentities = cancelCommittedSources(
          raw,
          input.ownerUserId,
          input.reminderId,
          target.revision,
          input.now,
        );
        const revision = input.expectedRevision + 1;
        raw.sql.exec(
          `UPDATE osfo_reminders SET revision = ?, schedule_kind = ?, body = ?,
                  first_due_at = ?, next_due_at = ?, interval_milliseconds = ?,
                  state = 'active', callback_capability = NULL,
                  scheduler_id = NULL, updated_at = ?
            WHERE owner_user_id = ? AND reminder_id = ?`,
          revision,
          input.scheduleKind,
          input.body,
          input.firstDueAt.toISOString(),
          input.firstDueAt.toISOString(),
          input.intervalMilliseconds,
          input.now.toISOString(),
          input.ownerUserId,
          input.reminderId,
        );
        raw.sql.exec(
          `INSERT INTO osfo_reminder_actions (action_id, reminder_id, fingerprint_json, revision)
           VALUES (?, ?, ?, ?)`,
          input.actionId,
          input.reminderId,
          input.fingerprintJson,
          revision,
        );
        return {
          _tag: "Updated" as const,
          schedulerId: target.schedulerId,
          sourceIdentities,
        };
      }),
    );

  const bindSchedule = (
    ownerUserId: UserIdType,
    reminderId: StoredReminderId,
    revision: number,
    nominalDueAt: Date,
    callbackCapability: StoredReminderCallbackCapability,
    schedulerId: string,
    now: Date,
  ) =>
    attempt("bindSchedule", () =>
      raw.transactionSync(
        () =>
          raw.sql
            .exec(
              `UPDATE osfo_reminders SET callback_capability = ?, scheduler_id = ?, updated_at = ?
                WHERE owner_user_id = ? AND reminder_id = ? AND revision = ?
                  AND state = 'active' AND next_due_at = ? AND scheduler_id IS NULL
                  AND callback_capability IS NULL
                RETURNING reminder_id AS reminderId`,
              callbackCapability,
              schedulerId,
              now.toISOString(),
              ownerUserId,
              reminderId,
              revision,
              nominalDueAt.toISOString(),
            )
            .toArray().length === 1,
      ),
    );

  const persistCancel = (
    ownerUserId: UserIdType,
    reminderId: StoredReminderId,
    expectedRevision: number,
    now: Date,
  ) =>
    attempt("cancel.persist", () =>
      raw.transactionSync(() => {
        const row = raw.sql
          .exec(
            `SELECT revision, scheduler_id AS schedulerId, state FROM osfo_reminders
              WHERE owner_user_id = ? AND reminder_id = ? LIMIT 1`,
            ownerUserId,
            reminderId,
          )
          .toArray()[0];
        if (row === undefined) return null;
        const target = Schema.decodeUnknownSync(MutationTarget)(row);
        if (target.revision !== expectedRevision || target.state === "canceled") return null;
        const sourceIdentities = cancelCommittedSources(
          raw,
          ownerUserId,
          reminderId,
          target.revision,
          now,
        );
        const revision = target.revision + 1;
        raw.sql.exec(
          `UPDATE osfo_reminders SET revision = ?, state = 'canceled', next_due_at = NULL,
                  callback_capability = NULL, scheduler_id = NULL, updated_at = ?
            WHERE owner_user_id = ? AND reminder_id = ?`,
          revision,
          now.toISOString(),
          ownerUserId,
          reminderId,
        );
        return { revision, schedulerId: target.schedulerId, sourceIdentities };
      }),
    );

  const markOccurrenceStep = (
    sourceIdentity: string,
    column: "accounting_recorded_at" | "wakeup_requested_at" | "wakeup_prompted_at",
    at: Date,
  ) =>
    attempt("deliver.markStep", () => {
      if (column === "accounting_recorded_at") {
        raw.sql.exec(
          `UPDATE osfo_reminder_occurrences SET accounting_recorded_at = ?
            WHERE source_identity = ? AND accounting_recorded_at IS NULL`,
          at.toISOString(),
          sourceIdentity,
        );
        return;
      }
      if (column === "wakeup_requested_at") {
        raw.sql.exec(
          `UPDATE osfo_reminder_occurrences SET wakeup_requested_at = ?
            WHERE source_identity = ? AND wakeup_requested_at IS NULL`,
          at.toISOString(),
          sourceIdentity,
        );
        return;
      }
      raw.sql.exec(
        `UPDATE osfo_reminder_occurrences SET wakeup_prompted_at = ?
          WHERE source_identity = ? AND wakeup_prompted_at IS NULL`,
        at.toISOString(),
        sourceIdentity,
      );
    });

  const revokeOccurrence = (sourceIdentity: string, reason: string, now: Date) =>
    attempt("deliver.revokeOccurrence", () => {
      raw.sql.exec(
        `UPDATE osfo_reminder_occurrences
            SET callback_capability_revoked_at = COALESCE(callback_capability_revoked_at, ?),
                source_revoked_at = COALESCE(source_revoked_at, ?),
                disposition_reason = ?
          WHERE source_identity = ? AND committed_at IS NOT NULL`,
        now.toISOString(),
        now.toISOString(),
        reason,
        sourceIdentity,
      );
    });

  const readOccurrence = (reminderId: StoredReminderId, revision: number, nominalDueAt: Date) =>
    queryOptional(
      "deliver.inspectOccurrence",
      OccurrenceRow,
      () =>
        raw.sql
          .exec(
            `SELECT reminder_id AS reminderId, revision,
                    nominal_due_at AS nominalDueAt, schedule_kind AS scheduleKind,
                    owner_user_id AS ownerUserId, channel_link_id AS channelLinkId,
                    callback_capability AS callbackCapability,
                    callback_capability_revoked_at AS callbackCapabilityRevokedAt,
                    source_identity AS sourceIdentity, original_period_id AS originalPeriodId,
                    policy_version AS policyVersion, committed_at AS committedAt,
                    blocked_at AS blockedAt, canceled_at AS canceledAt,
                    accounting_recorded_at AS accountingRecordedAt,
                    wakeup_requested_at AS wakeupRequestedAt,
                    wakeup_prompted_at AS wakeupPromptedAt
               FROM osfo_reminder_occurrences
              WHERE reminder_id = ? AND revision = ? AND nominal_due_at = ? LIMIT 1`,
            reminderId,
            revision,
            nominalDueAt.toISOString(),
          )
          .toArray()[0],
    );

  const readDueReminder = (reminderId: StoredReminderId) =>
    queryOptional(
      "deliver.inspectReminder",
      DueReminderRow,
      () =>
        raw.sql
          .exec(
            `SELECT reminder_id AS reminderId, owner_user_id AS ownerUserId, revision,
                    schedule_kind AS scheduleKind, body, next_due_at AS nextDueAt,
                    interval_milliseconds AS intervalMilliseconds, state,
                    callback_capability AS callbackCapability, scheduler_id AS schedulerId,
                    original_period_id AS originalPeriodId, policy_version AS policyVersion
               FROM osfo_reminders WHERE reminder_id = ? LIMIT 1`,
            reminderId,
          )
          .toArray()[0],
    );

  const retainDisposition = (input: {
    readonly callbackCapability: StoredReminderCallbackCapability;
    readonly disposition: "Blocked" | "Canceled";
    readonly due: DueReminderRow;
    readonly nominalDueAt: Date;
    readonly now: Date;
    readonly reason: string;
    readonly sourceIdentity: string;
  }) =>
    attempt("deliver.retainDisposition", () =>
      raw.transactionSync(() => {
        const updated = raw.sql
          .exec(
            `UPDATE osfo_reminders SET state = 'paused', callback_capability = NULL,
                    scheduler_id = NULL, updated_at = ?
              WHERE reminder_id = ? AND revision = ? AND state = 'active'
                AND next_due_at = ? AND callback_capability = ?
              RETURNING reminder_id AS reminderId`,
            input.now.toISOString(),
            input.due.reminderId,
            input.due.revision,
            input.nominalDueAt.toISOString(),
            input.callbackCapability,
          )
          .toArray();
        if (updated.length !== 1) return false;
        const sql =
          input.disposition === "Blocked"
            ? `INSERT OR IGNORE INTO osfo_reminder_occurrences (
                 reminder_id, revision, nominal_due_at, owner_user_id, channel_link_id,
                 source_identity, body_snapshot, schedule_kind, original_period_id,
                 policy_version, callback_capability, callback_capability_revoked_at,
                 blocked_at, disposition_reason
               ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            : `INSERT OR IGNORE INTO osfo_reminder_occurrences (
                 reminder_id, revision, nominal_due_at, owner_user_id, channel_link_id,
                 source_identity, body_snapshot, schedule_kind, original_period_id,
                 policy_version, callback_capability, callback_capability_revoked_at,
                 canceled_at, disposition_reason
               ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        raw.sql.exec(
          sql,
          input.due.reminderId,
          input.due.revision,
          input.nominalDueAt.toISOString(),
          input.due.ownerUserId,
          input.sourceIdentity,
          input.due.body,
          input.due.scheduleKind,
          input.due.originalPeriodId,
          input.due.policyVersion,
          input.callbackCapability,
          input.now.toISOString(),
          input.now.toISOString(),
          input.reason,
        );
        return true;
      }),
    );

  const commitOccurrence = (input: {
    readonly callbackCapability: StoredReminderCallbackCapability;
    readonly channelLinkId: ChannelLinkIdType;
    readonly due: DueReminderRow;
    readonly nextDueAt: Date | null;
    readonly nominalDueAt: Date;
    readonly now: Date;
    readonly sourceIdentity: string;
  }) =>
    attempt("deliver.commit", () =>
      raw.transactionSync(() => {
        const updated = raw.sql
          .exec(
            `UPDATE osfo_reminders SET state = ?, next_due_at = ?,
                    callback_capability = NULL, scheduler_id = NULL,
                    updated_at = ?
              WHERE reminder_id = ? AND revision = ? AND state = 'active' AND next_due_at = ?
                AND callback_capability = ?
              RETURNING reminder_id AS reminderId`,
            input.nextDueAt === null ? "completed" : "active",
            input.nextDueAt?.toISOString() ?? null,
            input.now.toISOString(),
            input.due.reminderId,
            input.due.revision,
            input.nominalDueAt.toISOString(),
            input.callbackCapability,
          )
          .toArray();
        if (updated.length !== 1) return false;
        raw.sql.exec(
          `INSERT INTO osfo_reminder_occurrences (
             reminder_id, revision, nominal_due_at, owner_user_id, channel_link_id,
             source_identity, body_snapshot, schedule_kind, original_period_id,
             policy_version, callback_capability, committed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.due.reminderId,
          input.due.revision,
          input.nominalDueAt.toISOString(),
          input.due.ownerUserId,
          input.channelLinkId,
          input.sourceIdentity,
          input.due.body,
          input.due.scheduleKind,
          input.due.originalPeriodId,
          input.due.policyVersion,
          input.callbackCapability,
          input.now.toISOString(),
        );
        return true;
      }),
    );

  const pendingSources = (ownerUserId: UserIdType) =>
    queryArray("sources.pending", PendingSourceRow, () =>
      raw.sql
        .exec(
          `SELECT occurrence.committed_at AS committedAt,
                  occurrence.source_identity AS sourceIdentity
             FROM osfo_reminder_occurrences occurrence
             JOIN osfo_reminders reminder ON reminder.reminder_id = occurrence.reminder_id
            WHERE occurrence.owner_user_id = ? AND occurrence.committed_at IS NOT NULL
              AND occurrence.exposed_at IS NULL AND occurrence.blocked_at IS NULL
              AND occurrence.canceled_at IS NULL AND occurrence.source_revoked_at IS NULL
              AND reminder.revision = occurrence.revision
              AND reminder.state IN ('active', 'completed')
            ORDER BY occurrence.committed_at, occurrence.source_identity`,
          ownerUserId,
        )
        .toArray(),
    );

  const inspectSource = (ownerUserId: UserIdType, sourceIdentity: string) =>
    queryOptional(
      "sources.inspect",
      PendingSourceRow,
      () =>
        raw.sql
          .exec(
            `SELECT occurrence.committed_at AS committedAt,
                    occurrence.source_identity AS sourceIdentity
               FROM osfo_reminder_occurrences occurrence
               JOIN osfo_reminders reminder ON reminder.reminder_id = occurrence.reminder_id
              WHERE occurrence.owner_user_id = ? AND occurrence.source_identity = ?
                AND occurrence.committed_at IS NOT NULL AND occurrence.exposed_at IS NULL
                AND occurrence.blocked_at IS NULL AND occurrence.canceled_at IS NULL
                AND occurrence.source_revoked_at IS NULL
                AND reminder.revision = occurrence.revision
                AND reminder.state IN ('active', 'completed') LIMIT 1`,
            ownerUserId,
            sourceIdentity,
          )
          .toArray()[0],
    );

  const exposeSources = (ownerUserId: UserIdType, sources: ReadonlyArray<string>, now: Date) =>
    attempt("sources.expose", () =>
      raw.transactionSync(() => {
        for (const sourceIdentity of sources) {
          raw.sql.exec(
            `UPDATE osfo_reminder_occurrences SET exposed_at = ?
              WHERE owner_user_id = ? AND source_identity = ? AND exposed_at IS NULL`,
            now.toISOString(),
            ownerUserId,
            sourceIdentity,
          );
        }
      }),
    );

  const verificationState = (ownerUserId: UserIdType) =>
    attempt("verification.inspect", () => {
      const reminderCount = raw.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM osfo_reminders WHERE owner_user_id = ?`,
          ownerUserId,
        )
        .one().count;
      const activeScheduleBindingCount = raw.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM osfo_reminders
            WHERE owner_user_id = ? AND state = 'active'
              AND scheduler_id IS NOT NULL AND callback_capability IS NOT NULL`,
          ownerUserId,
        )
        .one().count;
      const occurrences = Schema.decodeUnknownSync(Schema.Array(VerificationOccurrenceRow))(
        raw.sql
          .exec(
            `SELECT callback_capability_revoked_at AS callbackCapabilityRevokedAt,
                    committed_at AS committedAt, exposed_at AS exposedAt,
                    nominal_due_at AS nominalDueAt, source_identity AS sourceIdentity,
                    source_revoked_at AS sourceRevokedAt,
                    think_presented_at AS thinkPresentedAt,
                    think_submission_id AS thinkSubmissionId
               FROM osfo_reminder_occurrences
              WHERE owner_user_id = ?
              ORDER BY nominal_due_at, source_identity`,
            ownerUserId,
          )
          .toArray(),
      );
      return {
        activeScheduleBindingCount,
        occurrenceCount: occurrences.length,
        occurrences,
        reminderCount,
      };
    });

  const claimThinkExposures = (
    ownerUserId: UserIdType,
    submissionId: ThinkSubmissionId,
    now: Date,
  ) =>
    attempt("sources.claimThinkExposures", () =>
      raw.transactionSync(() => {
        raw.sql.exec(
          `UPDATE osfo_reminder_occurrences AS occurrence
              SET think_presented_at = ?, think_submission_id = ?
            WHERE occurrence.owner_user_id = ? AND occurrence.exposed_at IS NOT NULL
              AND occurrence.think_presented_at IS NULL AND occurrence.blocked_at IS NULL
              AND occurrence.canceled_at IS NULL AND occurrence.source_revoked_at IS NULL
              AND EXISTS (
                SELECT 1 FROM osfo_reminders reminder
                 WHERE reminder.reminder_id = occurrence.reminder_id
                   AND reminder.revision = occurrence.revision
                   AND reminder.state IN ('active', 'completed')
              )`,
          now.toISOString(),
          submissionId,
          ownerUserId,
        );
        return Schema.decodeUnknownSync(Schema.Array(ThinkExposureRow))(
          raw.sql
            .exec(
              `SELECT occurrence.body_snapshot AS body,
                      occurrence.committed_at AS committedAt,
                      occurrence.source_identity AS sourceIdentity
                 FROM osfo_reminder_occurrences occurrence
                 JOIN osfo_reminders reminder ON reminder.reminder_id = occurrence.reminder_id
                WHERE occurrence.owner_user_id = ? AND occurrence.think_submission_id = ?
                  AND occurrence.blocked_at IS NULL AND occurrence.canceled_at IS NULL
                  AND occurrence.source_revoked_at IS NULL
                  AND reminder.revision = occurrence.revision
                  AND reminder.state IN ('active', 'completed')
                ORDER BY occurrence.committed_at, occurrence.source_identity`,
              ownerUserId,
              submissionId,
            )
            .toArray(),
        );
      }),
    );

  const fenceDeletion = (ownerUserId: UserIdType, now: Date) =>
    attempt("delete.fence", () =>
      raw.transactionSync(() => {
        const reminders = Schema.decodeUnknownSync(Schema.Array(DeletionReminderRow))(
          raw.sql
            .exec(
              `SELECT scheduler_id AS schedulerId FROM osfo_reminders WHERE owner_user_id = ?`,
              ownerUserId,
            )
            .toArray(),
        );
        const sources = Schema.decodeUnknownSync(Schema.Array(DeletionSourceRow))(
          raw.sql
            .exec(
              `SELECT source_identity AS sourceIdentity FROM osfo_reminder_occurrences
                WHERE owner_user_id = ? AND committed_at IS NOT NULL`,
              ownerUserId,
            )
            .toArray(),
        );
        raw.sql.exec(
          `UPDATE osfo_reminders SET revision = revision + 1, state = 'canceled',
                  next_due_at = NULL, callback_capability = NULL,
                  scheduler_id = NULL, updated_at = ?
            WHERE owner_user_id = ?`,
          now.toISOString(),
          ownerUserId,
        );
        raw.sql.exec(
          `UPDATE osfo_reminder_occurrences
              SET source_revoked_at = COALESCE(source_revoked_at, ?),
                  callback_capability_revoked_at = COALESCE(callback_capability_revoked_at, ?),
                  disposition_reason = 'accountDeletion'
            WHERE owner_user_id = ? AND committed_at IS NOT NULL`,
          now.toISOString(),
          now.toISOString(),
          ownerUserId,
        );
        return { reminders, sources };
      }),
    );

  const eraseUser = (ownerUserId: UserIdType) =>
    attempt("delete.erase", () => {
      raw.sql.exec(`DELETE FROM osfo_reminders WHERE owner_user_id = ?`, ownerUserId);
    });

  const readActiveSchedules = () =>
    queryArray("reconcileSchedules.inspect", ActiveScheduleRow, () =>
      raw.sql
        .exec(
          `SELECT reminder_id AS reminderId, owner_user_id AS ownerUserId,
                  callback_capability AS callbackCapability, revision,
                  next_due_at AS nextDueAt, scheduler_id AS schedulerId
             FROM osfo_reminders WHERE state = 'active' AND next_due_at IS NOT NULL
            ORDER BY created_at, reminder_id`,
        )
        .toArray(),
    );

  const clearScheduleBinding = (row: ActiveScheduleRow, now: Date) =>
    attempt("reconcileSchedules.clearBinding", () => {
      raw.sql.exec(
        `UPDATE osfo_reminders SET callback_capability = NULL, scheduler_id = NULL, updated_at = ?
          WHERE reminder_id = ? AND revision = ? AND state = 'active' AND next_due_at = ?`,
        now.toISOString(),
        row.reminderId,
        row.revision,
        row.nextDueAt.toISOString(),
      );
    });

  const pauseExcess = (ownerUserId: UserIdType, activeLimit: number, now: Date) =>
    attempt("reconcileActiveLimit.persist", () =>
      raw.transactionSync(() => {
        const rows = raw.sql
          .exec(
            `SELECT reminder_id AS reminderId, scheduler_id AS schedulerId
               FROM osfo_reminders WHERE owner_user_id = ? AND state = 'active'
              ORDER BY created_at, reminder_id`,
            ownerUserId,
          )
          .toArray()
          .slice(activeLimit);
        const decoded = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({ reminderId: ReminderId, schedulerId: Schema.NullOr(Schema.String) }),
          ),
        )(rows);
        const sources = decoded.flatMap((reminder) =>
          cancelCommittedSources(
            raw,
            ownerUserId,
            reminder.reminderId,
            raw.sql
              .exec<{ revision: number }>(
                `SELECT revision FROM osfo_reminders WHERE reminder_id = ?`,
                reminder.reminderId,
              )
              .one().revision,
            now,
          ),
        );
        for (const reminder of decoded) {
          raw.sql.exec(
            `UPDATE osfo_reminders SET state = 'paused', callback_capability = NULL,
                    scheduler_id = NULL, updated_at = ?
              WHERE owner_user_id = ? AND reminder_id = ? AND state = 'active'`,
            now.toISOString(),
            ownerUserId,
            reminder.reminderId,
          );
        }
        return { reminders: decoded, sources };
      }),
    );

  return {
    bindSchedule,
    clearScheduleBinding,
    commitOccurrence,
    countActive,
    eraseUser,
    exposeSources,
    fenceDeletion,
    inspect,
    inspectSource,
    markOccurrenceStep,
    pauseExcess,
    pendingSources,
    persistCancel,
    persistCreate,
    persistMutation,
    readActiveSchedules,
    readDueReminder,
    readOccurrence,
    revokeOccurrence,
    claimThinkExposures,
    retainDisposition,
    verificationState,
  };
};

export class ReminderStorageUnavailable extends Schema.TaggedError<ReminderStorageUnavailable>()(
  "ReminderStorageUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

const attempt = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new ReminderStorageUnavailable({ cause, operation }),
  });

const queryOptional = <A, I>(operation: string, schema: Schema.Codec<A, I>, run: () => unknown) =>
  attempt(operation, run).pipe(
    Effect.flatMap((row) =>
      row === undefined
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(schema)(row).pipe(
            Effect.mapError(
              (cause) =>
                new ReminderStorageUnavailable({ cause, operation: `${operation}.decode` }),
            ),
          ),
    ),
  );

const queryArray = <A, I>(operation: string, schema: Schema.Codec<A, I>, run: () => unknown) =>
  attempt(operation, run).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))),
    Effect.mapError((cause) =>
      Schema.is(ReminderStorageUnavailable)(cause)
        ? cause
        : new ReminderStorageUnavailable({ cause, operation: `${operation}.decode` }),
    ),
  );

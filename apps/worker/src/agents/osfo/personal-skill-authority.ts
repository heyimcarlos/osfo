/* oxlint-disable eslint/no-underscore-dangle -- Effect and domain tagged unions use _tag. */
/* oxlint-disable effecttsgo/crypto-random-uuid, effecttsgo/crypto-random-uuid-in-effect -- UUIDs are opaque durable identities, not deterministic test inputs. */
/* oxlint-disable osfo/no-unknown-parameters -- The decoder helpers are the owning persistence and model trust boundaries. */
/* oxlint-disable effecttsgo/instance-of-schema -- The error channel intentionally preserves an already decoded domain error. */
/* oxlint-disable effecttsgo/prefer-typed-schema-decoder, effecttsgo/schema-sync-in-effect -- Persistence rows and encoded JSON cross an untyped Durable SQLite boundary. */

import { Effect, Result, Schema } from "effect";

import { UserId } from "../../domain";
import { CapabilityId, currentCapabilityCatalog } from "../../domain/capability-catalog";
import {
  type PersonalSkillId,
  PersonalSkillVersion,
  PersonalSkillVersionId,
  SkillAvailabilityRequirement,
  SkillLearningCandidate,
  SkillLearningCandidateId,
  type SkillLearningModelAttemptId,
  type SkillEvidenceReference,
  decodePersonalSkillVersion,
  personalSkillVersionValues,
} from "../../domain/personal-skill";

/** Narrow Durable SQLite operations required by the personal Skill authority. */
export interface PersonalSkillAuthorityStorage {
  readonly sql: Pick<SqlStorage, "exec">;
  readonly transactionSync: <A>(transaction: () => A) => A;
}

/** Current facts that must hold before a personal Skill revision can activate. */
export interface PersonalSkillAvailability {
  readonly capabilityIds: ReadonlyArray<CapabilityId>;
  readonly requirements: ReadonlyArray<SkillAvailabilityRequirement>;
}

interface VersionMutationInput {
  readonly availability: PersonalSkillAvailability;
  readonly version: unknown;
}

export interface RevisePersonalSkillInput extends VersionMutationInput {
  readonly expectedSkillVersion: PersonalSkillVersionId;
}

export interface InspectPersonalSkillInput {
  readonly skillId: PersonalSkillId;
  readonly userId: UserId;
}

export interface PinPersonalSkillInput extends InspectPersonalSkillInput {
  readonly skillVersion?: PersonalSkillVersionId;
}

interface LifecycleMutationInput extends InspectPersonalSkillInput {
  readonly evidence: ReadonlyArray<SkillEvidenceReference>;
  readonly expectedSkillVersion: PersonalSkillVersionId;
  readonly nowEpochMillis: number;
}

export interface RestorePersonalSkillInput extends LifecycleMutationInput {
  readonly availability: PersonalSkillAvailability;
}

export interface RollbackPersonalSkillInput extends RestorePersonalSkillInput {
  readonly targetSkillVersion: PersonalSkillVersionId;
}

export interface DeletePersonalSkillInput extends InspectPersonalSkillInput {
  readonly expectedSkillVersion: PersonalSkillVersionId;
}

export interface RecordPersonalSkillUseInput extends InspectPersonalSkillInput {
  readonly nowEpochMillis: number;
  readonly skillVersion: PersonalSkillVersionId;
}

export interface PersonalSkillLearningLoad {
  readonly concurrentJobsForUser: number;
  readonly concurrentJobsGlobally: number;
  readonly jobsInRollingDay: number;
  readonly retainedSkillHistoryBytes: bigint;
  readonly retainedSkills: number;
}

export interface ClaimSkillLearningInput {
  readonly candidateId: SkillLearningCandidateId;
  readonly claimToken: string;
  readonly leaseMilliseconds: number;
  readonly nowEpochMillis: number;
  readonly userId: UserId;
}

export interface SettleSkillLearningInput {
  readonly candidateId: SkillLearningCandidateId;
  readonly claimToken: string;
  readonly nowEpochMillis: number;
  readonly status: "accepted" | "rejected";
  readonly userId: UserId;
}

export interface RecordSkillLearningCostInput {
  readonly attemptId: SkillLearningModelAttemptId;
  readonly basis: "conservative" | "observed";
  readonly candidateId: SkillLearningCandidateId;
  readonly modelInputTokens: number;
  readonly modelOutputTokens: number;
  readonly outcome: "failure" | "success";
  readonly recordedAtEpochMillis: number;
  readonly userId: UserId;
  readonly vendorUsdMicros: number;
}

export interface ActivateSkillLearningInput extends SettleSkillLearningInput {
  readonly availability: PersonalSkillAvailability;
  readonly expectedSkillVersion: PersonalSkillVersionId | null;
  readonly notification: string | null;
  readonly undoTargetSkillVersion: PersonalSkillVersionId | null;
  readonly version: unknown;
}

export interface PendingSkillLearningNotification {
  readonly candidate: SkillLearningCandidate;
  readonly notification: string;
  readonly undoTargetSkillVersion: PersonalSkillVersionId | null;
  readonly version: PersonalSkillVersion;
}

export interface MarkSkillLearningNotificationDeliveredInput {
  readonly candidateId: SkillLearningCandidateId;
  readonly deliveredAtEpochMillis: number;
  readonly skillVersion: PersonalSkillVersionId;
  readonly userId: UserId;
}

export type SkillLearningClaim =
  | {
      readonly _tag: "Busy";
      readonly candidateId: SkillLearningCandidateId;
    }
  | {
      readonly _tag: "Claimed";
      readonly attempts: number;
      readonly candidate: SkillLearningCandidate;
      readonly claimToken: string;
    }
  | {
      readonly _tag: "Settled";
      readonly candidateId: SkillLearningCandidateId;
      readonly status: "accepted" | "rejected";
    };

export interface PersonalSkillInspection {
  readonly current: PersonalSkillVersion;
  readonly versions: ReadonlyArray<PersonalSkillVersion>;
}

/** Expected failure when a Skill version cannot enter the immutable authority. */
export class PersonalSkillInvalid extends Schema.TaggedError<PersonalSkillInvalid>()(
  "PersonalSkillInvalid",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    reason: Schema.Literals(["envelope", "transition"]),
  },
) {}

/** Expected failure when current runtime facts cannot satisfy a Skill revision. */
export class PersonalSkillUnavailable extends Schema.TaggedError<PersonalSkillUnavailable>()(
  "PersonalSkillUnavailable",
  {
    capabilityIds: Schema.Array(CapabilityId),
    message: Schema.String,
    requirements: Schema.Array(SkillAvailabilityRequirement),
  },
) {}

/** Expected absence scoped to the authenticated User. */
export class PersonalSkillNotFound extends Schema.TaggedError<PersonalSkillNotFound>()(
  "PersonalSkillNotFound",
  {
    message: Schema.String,
    skillId: Schema.String,
  },
) {}

/** Compare-and-set failure from a stale Skill writer. */
export class PersonalSkillConflict extends Schema.TaggedError<PersonalSkillConflict>()(
  "PersonalSkillConflict",
  {
    actualSkillVersion: Schema.NullOr(Schema.String),
    expectedSkillVersion: Schema.NullOr(Schema.String),
    message: Schema.String,
    skillId: Schema.String,
  },
) {}

/** Claim or idempotency conflict for one bounded learning candidate. */
export class SkillLearningConflict extends Schema.TaggedError<SkillLearningConflict>()(
  "SkillLearningConflict",
  {
    candidateId: Schema.String,
    message: Schema.String,
  },
) {}

/** Expected Agent SQLite failure at the personal Skill authority seam. */
export class PersonalSkillStoreUnavailable extends Schema.TaggedError<PersonalSkillStoreUnavailable>()(
  "PersonalSkillStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals([
      "active",
      "activateLearning",
      "archive",
      "create",
      "delete",
      "deleteUserData",
      "claimLearning",
      "enqueueLearning",
      "inspect",
      "learningLoad",
      "markLearningNotificationDelivered",
      "pendingLearningNotifications",
      "pin",
      "recordUse",
      "recordLearningCost",
      "recoverableLearning",
      "restore",
      "revise",
      "rollback",
      "releaseLearning",
      "settleLearning",
    ]),
  },
) {}

type AuthorityError =
  | PersonalSkillConflict
  | PersonalSkillInvalid
  | PersonalSkillNotFound
  | PersonalSkillStoreUnavailable
  | PersonalSkillUnavailable;
type LearningAuthorityError =
  | PersonalSkillInvalid
  | PersonalSkillStoreUnavailable
  | SkillLearningConflict;

/** Deep User-scoped interface over immutable personal Skill state. */
export interface Interface {
  readonly active: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<PersonalSkillVersion>, AuthorityError>;
  readonly activateLearning: (
    input: Omit<ActivateSkillLearningInput, "status">,
  ) => Effect.Effect<
    { readonly _tag: "Created" | "Revised"; readonly version: PersonalSkillVersion },
    AuthorityError | SkillLearningConflict
  >;
  readonly create: (
    input: VersionMutationInput,
  ) => Effect.Effect<
    { readonly _tag: "Created"; readonly version: PersonalSkillVersion },
    AuthorityError
  >;
  readonly claimLearning: (
    input: ClaimSkillLearningInput,
  ) => Effect.Effect<SkillLearningClaim, LearningAuthorityError>;
  readonly archive: (
    input: LifecycleMutationInput,
  ) => Effect.Effect<
    { readonly _tag: "Archived"; readonly version: PersonalSkillVersion },
    AuthorityError
  >;
  readonly delete: (
    input: DeletePersonalSkillInput,
  ) => Effect.Effect<
    { readonly _tag: "Deleted"; readonly skillId: PersonalSkillId },
    AuthorityError
  >;
  readonly deleteUserData: (userId: UserId) => Effect.Effect<void, PersonalSkillStoreUnavailable>;
  readonly enqueueLearning: (candidate: SkillLearningCandidate) => Effect.Effect<
    {
      readonly _tag: "AlreadyQueued" | "Backpressured" | "Queued";
      readonly candidateId: SkillLearningCandidateId;
    },
    LearningAuthorityError
  >;
  readonly inspect: (
    input: InspectPersonalSkillInput,
  ) => Effect.Effect<PersonalSkillInspection, AuthorityError>;
  readonly learningLoad: (
    userId: UserId,
    nowEpochMillis: number,
  ) => Effect.Effect<PersonalSkillLearningLoad, PersonalSkillStoreUnavailable>;
  readonly markLearningNotificationDelivered: (
    input: MarkSkillLearningNotificationDeliveredInput,
  ) => Effect.Effect<void, LearningAuthorityError>;
  readonly pendingLearningNotifications: Effect.Effect<
    ReadonlyArray<PendingSkillLearningNotification>,
    PersonalSkillStoreUnavailable
  >;
  readonly pin: (
    input: PinPersonalSkillInput,
  ) => Effect.Effect<PersonalSkillVersion, AuthorityError>;
  readonly recordUse: (input: RecordPersonalSkillUseInput) => Effect.Effect<void, AuthorityError>;
  readonly recordLearningCost: (
    input: RecordSkillLearningCostInput,
  ) => Effect.Effect<void, LearningAuthorityError>;
  readonly recoverableLearning: (
    nowEpochMillis: number,
  ) => Effect.Effect<ReadonlyArray<SkillLearningCandidate>, PersonalSkillStoreUnavailable>;
  readonly releaseLearning: (
    input: Omit<SettleSkillLearningInput, "status">,
  ) => Effect.Effect<void, LearningAuthorityError>;
  readonly restore: (
    input: RestorePersonalSkillInput,
  ) => Effect.Effect<
    { readonly _tag: "Restored"; readonly version: PersonalSkillVersion },
    AuthorityError
  >;
  readonly revise: (
    input: RevisePersonalSkillInput,
  ) => Effect.Effect<
    { readonly _tag: "Revised"; readonly version: PersonalSkillVersion },
    AuthorityError
  >;
  readonly rollback: (
    input: RollbackPersonalSkillInput,
  ) => Effect.Effect<
    { readonly _tag: "RolledBack"; readonly version: PersonalSkillVersion },
    AuthorityError
  >;
  readonly settleLearning: (
    input: SettleSkillLearningInput,
  ) => Effect.Effect<void, LearningAuthorityError>;
}

const RootRow = Schema.Struct({
  currentRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  currentSkillVersion: Schema.String,
  lastUsedAtEpochMillis: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ownerUserId: UserId,
  skillId: Schema.String,
  status: Schema.Literals(["active", "archived"]),
});

type RootRow = typeof RootRow.Type;

const VersionRow = Schema.Struct({ versionJson: Schema.String });
const ActiveVersionRow = Schema.Struct({
  lastUsedAtEpochMillis: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  versionJson: Schema.String,
});
const LearningRow = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  candidateJson: Schema.String,
  claimExpiresAtEpochMillis: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  claimToken: Schema.NullOr(Schema.String),
  ownerUserId: UserId,
  status: Schema.Literals(["accepted", "claimed", "pending", "rejected"]),
});
const LearningCostRow = Schema.Struct({
  basis: Schema.Literals(["conservative", "observed"]),
  candidateId: SkillLearningCandidateId,
  modelInputTokens: Schema.Int,
  modelOutputTokens: Schema.Int,
  outcome: Schema.Literals(["failure", "success"]),
  recordedAtEpochMillis: Schema.Int,
  vendorUsdMicros: Schema.Int,
});
const PendingLearningNotificationRow = Schema.Struct({
  candidateJson: Schema.String,
  notification: Schema.String,
  undoTargetSkillVersion: Schema.NullOr(PersonalSkillVersionId),
  versionJson: Schema.String,
});

/** Construct the sole Agent SQLite authority for personal Skill versions. */
export const makePersonalSkillAuthority = (storage: PersonalSkillAuthorityStorage): Interface => {
  const inspect = Effect.fn("PersonalSkillAuthority.inspect")(function* (
    input: InspectPersonalSkillInput,
  ) {
    const root = yield* readRoot(storage, input, "inspect");
    const versions = yield* readVersions(storage, input, "inspect");
    const current = versions.find(({ skillVersion }) => skillVersion === root.currentSkillVersion);
    if (current === undefined) {
      return yield* invalidStoredTransition(input.skillId, root.currentSkillVersion);
    }
    return {
      current: {
        ...personalSkillVersionValues(current),
        lastUsedAtEpochMillis: root.lastUsedAtEpochMillis,
      },
      versions,
    };
  });

  const lifecycleRevision = Effect.fn("PersonalSkillAuthority.lifecycleRevision")(function* (
    input: LifecycleMutationInput,
    status: "active" | "archived",
    createdBy: "rollback" | "user",
    target?: PersonalSkillVersion,
    availability?: PersonalSkillAvailability,
  ) {
    const inspection = yield* inspect(input);
    if (inspection.current.skillVersion !== input.expectedSkillVersion) {
      return yield* staleConflict(input.skillId, input.expectedSkillVersion, inspection.current);
    }
    const source = target ?? inspection.current;
    const revision = inspection.current.revision + 1;
    const next = PersonalSkillVersion.make({
      ...personalSkillVersionValues(source),
      createdBy,
      lastUsedAtEpochMillis: inspection.current.lastUsedAtEpochMillis,
      parentSkillVersion: inspection.current.skillVersion,
      revision,
      skillVersion: nextSkillVersionId(revision),
      status,
      updatedAtEpochMillis: input.nowEpochMillis,
      updateEvidence: [...input.evidence],
    });
    if (availability !== undefined) yield* validateActivation(next, availability);
    const revised = yield* revisePersisted(storage, {
      expectedSkillVersion: input.expectedSkillVersion,
      version: next,
    });
    return revised.version;
  });

  return {
    active: Effect.fn("PersonalSkillAuthority.active")(function* (userId: UserId) {
      const rows = yield* attempt("active", () =>
        storage.sql
          .exec(
            `SELECT v.version_json AS versionJson,
                    s.last_used_at_epoch_millis AS lastUsedAtEpochMillis
             FROM osfo_personal_skills s
             JOIN osfo_personal_skill_versions v
               ON v.skill_id = s.skill_id AND v.revision = s.current_revision
             WHERE s.owner_user_id = ? AND s.status = 'active'
             ORDER BY s.skill_id`,
            userId,
          )
          .toArray(),
      );
      const activeRows = yield* Schema.decodeUnknownEffect(Schema.Array(ActiveVersionRow))(
        rows,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PersonalSkillInvalid({
              cause,
              message: "Agent SQLite returned invalid personal Skill selection metadata",
              reason: "envelope",
            }),
        ),
      );
      return yield* Effect.forEach(activeRows, ({ lastUsedAtEpochMillis, versionJson }) =>
        decodeVersionJson(versionJson, "active").pipe(
          Effect.map((version) => ({
            ...personalSkillVersionValues(version),
            lastUsedAtEpochMillis,
          })),
        ),
      );
    }),
    activateLearning: Effect.fn("PersonalSkillAuthority.activateLearning")(function* (input) {
      const version = yield* decodeVersion(input.version);
      yield* validateActivation(version, input.availability);
      if (version.ownerUserId !== input.userId) {
        return yield* learningConflict(
          input.candidateId,
          "A learning claim cannot activate another User's Skill",
        );
      }
      const retainedClaim = yield* attempt("activateLearning", () =>
        selectLearning(storage, input.candidateId, input.userId),
      );
      if (retainedClaim === undefined) {
        return yield* learningConflict(input.candidateId, "The learning candidate does not exist");
      }
      const candidate = yield* decodeLearningJson(retainedClaim.candidateJson);
      if (!learnedVersionMatchesCandidate(version, candidate, input.expectedSkillVersion)) {
        return yield* learningConflict(
          input.candidateId,
          "The learned revision is not bound to the claimed trusted evidence",
        );
      }
      const outcome = yield* attempt("activateLearning", () =>
        storage.transactionSync(() => {
          const learning = selectLearning(storage, input.candidateId, input.userId);
          if (
            learning === undefined ||
            learning.status !== "claimed" ||
            learning.claimToken !== input.claimToken ||
            learning.claimExpiresAtEpochMillis === null ||
            learning.claimExpiresAtEpochMillis < input.nowEpochMillis
          ) {
            return { _tag: "ClaimLost" as const };
          }
          const current = selectRoot(storage, version.skillId);
          if (input.expectedSkillVersion === null) {
            if (current !== undefined) return { _tag: "Stale" as const, current };
            if (
              version.revision !== 1 ||
              version.parentSkillVersion !== null ||
              version.status !== "active"
            ) {
              return { _tag: "Invalid" as const };
            }
            storage.sql.exec(
              `INSERT INTO osfo_personal_skills
                 (skill_id, owner_user_id, current_revision, current_skill_version,
                  last_used_at_epoch_millis, status)
               VALUES (?, ?, ?, ?, ?, ?)`,
              version.skillId,
              version.ownerUserId,
              version.revision,
              version.skillVersion,
              version.lastUsedAtEpochMillis,
              version.status,
            );
            insertVersion(storage, version);
          } else {
            if (current === undefined || current.ownerUserId !== version.ownerUserId) {
              return { _tag: "NotFound" as const };
            }
            if (current.currentSkillVersion !== input.expectedSkillVersion) {
              return { _tag: "Stale" as const, current };
            }
            if (
              version.revision !== current.currentRevision + 1 ||
              version.parentSkillVersion !== input.expectedSkillVersion
            ) {
              return { _tag: "Invalid" as const };
            }
            insertVersion(storage, version);
            storage.sql.exec(
              `UPDATE osfo_personal_skills
               SET current_revision = ?, current_skill_version = ?, status = ?
               WHERE skill_id = ? AND owner_user_id = ? AND current_skill_version = ?`,
              version.revision,
              version.skillVersion,
              version.status,
              version.skillId,
              version.ownerUserId,
              input.expectedSkillVersion,
            );
          }
          const settled = storage.sql
            .exec(
              `UPDATE osfo_personal_skill_learning_candidates
               SET status = 'accepted', claim_token = NULL,
                   claim_expires_at_epoch_millis = NULL, accepted_skill_version = ?,
                   notification_text = ?, notification_delivered_at_epoch_millis = NULL,
                   undo_target_skill_version = ?, updated_at_epoch_millis = ?
               WHERE candidate_id = ? AND owner_user_id = ? AND status = 'claimed'
                 AND claim_token = ?
               RETURNING candidate_id AS candidateId`,
              version.skillVersion,
              input.notification,
              input.undoTargetSkillVersion,
              input.nowEpochMillis,
              input.candidateId,
              input.userId,
              input.claimToken,
            )
            .toArray();
          if (settled.length !== 1)
            throw new Error("The learning claim was lost during activation");
          return { _tag: input.expectedSkillVersion === null ? "Created" : "Revised" } as const;
        }),
      );
      if (outcome._tag === "ClaimLost") {
        return yield* learningConflict(
          input.candidateId,
          "The learning claim is no longer current",
        );
      }
      if (outcome._tag === "NotFound") return yield* notFound(version.skillId);
      if (outcome._tag === "Stale") {
        return yield* new PersonalSkillConflict({
          actualSkillVersion: outcome.current.currentSkillVersion,
          expectedSkillVersion: input.expectedSkillVersion,
          message: "A later personal Skill revision already won",
          skillId: version.skillId,
        });
      }
      if (outcome._tag === "Invalid") {
        return yield* invalidTransition(
          "A learned revision must name the current parent and advance by exactly one",
          version,
        );
      }
      return { _tag: outcome._tag, version };
    }),
    archive: Effect.fn("PersonalSkillAuthority.archive")(function* (input) {
      const revision = yield* lifecycleRevision(input, "archived", "user");
      return { _tag: "Archived", version: revision } as const;
    }),
    claimLearning: Effect.fn("PersonalSkillAuthority.claimLearning")(function* (
      input: ClaimSkillLearningInput,
    ) {
      if (input.leaseMilliseconds <= 0 || !Number.isSafeInteger(input.leaseMilliseconds)) {
        return yield* learningConflict(input.candidateId, "The learning lease is invalid");
      }
      const outcome = yield* attempt("claimLearning", () =>
        storage.transactionSync(() => {
          const activeForUser = storage.sql
            .exec(
              `SELECT COUNT(*) AS count
               FROM osfo_personal_skill_learning_candidates
               WHERE owner_user_id = ? AND status = 'claimed'
                 AND claim_expires_at_epoch_millis > ?`,
              input.userId,
              input.nowEpochMillis,
            )
            .toArray();
          const activeCount =
            Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ count: Schema.Int })))(
              activeForUser,
            )[0]?.count ?? 0;
          if (activeCount >= currentCapabilityCatalog.skillLearning.concurrentJobsPerUser) {
            return { _tag: "Busy" as const };
          }
          const current = selectLearning(storage, input.candidateId, input.userId);
          if (current === undefined) return { _tag: "Missing" as const };
          if (current.status === "accepted" || current.status === "rejected") {
            return { _tag: "Settled" as const, status: current.status };
          }
          if (
            current.status === "claimed" &&
            current.claimExpiresAtEpochMillis !== null &&
            current.claimExpiresAtEpochMillis > input.nowEpochMillis
          ) {
            return { _tag: "Busy" as const };
          }
          const claimed = storage.sql
            .exec(
              `UPDATE osfo_personal_skill_learning_candidates
               SET attempts = attempts + 1, status = 'claimed', claim_token = ?,
                   claim_expires_at_epoch_millis = ?, updated_at_epoch_millis = ?
               WHERE candidate_id = ? AND owner_user_id = ?
                 AND (status = 'pending' OR
                      (status = 'claimed' AND claim_expires_at_epoch_millis <= ?))
               RETURNING attempts, candidate_json AS candidateJson`,
              input.claimToken,
              input.nowEpochMillis + input.leaseMilliseconds,
              input.nowEpochMillis,
              input.candidateId,
              input.userId,
              input.nowEpochMillis,
            )
            .toArray();
          return claimed.length === 1
            ? { _tag: "Claimed" as const, row: claimed[0] }
            : { _tag: "Busy" as const };
        }),
      );
      if (outcome._tag === "Missing") {
        return yield* learningConflict(input.candidateId, "The learning candidate does not exist");
      }
      if (outcome._tag === "Busy") {
        return { _tag: "Busy", candidateId: input.candidateId } as const;
      }
      if (outcome._tag === "Settled") {
        return { _tag: "Settled", candidateId: input.candidateId, status: outcome.status } as const;
      }
      const claimed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ attempts: Schema.Int, candidateJson: Schema.String }),
      )(outcome.row).pipe(
        Effect.mapError(
          (cause) =>
            new PersonalSkillInvalid({
              cause,
              message: "Agent SQLite returned an invalid learning claim",
              reason: "envelope",
            }),
        ),
      );
      const candidate = yield* decodeLearningJson(claimed.candidateJson);
      return {
        _tag: "Claimed",
        attempts: claimed.attempts,
        candidate,
        claimToken: input.claimToken,
      } as const;
    }),
    create: Effect.fn("PersonalSkillAuthority.create")(function* (input: VersionMutationInput) {
      const version = yield* decodeVersion(input.version);
      yield* validateActivation(version, input.availability);
      if (
        version.revision !== 1 ||
        version.parentSkillVersion !== null ||
        version.status !== "active"
      ) {
        return yield* invalidTransition("A first Skill version must be active revision 1", version);
      }
      const outcome = yield* attempt("create", () =>
        storage.transactionSync(() => {
          const existing = selectRoot(storage, version.skillId);
          if (existing !== undefined) return existing;
          storage.sql.exec(
            `INSERT INTO osfo_personal_skills
               (skill_id, owner_user_id, current_revision, current_skill_version,
                last_used_at_epoch_millis, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            version.skillId,
            version.ownerUserId,
            version.revision,
            version.skillVersion,
            version.lastUsedAtEpochMillis,
            version.status,
          );
          insertVersion(storage, version);
          return undefined;
        }),
      );
      if (outcome !== undefined) {
        return yield* new PersonalSkillConflict({
          actualSkillVersion: outcome.currentSkillVersion,
          expectedSkillVersion: null,
          message: "The personal Skill already exists",
          skillId: version.skillId,
        });
      }
      return { _tag: "Created", version } as const;
    }),
    delete: Effect.fn("PersonalSkillAuthority.delete")(function* (input) {
      const outcome = yield* attempt("delete", () =>
        storage.transactionSync(() => {
          const current = selectRoot(storage, input.skillId);
          if (current === undefined || current.ownerUserId !== input.userId) {
            return { _tag: "NotFound" as const };
          }
          if (current.currentSkillVersion !== input.expectedSkillVersion) {
            return { _tag: "Stale" as const, current };
          }
          storage.sql.exec(
            `DELETE FROM osfo_personal_skill_learning_model_attempts
             WHERE candidate_id IN (
               SELECT candidate_id FROM osfo_personal_skill_learning_candidates
               WHERE owner_user_id = ? AND prior_skill_version IN
                 (SELECT skill_version FROM osfo_personal_skill_versions WHERE skill_id = ?)
             )`,
            input.userId,
            input.skillId,
          );
          storage.sql.exec(
            `DELETE FROM osfo_personal_skill_learning_candidates
             WHERE owner_user_id = ? AND prior_skill_version IN
               (SELECT skill_version FROM osfo_personal_skill_versions WHERE skill_id = ?)`,
            input.userId,
            input.skillId,
          );
          const deleted = storage.sql
            .exec(
              `DELETE FROM osfo_personal_skills
               WHERE skill_id = ? AND owner_user_id = ? AND current_skill_version = ?
               RETURNING skill_id AS skillId`,
              input.skillId,
              input.userId,
              input.expectedSkillVersion,
            )
            .toArray();
          if (deleted.length !== 1)
            throw new Error("Personal Skill delete compare-and-set was lost");
          return { _tag: "Deleted" as const };
        }),
      );
      if (outcome._tag === "NotFound") return yield* notFound(input.skillId);
      if (outcome._tag === "Stale") {
        return yield* new PersonalSkillConflict({
          actualSkillVersion: outcome.current.currentSkillVersion,
          expectedSkillVersion: input.expectedSkillVersion,
          message: "A later personal Skill revision already won",
          skillId: input.skillId,
        });
      }
      return { _tag: "Deleted", skillId: input.skillId } as const;
    }),
    deleteUserData: Effect.fn("PersonalSkillAuthority.deleteUserData")((userId: UserId) =>
      attempt("deleteUserData", () =>
        storage.transactionSync(() => {
          storage.sql.exec(
            `DELETE FROM osfo_personal_skill_learning_model_attempts
             WHERE candidate_id IN (
               SELECT candidate_id FROM osfo_personal_skill_learning_candidates
               WHERE owner_user_id = ?
             )`,
            userId,
          );
          storage.sql.exec(
            "DELETE FROM osfo_personal_skill_learning_candidates WHERE owner_user_id = ?",
            userId,
          );
          storage.sql.exec("DELETE FROM osfo_personal_skills WHERE owner_user_id = ?", userId);
        }),
      ),
    ),
    enqueueLearning: Effect.fn("PersonalSkillAuthority.enqueueLearning")(function* (
      input: SkillLearningCandidate,
    ) {
      const candidate = yield* SkillLearningCandidate.makeEffect(input).pipe(
        Effect.mapError(
          (cause) =>
            new PersonalSkillInvalid({
              cause,
              message: "The Skill Learning candidate is invalid",
              reason: "envelope",
            }),
        ),
      );
      const candidateJson = Schema.encodeSync(Schema.fromJsonString(SkillLearningCandidate))(
        candidate,
      );
      const outcome = yield* attempt("enqueueLearning", () =>
        storage.transactionSync(() => {
          const existing = selectLearning(storage, candidate.candidateId, candidate.ownerUserId);
          if (existing !== undefined) return existing.candidateJson;
          const pending = storage.sql
            .exec(
              `SELECT candidate_id AS candidateId
               FROM osfo_personal_skill_learning_candidates
               WHERE owner_user_id = ? AND status IN ('pending', 'claimed')
               ORDER BY created_at_epoch_millis DESC`,
              candidate.ownerUserId,
            )
            .toArray();
          if (pending.length >= currentCapabilityCatalog.skillLearning.candidatesPerUser) {
            const evictionCount =
              pending.length - currentCapabilityCatalog.skillLearning.candidatesPerUser + 1;
            const evictable = storage.sql
              .exec(
                `SELECT candidate_id AS candidateId
                 FROM osfo_personal_skill_learning_candidates
                 WHERE owner_user_id = ? AND status = 'pending'
                 ORDER BY created_at_epoch_millis ASC
                 LIMIT ?`,
                candidate.ownerUserId,
                evictionCount,
              )
              .toArray();
            if (evictable.length < evictionCount) return "Backpressured" as const;
            storage.sql.exec(
              `DELETE FROM osfo_personal_skill_learning_model_attempts
               WHERE candidate_id IN (
                 SELECT candidate_id FROM osfo_personal_skill_learning_candidates
                 WHERE owner_user_id = ? AND status = 'pending'
                 ORDER BY created_at_epoch_millis ASC
                 LIMIT ?
               )`,
              candidate.ownerUserId,
              evictionCount,
            );
            storage.sql.exec(
              `DELETE FROM osfo_personal_skill_learning_candidates
               WHERE candidate_id IN (
                 SELECT candidate_id FROM osfo_personal_skill_learning_candidates
                 WHERE owner_user_id = ? AND status = 'pending'
                 ORDER BY created_at_epoch_millis ASC
                 LIMIT ?
              )`,
              candidate.ownerUserId,
              evictionCount,
            );
          }
          storage.sql.exec(
            `INSERT INTO osfo_personal_skill_learning_candidates
               (attempts, candidate_id, candidate_json, claim_expires_at_epoch_millis,
                claim_token, created_at_epoch_millis, owner_user_id, prior_skill_version,
                status, updated_at_epoch_millis)
             VALUES (0, ?, ?, NULL, NULL, ?, ?, ?, 'pending', ?)`,
            candidate.candidateId,
            candidateJson,
            candidate.createdAtEpochMillis,
            candidate.ownerUserId,
            candidate.priorSkillVersion,
            candidate.createdAtEpochMillis,
          );
          return undefined;
        }),
      );
      if (outcome !== undefined && outcome !== candidateJson) {
        if (outcome === "Backpressured") {
          return { _tag: "Backpressured", candidateId: candidate.candidateId } as const;
        }
        return yield* learningConflict(
          candidate.candidateId,
          "The candidate identity already names different trusted evidence",
        );
      }
      return {
        _tag: outcome === undefined ? "Queued" : "AlreadyQueued",
        candidateId: candidate.candidateId,
      } as const;
    }),
    inspect,
    learningLoad: Effect.fn("PersonalSkillAuthority.learningLoad")(function* (
      userId: UserId,
      nowEpochMillis: number,
    ) {
      const rows = yield* attempt("learningLoad", () =>
        storage.sql
          .exec(
            `SELECT
               (SELECT COUNT(*) FROM osfo_personal_skills WHERE owner_user_id = ?) AS retainedSkills,
               (SELECT COALESCE(SUM(LENGTH(CAST(v.version_json AS BLOB))), 0)
                  FROM osfo_personal_skill_versions v
                  JOIN osfo_personal_skills s ON s.skill_id = v.skill_id
                 WHERE s.owner_user_id = ?) AS retainedSkillHistoryBytes,
               (SELECT COUNT(*) FROM osfo_personal_skill_learning_candidates
                 WHERE owner_user_id = ? AND created_at_epoch_millis >= ?) AS jobsInRollingDay,
               (SELECT COUNT(*) FROM osfo_personal_skill_learning_candidates
                 WHERE owner_user_id = ? AND status = 'claimed'
                   AND claim_expires_at_epoch_millis > ?) AS concurrentJobsForUser,
               0 AS concurrentJobsGlobally`,
            userId,
            userId,
            userId,
            nowEpochMillis - 86_400_000,
            userId,
            nowEpochMillis,
          )
          .toArray(),
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          concurrentJobsForUser: Schema.Int,
          concurrentJobsGlobally: Schema.Int,
          jobsInRollingDay: Schema.Int,
          retainedSkillHistoryBytes: Schema.Union([Schema.Int, Schema.BigInt]),
          retainedSkills: Schema.Int,
        }),
      )(rows[0]).pipe(
        Effect.mapError(
          (cause) =>
            new PersonalSkillStoreUnavailable({
              cause,
              message: "Agent SQLite returned invalid personal Skill learning load",
              operation: "learningLoad",
            }),
        ),
      );
      return {
        ...row,
        retainedSkillHistoryBytes: BigInt(row.retainedSkillHistoryBytes),
      };
    }),
    markLearningNotificationDelivered: Effect.fn(
      "PersonalSkillAuthority.markLearningNotificationDelivered",
    )(function* (input) {
      const updated = yield* attempt("markLearningNotificationDelivered", () =>
        storage.sql
          .exec(
            `UPDATE osfo_personal_skill_learning_candidates
             SET notification_delivered_at_epoch_millis =
               COALESCE(notification_delivered_at_epoch_millis, ?)
             WHERE candidate_id = ? AND owner_user_id = ? AND status = 'accepted'
               AND accepted_skill_version = ? AND notification_text IS NOT NULL
             RETURNING candidate_id AS candidateId`,
            input.deliveredAtEpochMillis,
            input.candidateId,
            input.userId,
            input.skillVersion,
          )
          .toArray(),
      );
      if (updated.length !== 1) {
        return yield* learningConflict(
          input.candidateId,
          "The durable Skill Learning notification no longer matches the accepted revision",
        );
      }
      return undefined;
    }),
    pendingLearningNotifications: Effect.gen(function* () {
      const rows = yield* attempt("pendingLearningNotifications", () =>
        storage.sql
          .exec(
            `SELECT c.candidate_json AS candidateJson,
                    c.notification_text AS notification,
                    c.undo_target_skill_version AS undoTargetSkillVersion,
                    v.version_json AS versionJson
             FROM osfo_personal_skill_learning_candidates c
             JOIN osfo_personal_skill_versions v
               ON v.skill_version = c.accepted_skill_version
             WHERE c.status = 'accepted' AND c.notification_text IS NOT NULL
               AND c.notification_delivered_at_epoch_millis IS NULL
             ORDER BY c.updated_at_epoch_millis, c.candidate_id`,
          )
          .toArray(),
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(PendingLearningNotificationRow),
      )(rows).pipe(
        Effect.mapError(
          (cause) =>
            new PersonalSkillStoreUnavailable({
              cause,
              message: "Agent SQLite returned invalid pending Skill Learning notifications",
              operation: "pendingLearningNotifications",
            }),
        ),
      );
      return yield* Effect.forEach(
        decoded,
        ({ candidateJson, notification, undoTargetSkillVersion, versionJson }) =>
          Effect.all({
            candidate: decodeLearningJson(candidateJson),
            version: decodeVersionJson(versionJson, "pendingLearningNotifications"),
          }).pipe(
            Effect.map(({ candidate, version }) => ({
              candidate,
              notification,
              undoTargetSkillVersion,
              version,
            })),
            Effect.mapError(
              (cause) =>
                new PersonalSkillStoreUnavailable({
                  cause,
                  message: "Agent SQLite retained an invalid Skill Learning notification",
                  operation: "pendingLearningNotifications",
                }),
            ),
          ),
      );
    }),
    pin: Effect.fn("PersonalSkillAuthority.pin")(function* (input: PinPersonalSkillInput) {
      const root = yield* readRoot(storage, input, "pin");
      if (input.skillVersion === undefined && root.status !== "active") {
        return yield* new PersonalSkillNotFound({
          message: "The personal Skill is not active",
          skillId: input.skillId,
        });
      }
      const skillVersion = input.skillVersion ?? root.currentSkillVersion;
      const rows = yield* attempt("pin", () =>
        storage.sql
          .exec(
            `SELECT v.version_json AS versionJson
             FROM osfo_personal_skill_versions v
             JOIN osfo_personal_skills s ON s.skill_id = v.skill_id
             WHERE s.owner_user_id = ? AND s.skill_id = ? AND v.skill_version = ?
             LIMIT 1`,
            input.userId,
            input.skillId,
            skillVersion,
          )
          .toArray(),
      );
      const versions = yield* decodeVersionRows(rows, "pin");
      const pinned = versions[0];
      if (pinned === undefined) {
        return yield* new PersonalSkillNotFound({
          message: "The requested personal Skill version does not exist for this User",
          skillId: input.skillId,
        });
      }
      return pinned;
    }),
    recordUse: Effect.fn("PersonalSkillAuthority.recordUse")(function* (
      input: RecordPersonalSkillUseInput,
    ) {
      const current = yield* readRoot(storage, input, "recordUse");
      if (current.currentSkillVersion !== input.skillVersion || current.status !== "active") {
        return yield* new PersonalSkillConflict({
          actualSkillVersion: current.currentSkillVersion,
          expectedSkillVersion: input.skillVersion,
          message: "Only the current active Skill version can record use",
          skillId: input.skillId,
        });
      }
      yield* attempt("recordUse", () =>
        storage.sql.exec(
          `UPDATE osfo_personal_skills
           SET last_used_at_epoch_millis = MAX(COALESCE(last_used_at_epoch_millis, 0), ?)
           WHERE skill_id = ? AND owner_user_id = ? AND current_skill_version = ?`,
          input.nowEpochMillis,
          input.skillId,
          input.userId,
          input.skillVersion,
        ),
      );
      return undefined;
    }),
    recordLearningCost: Effect.fn("PersonalSkillAuthority.recordLearningCost")(function* (input) {
      const outcome = yield* attempt("recordLearningCost", () =>
        storage.transactionSync(() => {
          if (selectLearning(storage, input.candidateId, input.userId) === undefined) {
            return "MissingCandidate" as const;
          }
          const existingRows = storage.sql
            .exec(
              `SELECT basis, candidate_id AS candidateId,
                      model_input_tokens AS modelInputTokens,
                      model_output_tokens AS modelOutputTokens, outcome,
                      recorded_at_epoch_millis AS recordedAtEpochMillis,
                      vendor_usd_micros AS vendorUsdMicros
               FROM osfo_personal_skill_learning_model_attempts
               WHERE attempt_id = ? LIMIT 1`,
              input.attemptId,
            )
            .toArray();
          const existing = Schema.decodeUnknownSync(Schema.Array(LearningCostRow))(existingRows)[0];
          if (existing !== undefined) {
            return costEvidenceMatches(existing, input)
              ? ("AlreadyRecorded" as const)
              : ("Conflict" as const);
          }
          const inserted = storage.sql
            .exec(
              `INSERT INTO osfo_personal_skill_learning_model_attempts
               (attempt_id, basis, candidate_id, model_input_tokens, model_output_tokens,
                outcome, recorded_at_epoch_millis, vendor_usd_micros)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING attempt_id AS attemptId`,
              input.attemptId,
              input.basis,
              input.candidateId,
              input.modelInputTokens,
              input.modelOutputTokens,
              input.outcome,
              input.recordedAtEpochMillis,
              input.vendorUsdMicros,
            )
            .toArray();
          return inserted.length === 1 ? ("Recorded" as const) : ("Conflict" as const);
        }),
      );
      if (outcome !== "Recorded" && outcome !== "AlreadyRecorded") {
        return yield* learningConflict(
          input.candidateId,
          outcome === "MissingCandidate"
            ? "The learning cost has no owned candidate"
            : "The learning model attempt already has different company-cost evidence",
        );
      }
      return undefined;
    }),
    recoverableLearning: Effect.fn("PersonalSkillAuthority.recoverableLearning")(function* (
      nowEpochMillis: number,
    ) {
      const rows = yield* attempt("recoverableLearning", () =>
        storage.sql
          .exec(
            `SELECT candidate_json AS candidateJson
             FROM osfo_personal_skill_learning_candidates
             WHERE status = 'pending'
                OR (status = 'claimed' AND claim_expires_at_epoch_millis <= ?)
             ORDER BY created_at_epoch_millis`,
            nowEpochMillis,
          )
          .toArray(),
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ candidateJson: Schema.String })),
      )(rows).pipe(
        Effect.mapError(
          (cause) =>
            new PersonalSkillStoreUnavailable({
              cause,
              message: "Agent SQLite returned invalid recoverable Skill Learning rows",
              operation: "recoverableLearning",
            }),
        ),
      );
      return yield* Effect.forEach(decoded, ({ candidateJson }) =>
        decodeLearningJson(candidateJson).pipe(
          Effect.mapError(
            (cause) =>
              new PersonalSkillStoreUnavailable({
                cause,
                message: "Agent SQLite returned an invalid recoverable learning candidate",
                operation: "recoverableLearning",
              }),
          ),
        ),
      );
    }),
    releaseLearning: Effect.fn("PersonalSkillAuthority.releaseLearning")((input) =>
      updateLearningStatus(storage, input, "pending", "releaseLearning"),
    ),
    restore: Effect.fn("PersonalSkillAuthority.restore")(function* (input) {
      const revision = yield* lifecycleRevision(
        input,
        "active",
        "user",
        undefined,
        input.availability,
      );
      return { _tag: "Restored", version: revision } as const;
    }),
    revise: Effect.fn("PersonalSkillAuthority.revise")(function* (input: RevisePersonalSkillInput) {
      const version = yield* decodeVersion(input.version);
      yield* validateActivation(version, input.availability);
      return yield* revisePersisted(storage, {
        expectedSkillVersion: input.expectedSkillVersion,
        version,
      });
    }),
    rollback: Effect.fn("PersonalSkillAuthority.rollback")(function* (input) {
      const target = yield* makePersonalSkillAuthority(storage).pin({
        skillId: input.skillId,
        skillVersion: input.targetSkillVersion,
        userId: input.userId,
      });
      const revision = yield* lifecycleRevision(
        input,
        "active",
        "rollback",
        target,
        input.availability,
      );
      return { _tag: "RolledBack", version: revision } as const;
    }),
    settleLearning: Effect.fn("PersonalSkillAuthority.settleLearning")((input) =>
      updateLearningStatus(storage, input, input.status, "settleLearning"),
    ),
  };
};

const decodeVersion = (input: unknown) => {
  const decoded = decodePersonalSkillVersion(input);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        new PersonalSkillInvalid({
          cause: decoded.failure,
          message: "The personal Skill envelope is invalid",
          reason: "envelope",
        }),
      );
};

const learnedVersionMatchesCandidate = (
  version: PersonalSkillVersion,
  candidate: SkillLearningCandidate,
  expectedSkillVersion: PersonalSkillVersionId | null,
): boolean => {
  if (
    version.ownerUserId !== candidate.ownerUserId ||
    version.origin !== "learned" ||
    version.createdBy !== "learning" ||
    version.parentSkillVersion !== expectedSkillVersion ||
    candidate.priorSkillVersion !== expectedSkillVersion ||
    (candidate.priorSkillId !== null && version.skillId !== candidate.priorSkillId)
  ) {
    return false;
  }
  const evidence =
    expectedSkillVersion === null ? version.creationEvidence : version.updateEvidence;
  return (
    evidence.length === candidate.evidence.length &&
    evidence.every((reference, index) => referenceEquals(reference, candidate.evidence[index])) &&
    evidence.some(
      (reference) =>
        reference._tag === "ConfirmedRootOutcome" &&
        reference.referenceId === candidate.rootOutcomeReferenceId,
    )
  );
};

const referenceEquals = (
  left: SkillEvidenceReference,
  right: SkillEvidenceReference | undefined,
): boolean =>
  right !== undefined && left._tag === right._tag && left.referenceId === right.referenceId;

const costEvidenceMatches = (
  retained: typeof LearningCostRow.Type,
  candidate: RecordSkillLearningCostInput,
): boolean =>
  retained.basis === candidate.basis &&
  retained.candidateId === candidate.candidateId &&
  retained.modelInputTokens === candidate.modelInputTokens &&
  retained.modelOutputTokens === candidate.modelOutputTokens &&
  retained.outcome === candidate.outcome &&
  retained.recordedAtEpochMillis === candidate.recordedAtEpochMillis &&
  retained.vendorUsdMicros === candidate.vendorUsdMicros;

const validateActivation = (
  version: PersonalSkillVersion,
  availability: PersonalSkillAvailability,
) => {
  const capabilities = new Set(availability.capabilityIds);
  const requirements = new Set(availability.requirements);
  const unavailableCapabilityIds = version.capabilityIds.filter((id) => !capabilities.has(id));
  const unavailableRequirements = version.requirements.filter((name) => !requirements.has(name));
  return unavailableCapabilityIds.length === 0 && unavailableRequirements.length === 0
    ? Effect.void
    : Effect.fail(
        new PersonalSkillUnavailable({
          capabilityIds: unavailableCapabilityIds,
          message: "The current Agent cannot activate every declared Skill requirement",
          requirements: unavailableRequirements,
        }),
      );
};

const insertVersion = (
  storage: PersonalSkillAuthorityStorage,
  version: PersonalSkillVersion,
): void => {
  storage.sql.exec(
    `INSERT INTO osfo_personal_skill_versions
       (skill_id, revision, skill_version, version_json)
     VALUES (?, ?, ?, ?)`,
    version.skillId,
    version.revision,
    version.skillVersion,
    JSON.stringify(version),
  );
};

const revisePersisted = Effect.fn("PersonalSkillAuthority.revisePersisted")(function* (
  storage: PersonalSkillAuthorityStorage,
  input: {
    readonly expectedSkillVersion: PersonalSkillVersionId;
    readonly version: PersonalSkillVersion;
  },
) {
  const version = input.version;
  const outcome = yield* attempt("revise", () =>
    storage.transactionSync(() => {
      const current = selectRoot(storage, version.skillId);
      if (current === undefined || current.ownerUserId !== version.ownerUserId) {
        return { _tag: "NotFound" as const };
      }
      if (current.currentSkillVersion !== input.expectedSkillVersion) {
        return { _tag: "Stale" as const, current };
      }
      if (
        version.revision !== current.currentRevision + 1 ||
        version.parentSkillVersion !== input.expectedSkillVersion
      ) {
        return { _tag: "Invalid" as const };
      }
      insertVersion(storage, version);
      const updated = storage.sql
        .exec(
          `UPDATE osfo_personal_skills
           SET current_revision = ?, current_skill_version = ?, status = ?
           WHERE skill_id = ? AND owner_user_id = ? AND current_skill_version = ?
           RETURNING skill_id AS skillId`,
          version.revision,
          version.skillVersion,
          version.status,
          version.skillId,
          version.ownerUserId,
          input.expectedSkillVersion,
        )
        .toArray();
      if (updated.length !== 1) throw new Error("Personal Skill compare-and-set was lost");
      return { _tag: "Revised" as const };
    }),
  );
  if (outcome._tag === "NotFound") return yield* notFound(version.skillId);
  if (outcome._tag === "Stale") {
    return yield* new PersonalSkillConflict({
      actualSkillVersion: outcome.current.currentSkillVersion,
      expectedSkillVersion: input.expectedSkillVersion,
      message: "A later personal Skill revision already won",
      skillId: version.skillId,
    });
  }
  if (outcome._tag === "Invalid") {
    return yield* invalidTransition(
      "A revision must name the current parent and advance by exactly one",
      version,
    );
  }
  return { _tag: "Revised", version } as const;
});

const selectRoot = (
  storage: PersonalSkillAuthorityStorage,
  skillId: PersonalSkillId,
): RootRow | undefined => {
  const rows = storage.sql
    .exec(
      `SELECT skill_id AS skillId, owner_user_id AS ownerUserId,
              current_revision AS currentRevision,
              current_skill_version AS currentSkillVersion,
              last_used_at_epoch_millis AS lastUsedAtEpochMillis, status
       FROM osfo_personal_skills WHERE skill_id = ? LIMIT 1`,
      skillId,
    )
    .toArray();
  const decoded = Schema.decodeUnknownResult(Schema.Array(RootRow))(rows);
  if (Result.isFailure(decoded)) throw decoded.failure;
  return decoded.success[0];
};

const selectLearning = (
  storage: PersonalSkillAuthorityStorage,
  candidateId: SkillLearningCandidateId,
  userId: UserId,
): typeof LearningRow.Type | undefined => {
  const rows = storage.sql
    .exec(
      `SELECT attempts, candidate_json AS candidateJson,
              claim_expires_at_epoch_millis AS claimExpiresAtEpochMillis,
              claim_token AS claimToken, owner_user_id AS ownerUserId, status
       FROM osfo_personal_skill_learning_candidates
       WHERE candidate_id = ? AND owner_user_id = ? LIMIT 1`,
      candidateId,
      userId,
    )
    .toArray();
  const decoded = Schema.decodeUnknownResult(Schema.Array(LearningRow))(rows);
  if (Result.isFailure(decoded)) throw decoded.failure;
  return decoded.success[0];
};

const decodeLearningJson = (
  candidateJson: string,
): Effect.Effect<SkillLearningCandidate, PersonalSkillInvalid> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(SkillLearningCandidate))(candidateJson).pipe(
    Effect.mapError(
      (cause) =>
        new PersonalSkillInvalid({
          cause,
          message: "Agent SQLite returned an invalid Skill Learning candidate",
          reason: "envelope",
        }),
    ),
  );

const updateLearningStatus = (
  storage: PersonalSkillAuthorityStorage,
  input: Omit<SettleSkillLearningInput, "status">,
  status: "accepted" | "pending" | "rejected",
  operation: "releaseLearning" | "settleLearning",
): Effect.Effect<void, PersonalSkillStoreUnavailable | SkillLearningConflict> =>
  attempt(operation, () =>
    storage.sql
      .exec(
        `UPDATE osfo_personal_skill_learning_candidates
         SET status = ?, claim_token = NULL, claim_expires_at_epoch_millis = NULL,
             updated_at_epoch_millis = ?
         WHERE candidate_id = ? AND owner_user_id = ? AND status = 'claimed' AND claim_token = ?
         RETURNING candidate_id AS candidateId`,
        status,
        input.nowEpochMillis,
        input.candidateId,
        input.userId,
        input.claimToken,
      )
      .toArray(),
  ).pipe(
    Effect.flatMap((rows) =>
      rows.length === 1
        ? Effect.void
        : Effect.fail(
            learningConflict(
              input.candidateId,
              "The Skill Learning claim is stale or belongs to another User",
            ),
          ),
    ),
  );

const readRoot = (
  storage: PersonalSkillAuthorityStorage,
  input: InspectPersonalSkillInput,
  operation: "inspect" | "pin" | "recordUse",
) =>
  attempt(operation, () => selectRoot(storage, input.skillId)).pipe(
    Effect.flatMap((root) =>
      root !== undefined && root.ownerUserId === input.userId
        ? Effect.succeed(root)
        : Effect.fail(
            new PersonalSkillNotFound({
              message: "The personal Skill does not exist for this User",
              skillId: input.skillId,
            }),
          ),
    ),
  );

const readVersions = (
  storage: PersonalSkillAuthorityStorage,
  input: InspectPersonalSkillInput,
  operation: "inspect",
) =>
  attempt(operation, () =>
    storage.sql
      .exec(
        `SELECT v.version_json AS versionJson
         FROM osfo_personal_skill_versions v
         JOIN osfo_personal_skills s ON s.skill_id = v.skill_id
         WHERE s.owner_user_id = ? AND s.skill_id = ? ORDER BY v.revision`,
        input.userId,
        input.skillId,
      )
      .toArray(),
  ).pipe(Effect.flatMap((rows) => decodeVersionRows(rows, operation)));

const decodeVersionRows = (
  rows: unknown,
  operation: "active" | "inspect" | "pendingLearningNotifications" | "pin",
): Effect.Effect<ReadonlyArray<PersonalSkillVersion>, PersonalSkillInvalid> =>
  Schema.decodeUnknownEffect(Schema.Array(VersionRow))(rows).pipe(
    Effect.flatMap((decodedRows) =>
      Effect.forEach(decodedRows, ({ versionJson }) => decodeVersionJson(versionJson, operation)),
    ),
    Effect.mapError((cause) =>
      cause instanceof PersonalSkillInvalid
        ? cause
        : new PersonalSkillInvalid({
            cause: { cause, operation },
            message: "Agent SQLite returned an invalid personal Skill row",
            reason: "envelope",
          }),
    ),
  );

const decodeVersionJson = (
  versionJson: string,
  operation: "active" | "inspect" | "pendingLearningNotifications" | "pin",
): Effect.Effect<PersonalSkillVersion, PersonalSkillInvalid> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(PersonalSkillVersion))(versionJson).pipe(
    Effect.mapError(
      (cause) =>
        new PersonalSkillInvalid({
          cause: { cause, operation },
          message: "Agent SQLite returned an invalid personal Skill version",
          reason: "envelope",
        }),
    ),
  );

const invalidTransition = (message: string, version: PersonalSkillVersion) =>
  new PersonalSkillInvalid({
    cause: { revision: version.revision, skillVersion: version.skillVersion },
    message,
    reason: "transition",
  });

const invalidStoredTransition = (skillId: PersonalSkillId, skillVersion: string) =>
  new PersonalSkillInvalid({
    cause: { skillId, skillVersion },
    message: "The current Skill pointer does not name a retained immutable version",
    reason: "transition",
  });

const staleConflict = (
  skillId: PersonalSkillId,
  expectedSkillVersion: PersonalSkillVersionId,
  actual: PersonalSkillVersion,
) =>
  new PersonalSkillConflict({
    actualSkillVersion: actual.skillVersion,
    expectedSkillVersion,
    message: "A later personal Skill revision already won",
    skillId,
  });

const notFound = (skillId: PersonalSkillId) =>
  new PersonalSkillNotFound({
    message: "The personal Skill does not exist for this User",
    skillId,
  });

const learningConflict = (candidateId: SkillLearningCandidateId, message: string) =>
  new SkillLearningConflict({ candidateId, message });

const nextSkillVersionId = (revision: number): PersonalSkillVersionId =>
  PersonalSkillVersionId.make(`v${revision}-${crypto.randomUUID()}`);

const attempt = <A>(
  operation:
    | "active"
    | "activateLearning"
    | "archive"
    | "claimLearning"
    | "create"
    | "delete"
    | "deleteUserData"
    | "enqueueLearning"
    | "inspect"
    | "learningLoad"
    | "markLearningNotificationDelivered"
    | "pendingLearningNotifications"
    | "pin"
    | "recordLearningCost"
    | "recordUse"
    | "recoverableLearning"
    | "releaseLearning"
    | "restore"
    | "revise"
    | "rollback"
    | "settleLearning",
  run: () => A,
): Effect.Effect<A, PersonalSkillStoreUnavailable> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new PersonalSkillStoreUnavailable({
        cause,
        message: "Agent SQLite could not complete the personal Skill operation",
        operation,
      }),
  });

export * as PersonalSkillAuthority from "./personal-skill-authority";

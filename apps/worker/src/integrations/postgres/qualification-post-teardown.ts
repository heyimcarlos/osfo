import {
  qualificationCohorts,
  qualificationCohortScrubDispatches,
  qualificationCohortScrubRoots,
} from "@osfo/db/schema/qualification-cohorts";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "@osfo/db";
import { qualificationCohortArtifactProtocol } from "../../qualification/cohort-artifact-authority-contract";
import { qualificationCohortRootArtifactKeys } from "../../qualification/cohort-artifact-layout";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import {
  qualificationCohortScrubDispatchBatchLimit,
  qualificationCohortScrubDispatchIdentity,
} from "../../qualification/cohort-scrub-dispatch";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-await-in-loop -- Drizzle and PostgreSQL timestamps are Promise/Date-native boundaries; claims are deliberately sequential on one connection. */

export const qualificationPostTeardownPublicationLeaseMilliseconds = 5 * 60 * 1_000;
export const qualificationPostTeardownPublicationMaximumBackoffMilliseconds = 60 * 60 * 1_000;

export class QualificationPostTeardownPublicationUnavailable extends Schema.TaggedError<QualificationPostTeardownPublicationUnavailable>()(
  "QualificationPostTeardownPublicationUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

export interface QualificationPostTeardownPublicationIdentity {
  readonly cohortId: string;
  readonly dispatchId: string;
  readonly executionId: string;
}

export type QualificationPostTeardownPublicationClaim =
  | ({
      readonly _tag: "Claimed";
      readonly attemptCount: number;
      readonly claimToken: string;
      readonly inputChecksum: string | null;
      readonly leaseExpiresAt: Date;
      readonly scrubState: "CONFLICT" | "SETTLED";
    } & QualificationPostTeardownPublicationIdentity)
  | { readonly _tag: "Busy"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Terminal";
      readonly artifactChecksum: string | null;
      readonly conflictChecksum: string | null;
      readonly state: "CONFLICT" | "INELIGIBLE" | "PUBLISHED";
    };

export type QualificationPostTeardownPublicationMutation =
  | { readonly _tag: "Applied" }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "LeaseExpired"; readonly leaseExpiresAt: Date };

export type QualificationPostTeardownAuthorityInspection =
  | {
      readonly _tag: "Ready";
      readonly allocationIdentityCount: 0;
      readonly artifactAuthorityProofChecksum: string;
      readonly artifactAuthorityProtocol: string;
      readonly cohortArtifactChecksum: string;
      readonly cohortArtifactId: string;
      readonly cohortId: string;
      readonly dispatchId: string;
      readonly dispatchProtocolVersion: string;
      readonly executionId: string;
      readonly expectedPageCount: number;
      readonly expectedParticipantCount: number;
      readonly finalPageChecksum: string;
      readonly manifestChecksum: string;
      readonly planChecksum: string;
      readonly provisionIdentityCount: 0;
      readonly qualificationRootAttemptCount: 0;
      readonly rootChecksum: string;
      readonly rootInstanceId: string;
      readonly sourceVersion: string;
    }
  | {
      readonly _tag: "Failed";
      readonly cohortId: string;
      readonly dispatchId: string;
      readonly executionId: string;
      readonly failureChecksum: string;
      readonly manifestChecksum: string;
      readonly planChecksum: string;
      readonly sourceVersion: string;
    }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Pending" };

export const makeQualificationPostTeardownPublicationAuthority = (database: Database) => {
  const claimBatch = Effect.fn("QualificationPostTeardownPublication.claimBatch")(
    (claimToken: string, limit = qualificationCohortScrubDispatchBatchLimit) =>
      attempt("claimBatch", () =>
        database.transaction(async (transaction) => {
          if (
            claimToken.length === 0 ||
            limit <= 0 ||
            limit > qualificationCohortScrubDispatchBatchLimit
          )
            return [];
          const clock = await databaseClock(transaction);
          const rows = await transaction
            .select()
            .from(qualificationCohortScrubDispatches)
            .where(
              or(
                and(
                  eq(qualificationCohortScrubDispatches.publication_state, "PENDING"),
                  lte(qualificationCohortScrubDispatches.publication_next_attempt_at, clock),
                ),
                and(
                  eq(qualificationCohortScrubDispatches.publication_state, "CLAIMED"),
                  lte(qualificationCohortScrubDispatches.publication_lease_expires_at, clock),
                ),
              ),
            )
            .orderBy(
              asc(qualificationCohortScrubDispatches.publication_next_attempt_at),
              asc(qualificationCohortScrubDispatches.created_at),
              asc(qualificationCohortScrubDispatches.dispatch_id),
            )
            .limit(limit)
            .for("update", { skipLocked: true });
          const leaseExpiresAt = new Date(
            clock.getTime() + qualificationPostTeardownPublicationLeaseMilliseconds,
          );
          const claimed = [];
          for (const row of rows) {
            if (row.state !== "SETTLED" && row.state !== "CONFLICT") continue;
            const [updated] = await transaction
              .update(qualificationCohortScrubDispatches)
              .set({
                publication_attempt_count: (row.publication_attempt_count ?? 0) + 1,
                publication_claim_token: claimToken,
                publication_lease_expires_at: leaseExpiresAt,
                publication_state: "CLAIMED",
              })
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, row.dispatch_id))
              .returning();
            if (updated !== undefined) claimed.push(toClaim(updated, claimToken, leaseExpiresAt));
          }
          return claimed;
        }),
      ),
  );

  const claimExact = Effect.fn("QualificationPostTeardownPublication.claimExact")(
    (identity: QualificationPostTeardownPublicationIdentity, claimToken: string) =>
      attempt("claimExact", () =>
        database.transaction(
          async (transaction): Promise<QualificationPostTeardownPublicationClaim> => {
            const clock = await databaseClock(transaction);
            const [row] = await transaction
              .select()
              .from(qualificationCohortScrubDispatches)
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
              .limit(1)
              .for("update");
            if (row === undefined) return { _tag: "Missing" };
            if (row.cohort_id !== identity.cohortId || row.execution_id !== identity.executionId)
              return { _tag: "Conflict" };
            if (
              row.publication_state === "PUBLISHED" ||
              row.publication_state === "CONFLICT" ||
              row.publication_state === "INELIGIBLE"
            ) {
              return {
                _tag: "Terminal",
                artifactChecksum: row.publication_artifact_checksum,
                conflictChecksum: row.publication_conflict_checksum,
                state: row.publication_state,
              };
            }
            if (
              row.publication_state === "CLAIMED" &&
              row.publication_lease_expires_at !== null &&
              row.publication_lease_expires_at > clock
            ) {
              return row.publication_claim_token === claimToken
                ? toClaim(row, claimToken, row.publication_lease_expires_at)
                : { _tag: "Busy", leaseExpiresAt: row.publication_lease_expires_at };
            }
            if (row.publication_state !== "PENDING" && row.publication_state !== "CLAIMED")
              return { _tag: "Conflict" };
            const leaseExpiresAt = new Date(
              clock.getTime() + qualificationPostTeardownPublicationLeaseMilliseconds,
            );
            const [updated] = await transaction
              .update(qualificationCohortScrubDispatches)
              .set({
                publication_attempt_count: (row.publication_attempt_count ?? 0) + 1,
                publication_claim_token: claimToken,
                publication_lease_expires_at: leaseExpiresAt,
                publication_state: "CLAIMED",
              })
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, row.dispatch_id))
              .returning();
            return updated === undefined
              ? { _tag: "Conflict" }
              : toClaim(updated, claimToken, leaseExpiresAt);
          },
        ),
      ),
  );

  const pinInput = Effect.fn("QualificationPostTeardownPublication.pinInput")(
    (
      identity: QualificationPostTeardownPublicationIdentity,
      claimToken: string,
      inputChecksum: string,
    ) =>
      mutateClaim(database, "pinInput", identity, claimToken, (clock, row) =>
        row.publication_input_checksum !== null && row.publication_input_checksum !== inputChecksum
          ? null
          : { publication_input_checksum: inputChecksum, publication_next_attempt_at: clock },
      ),
  );

  const release = Effect.fn("QualificationPostTeardownPublication.release")(
    (
      identity: QualificationPostTeardownPublicationIdentity,
      claimToken: string,
      backoffMilliseconds: number,
    ) =>
      mutateClaim(database, "release", identity, claimToken, (clock) => {
        if (
          !Number.isSafeInteger(backoffMilliseconds) ||
          backoffMilliseconds < 0 ||
          backoffMilliseconds > qualificationPostTeardownPublicationMaximumBackoffMilliseconds
        )
          return null;
        return {
          publication_claim_token: null,
          publication_lease_expires_at: null,
          publication_next_attempt_at: new Date(clock.getTime() + backoffMilliseconds),
          publication_state: "PENDING" as const,
        };
      }),
  );

  const settle = (state: "INELIGIBLE" | "PUBLISHED") =>
    Effect.fn(`QualificationPostTeardownPublication.${state.toLowerCase()}`)(
      (
        identity: QualificationPostTeardownPublicationIdentity,
        claimToken: string,
        inputChecksum: string,
        artifactChecksum: string,
      ) =>
        mutateClaim(database, state, identity, claimToken, (clock, row) =>
          row.publication_input_checksum !== inputChecksum
            ? null
            : {
                publication_artifact_checksum: artifactChecksum,
                publication_claim_token: null,
                publication_lease_expires_at: null,
                publication_next_attempt_at: null,
                publication_settled_at: clock,
                publication_state: state,
              },
        ),
    );

  const retainConflict = Effect.fn("QualificationPostTeardownPublication.conflict")(
    (
      identity: QualificationPostTeardownPublicationIdentity,
      claimToken: string,
      inputChecksum: string,
      conflictChecksum: string,
    ) =>
      mutateClaim(database, "conflict", identity, claimToken, (clock, row) =>
        row.publication_input_checksum !== inputChecksum
          ? null
          : {
              publication_claim_token: null,
              publication_conflict_checksum: conflictChecksum,
              publication_lease_expires_at: null,
              publication_next_attempt_at: null,
              publication_settled_at: clock,
              publication_state: "CONFLICT" as const,
            },
      ),
  );

  const inspectAuthority = Effect.fn("QualificationPostTeardownPublication.inspectAuthority")(
    (input: {
      readonly executionId: string;
      readonly manifestChecksum: string;
      readonly planChecksum: string;
      readonly sourceVersion: string;
    }) =>
      attempt("inspectAuthority", () =>
        database.transaction(
          async (transaction): Promise<QualificationPostTeardownAuthorityInspection> => {
            const [cohort] = await transaction
              .select()
              .from(qualificationCohorts)
              .where(eq(qualificationCohorts.execution_id, input.executionId))
              .limit(1);
            if (cohort === undefined) return { _tag: "Missing" };
            if (
              cohort.manifest_checksum !== input.manifestChecksum ||
              cohort.plan_checksum !== input.planChecksum ||
              cohort.source_version !== input.sourceVersion ||
              cohort.artifact_authority_protocol !== qualificationCohortArtifactProtocol
            )
              return { _tag: "Conflict" };
            const identity = qualificationCohortScrubDispatchIdentity(
              cohort.cohort_id,
              input.executionId,
            );
            const [dispatch] = await transaction
              .select()
              .from(qualificationCohortScrubDispatches)
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
              .limit(1);
            if (dispatch === undefined) return { _tag: "Missing" };
            if (
              dispatch.cohort_id !== cohort.cohort_id ||
              dispatch.execution_id !== input.executionId ||
              dispatch.protocol_version !== identity.protocolVersion ||
              dispatch.root_instance_id !== identity.rootInstanceId
            )
              return { _tag: "Conflict" };
            if (dispatch.state === "PENDING") return { _tag: "Pending" };
            if (dispatch.state === "CONFLICT") {
              return dispatch.terminal_failure_checksum === null ||
                dispatch.last_status !== "conflict" ||
                dispatch.last_status_checksum !== dispatch.terminal_failure_checksum
                ? { _tag: "Conflict" }
                : {
                    _tag: "Failed",
                    cohortId: cohort.cohort_id,
                    dispatchId: dispatch.dispatch_id,
                    executionId: input.executionId,
                    failureChecksum: dispatch.terminal_failure_checksum,
                    manifestChecksum: cohort.manifest_checksum,
                    planChecksum: cohort.plan_checksum,
                    sourceVersion: cohort.source_version,
                  };
            }
            const [root] = await transaction
              .select()
              .from(qualificationCohortScrubRoots)
              .where(
                and(
                  eq(qualificationCohortScrubRoots.cohort_id, cohort.cohort_id),
                  eq(qualificationCohortScrubRoots.execution_id, input.executionId),
                ),
              )
              .limit(1);
            const expectedArtifactIds = qualificationCohortRootArtifactKeys(input.executionId);
            const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds });
            const expectedParticipantCount =
              cohort.expected_free_participants + cohort.expected_adventurer_participants;
            const expectedPageCount =
              Math.ceil(cohort.expected_free_participants / 25) +
              Math.ceil(cohort.expected_adventurer_participants / 25);
            const rootAuthentic =
              root !== undefined &&
              root.completed_at !== null &&
              root.root_checksum !== null &&
              root.artifact_authority_proof_checksum !== null &&
              root.deleted_artifact_count === root.expected_artifact_count &&
              root.deleted_artifacts_checksum === root.expected_artifacts_checksum &&
              root.expected_artifact_count === expectedArtifactIds.length &&
              root.expected_artifacts_checksum === expectedArtifactsChecksum &&
              root.expected_page_count === expectedPageCount &&
              root.expected_participant_count === expectedParticipantCount &&
              root.root_checksum ===
                qualificationChecksum({
                  artifactAuthorityProofChecksum: root.artifact_authority_proof_checksum,
                  cohortId: root.cohort_id,
                  completedAtUtc: root.completed_at.toISOString(),
                  deletedArtifactCount: root.deleted_artifact_count,
                  deletedArtifactsChecksum: root.deleted_artifacts_checksum,
                  executionId: root.execution_id,
                  expectedPageCount: root.expected_page_count,
                  expectedParticipantCount: root.expected_participant_count,
                  finalPageChecksum: root.final_page_checksum,
                });
            if (
              !rootAuthentic ||
              dispatch.root_checksum !== root.root_checksum ||
              dispatch.last_status !== "complete" ||
              dispatch.last_status_checksum !==
                qualificationChecksum({
                  dispatchId: dispatch.dispatch_id,
                  rootChecksum: root.root_checksum,
                }) ||
              cohort.state !== "SCRUBBED"
            )
              return { _tag: "Conflict" };
            if (
              root === undefined ||
              root.root_checksum === null ||
              root.artifact_authority_proof_checksum === null
            )
              return { _tag: "Conflict" };
            const [count] = await transaction
              .select({
                allocationCount: sql<number>`(select count(*)::int from qualification_participant_allocations where execution_id = ${input.executionId})`,
                attemptCount: sql<number>`(select count(*)::int from qualification_root_attempts where execution_id = ${input.executionId})`,
                provisionCount: sql<number>`(select count(*)::int from qualification_participant_provisions where execution_id = ${input.executionId})`,
              })
              .from(sql`(values (1)) as exact_authority_snapshot`);
            if (
              count?.allocationCount !== 0 ||
              count.provisionCount !== 0 ||
              count.attemptCount !== 0
            )
              return { _tag: "Conflict" };
            return {
              _tag: "Ready",
              allocationIdentityCount: 0,
              artifactAuthorityProofChecksum: root.artifact_authority_proof_checksum,
              artifactAuthorityProtocol: cohort.artifact_authority_protocol,
              cohortArtifactChecksum: cohort.artifact_checksum,
              cohortArtifactId: cohort.artifact_id,
              cohortId: cohort.cohort_id,
              dispatchId: dispatch.dispatch_id,
              dispatchProtocolVersion: dispatch.protocol_version,
              executionId: input.executionId,
              expectedPageCount: root.expected_page_count,
              expectedParticipantCount: root.expected_participant_count,
              finalPageChecksum: root.final_page_checksum,
              manifestChecksum: cohort.manifest_checksum,
              planChecksum: cohort.plan_checksum,
              provisionIdentityCount: 0,
              qualificationRootAttemptCount: 0,
              rootChecksum: root.root_checksum,
              rootInstanceId: dispatch.root_instance_id,
              sourceVersion: cohort.source_version,
            };
          },
          { accessMode: "read only", isolationLevel: "repeatable read" },
        ),
      ),
  );

  return {
    claimBatch,
    claimExact,
    inspectAuthority,
    pinInput,
    publish: settle("PUBLISHED"),
    release,
    retainConflict,
    retainIneligible: settle("INELIGIBLE"),
  } as const;
};

type DispatchRow = typeof qualificationCohortScrubDispatches.$inferSelect;
const toClaim = (
  row: DispatchRow,
  claimToken: string,
  leaseExpiresAt: Date,
): Extract<QualificationPostTeardownPublicationClaim, { readonly _tag: "Claimed" }> => ({
  _tag: "Claimed",
  attemptCount: row.publication_attempt_count ?? 0,
  claimToken,
  cohortId: row.cohort_id,
  dispatchId: row.dispatch_id,
  executionId: row.execution_id,
  inputChecksum: row.publication_input_checksum,
  leaseExpiresAt,
  scrubState: row.state === "CONFLICT" ? "CONFLICT" : "SETTLED",
});

const mutateClaim = (
  database: Database,
  operation: string,
  identity: QualificationPostTeardownPublicationIdentity,
  claimToken: string,
  change: (clock: Date, row: DispatchRow) => Partial<DispatchRow> | null,
) =>
  attempt(operation, () =>
    database.transaction(
      async (transaction): Promise<QualificationPostTeardownPublicationMutation> => {
        const clock = await databaseClock(transaction);
        const [row] = await transaction
          .select()
          .from(qualificationCohortScrubDispatches)
          .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
          .limit(1)
          .for("update");
        if (
          row === undefined ||
          row.cohort_id !== identity.cohortId ||
          row.execution_id !== identity.executionId ||
          row.publication_state !== "CLAIMED" ||
          row.publication_claim_token !== claimToken ||
          row.publication_lease_expires_at === null
        )
          return { _tag: "Conflict" };
        if (row.publication_lease_expires_at <= clock)
          return { _tag: "LeaseExpired", leaseExpiresAt: row.publication_lease_expires_at };
        const changes = change(clock, row);
        if (changes === null) return { _tag: "Conflict" };
        const [updated] = await transaction
          .update(qualificationCohortScrubDispatches)
          .set(changes)
          .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
          .returning({ id: qualificationCohortScrubDispatches.dispatch_id });
        return updated === undefined ? { _tag: "Conflict" } : { _tag: "Applied" };
      },
    ),
  );

const databaseClock = async (database: Database) => {
  const [row] = await database
    .select({ now: sql<string>`clock_timestamp()::text` })
    .from(sql`(values (1)) as database_clock`);
  if (row === undefined) throw new Error("PostgreSQL clock is unavailable");
  return new Date(row.now);
};

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new QualificationPostTeardownPublicationUnavailable({ cause, operation }),
  });

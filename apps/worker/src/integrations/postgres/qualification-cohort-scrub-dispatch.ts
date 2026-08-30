import { qualificationCohortScrubDispatches } from "@osfo/db/schema/qualification-cohorts";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "@osfo/db";
import {
  qualificationCohortScrubDispatchBatchLimit,
  type QualificationCohortScrubDispatchIdentity,
  qualificationCohortScrubDispatchIdentity,
  qualificationCohortScrubDispatchLeaseMilliseconds,
  qualificationCohortScrubDispatchProtocol,
  qualificationCohortScrubDispatchRestartLimit,
} from "../../qualification/cohort-scrub-dispatch";
import { qualificationChecksum } from "../../qualification/qualification-checksum";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Drizzle transactions and timestamp columns are Promise/Date-native boundaries. */

export class QualificationCohortScrubDispatchUnavailable extends Schema.TaggedError<QualificationCohortScrubDispatchUnavailable>()(
  "QualificationCohortScrubDispatchUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

export type QualificationCohortScrubDispatchClaim =
  | ({
      readonly _tag: "Claimed";
      readonly claimToken: string;
      readonly leaseExpiresAt: Date;
      readonly restartApplied: boolean;
      readonly restartGeneration: number;
      readonly restartIntentChecksum: string | null;
    } & QualificationCohortScrubDispatchIdentity)
  | { readonly _tag: "Busy"; readonly leaseExpiresAt: Date }
  | ({
      readonly _tag: "Completed";
      readonly rootChecksum: string;
    } & QualificationCohortScrubDispatchIdentity)
  | { readonly _tag: "Conflict"; readonly failureChecksum: string | null }
  | { readonly _tag: "LeaseExpired"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "Missing" };

export type QualificationCohortScrubDispatchMutation =
  | { readonly _tag: "Applied" }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "LeaseExpired"; readonly leaseExpiresAt: Date };

export type QualificationCohortScrubRestartReservation =
  | {
      readonly _tag: "Reserved";
      readonly generation: number;
      readonly intentChecksum: string;
    }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "LeaseExpired"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "RestartLimitReached" };

export const makeQualificationCohortScrubDispatchAuthority = (database: Database) => {
  const claimExact = Effect.fn("QualificationCohortScrubDispatch.claimExact")(
    (identity: QualificationCohortScrubDispatchIdentity, claimToken: string) =>
      attempt("claimExact", () =>
        database.transaction(
          async (transaction): Promise<QualificationCohortScrubDispatchClaim> => {
            const clock = await databaseClock(transaction);
            const [row] = await transaction
              .select()
              .from(qualificationCohortScrubDispatches)
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
              .limit(1)
              .for("update");
            if (row === undefined) return { _tag: "Missing" };
            if (!rowMatches(row, identity)) return { _tag: "Conflict", failureChecksum: null };
            if (row.state === "SETTLED") {
              return row.root_checksum === null
                ? { _tag: "Conflict", failureChecksum: null }
                : { _tag: "Completed", ...identity, rootChecksum: row.root_checksum };
            }
            if (row.state === "CONFLICT") {
              return { _tag: "Conflict", failureChecksum: row.terminal_failure_checksum };
            }
            if (row.claim_token === claimToken && row.lease_expires_at !== null) {
              return row.lease_expires_at <= clock
                ? { _tag: "LeaseExpired", leaseExpiresAt: row.lease_expires_at }
                : claimed(row, identity, claimToken);
            }
            if (row.lease_expires_at !== null && row.lease_expires_at > clock) {
              return { _tag: "Busy", leaseExpiresAt: row.lease_expires_at };
            }
            const leaseExpiresAt = new Date(
              clock.getTime() + qualificationCohortScrubDispatchLeaseMilliseconds,
            );
            const [updated] = await transaction
              .update(qualificationCohortScrubDispatches)
              .set({ claim_token: claimToken, claimed_at: clock, lease_expires_at: leaseExpiresAt })
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
              .returning();
            return updated === undefined
              ? { _tag: "Conflict", failureChecksum: null }
              : claimed(updated, identity, claimToken);
          },
        ),
      ),
  );

  const claimBatch = Effect.fn("QualificationCohortScrubDispatch.claimBatch")(
    (claimToken: string, limit = qualificationCohortScrubDispatchBatchLimit) =>
      attempt("claimBatch", () =>
        database.transaction(async (transaction) => {
          if (
            !Number.isSafeInteger(limit) ||
            limit <= 0 ||
            limit > qualificationCohortScrubDispatchBatchLimit
          ) {
            return new Array<Extract<QualificationCohortScrubDispatchClaim, { _tag: "Claimed" }>>();
          }
          const clock = await databaseClock(transaction);
          const rows = await transaction
            .select()
            .from(qualificationCohortScrubDispatches)
            .where(
              and(
                eq(qualificationCohortScrubDispatches.state, "PENDING"),
                or(
                  isNull(qualificationCohortScrubDispatches.lease_expires_at),
                  lte(qualificationCohortScrubDispatches.lease_expires_at, clock),
                ),
              ),
            )
            .orderBy(
              asc(qualificationCohortScrubDispatches.created_at),
              asc(qualificationCohortScrubDispatches.dispatch_id),
            )
            .limit(limit)
            .for("update", { skipLocked: true });
          const leaseExpiresAt = new Date(
            clock.getTime() + qualificationCohortScrubDispatchLeaseMilliseconds,
          );
          const outcomes = await Promise.all(
            rows.map(async (row) => {
              const identity = qualificationCohortScrubDispatchIdentity(
                row.cohort_id,
                row.execution_id,
              );
              if (!rowMatches(row, identity)) {
                await quarantineIdentityConflict(transaction, row, identity, clock);
                return null;
              }
              const [updated] = await transaction
                .update(qualificationCohortScrubDispatches)
                .set({
                  claim_token: claimToken,
                  claimed_at: clock,
                  lease_expires_at: leaseExpiresAt,
                })
                .where(eq(qualificationCohortScrubDispatches.dispatch_id, row.dispatch_id))
                .returning();
              if (updated === undefined) throw new Error("Scrub dispatch claim disappeared");
              return claimed(updated, identity, claimToken);
            }),
          );
          return outcomes.flatMap((outcome) => (outcome === null ? [] : [outcome]));
        }),
      ),
  );

  const observe = Effect.fn("QualificationCohortScrubDispatch.observe")(
    (identity: QualificationCohortScrubDispatchIdentity, claimToken: string, status: string) =>
      mutateClaimed(database, "observe", identity, claimToken, (clock, row) => {
        const observation = {
          claim_token: null,
          claimed_at: null,
          last_observed_at: clock,
          last_status: status,
          last_status_checksum: qualificationChecksum({ dispatchId: identity.dispatchId, status }),
          lease_expires_at: null,
        };
        if (row.restart_applied_at === null) return observation;
        return {
          ...observation,
          restart_applied_at: null,
          restart_intent_checksum: null,
          restart_reserved_at: null,
        };
      }),
  );

  const reserveRestart = Effect.fn("QualificationCohortScrubDispatch.reserveRestart")(
    (
      identity: QualificationCohortScrubDispatchIdentity,
      claimToken: string,
      statusChecksum: string,
    ) =>
      attempt("reserveRestart", () =>
        database.transaction(
          async (transaction): Promise<QualificationCohortScrubRestartReservation> => {
            const clock = await databaseClock(transaction);
            const [row] = await lockedDispatch(transaction, identity.dispatchId);
            const exact = claimedRowOutcome(row, identity, claimToken, clock);
            if (exact !== null) return exact;
            if (row === undefined) return { _tag: "Conflict" };
            if (row.restart_intent_checksum !== null && row.restart_applied_at === null) {
              return { _tag: "Conflict" };
            }
            if (row.restart_generation >= qualificationCohortScrubDispatchRestartLimit) {
              return { _tag: "RestartLimitReached" };
            }
            const generation = row.restart_generation + 1;
            const intentChecksum = qualificationChecksum({
              dispatchId: identity.dispatchId,
              generation,
              statusChecksum,
            });
            const [updated] = await transaction
              .update(qualificationCohortScrubDispatches)
              .set({
                last_observed_at: clock,
                last_status: "restartReserved",
                last_status_checksum: statusChecksum,
                restart_applied_at: null,
                restart_generation: generation,
                restart_intent_checksum: intentChecksum,
                restart_reserved_at: clock,
              })
              .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
              .returning({ dispatchId: qualificationCohortScrubDispatches.dispatch_id });
            return updated === undefined
              ? { _tag: "Conflict" }
              : { _tag: "Reserved", generation, intentChecksum };
          },
        ),
      ),
  );

  const markRestartApplied = Effect.fn("QualificationCohortScrubDispatch.markRestartApplied")(
    (
      identity: QualificationCohortScrubDispatchIdentity,
      claimToken: string,
      intentChecksum: string,
    ) =>
      mutateClaimed(database, "markRestartApplied", identity, claimToken, (clock, row) =>
        row.restart_intent_checksum !== intentChecksum || row.restart_reserved_at === null
          ? null
          : {
              claim_token: null,
              claimed_at: null,
              last_observed_at: clock,
              last_status: "restartApplied",
              lease_expires_at: null,
              restart_applied_at: clock,
            },
      ),
  );

  const settle = Effect.fn("QualificationCohortScrubDispatch.settle")(
    (
      identity: QualificationCohortScrubDispatchIdentity,
      claimToken: string,
      rootChecksum: string,
    ) =>
      mutateClaimed(database, "settle", identity, claimToken, (clock) => ({
        claim_token: null,
        claimed_at: null,
        last_observed_at: clock,
        last_status: "complete",
        last_status_checksum: qualificationChecksum({
          dispatchId: identity.dispatchId,
          rootChecksum,
        }),
        lease_expires_at: null,
        root_checksum: rootChecksum,
        settled_at: clock,
        state: "SETTLED" as const,
      })),
  );

  const retainConflict = Effect.fn("QualificationCohortScrubDispatch.retainConflict")(
    (
      identity: QualificationCohortScrubDispatchIdentity,
      claimToken: string,
      failureChecksum: string,
    ) =>
      mutateClaimed(database, "retainConflict", identity, claimToken, (clock) => ({
        claim_token: null,
        claimed_at: null,
        last_observed_at: clock,
        last_status: "conflict",
        last_status_checksum: failureChecksum,
        lease_expires_at: null,
        settled_at: clock,
        state: "CONFLICT" as const,
        terminal_failure_checksum: failureChecksum,
      })),
  );

  return {
    claimBatch,
    claimExact,
    markRestartApplied,
    observe,
    reserveRestart,
    retainConflict,
    settle,
  } as const;
};

type DispatchRow = typeof qualificationCohortScrubDispatches.$inferSelect;

const rowMatches = (row: DispatchRow, identity: QualificationCohortScrubDispatchIdentity) =>
  row.cohort_id === identity.cohortId &&
  row.dispatch_id === identity.dispatchId &&
  row.execution_id === identity.executionId &&
  row.protocol_version === qualificationCohortScrubDispatchProtocol &&
  row.root_instance_id === identity.rootInstanceId;

const claimed = (
  row: DispatchRow,
  identity: QualificationCohortScrubDispatchIdentity,
  claimToken: string,
): Extract<QualificationCohortScrubDispatchClaim, { _tag: "Claimed" }> => ({
  _tag: "Claimed",
  ...identity,
  claimToken,
  leaseExpiresAt: row.lease_expires_at ?? new Date(0),
  restartApplied: row.restart_applied_at !== null,
  restartGeneration: row.restart_generation,
  restartIntentChecksum: row.restart_intent_checksum,
});

const databaseClock = async (database: Database) => {
  const [row] = await database
    .select({ now: sql<string>`clock_timestamp()::text` })
    .from(sql`(values (1)) as database_clock`);
  if (row === undefined) throw new Error("Database clock unavailable");
  const epochMilliseconds = Date.parse(row.now);
  if (!Number.isFinite(epochMilliseconds)) throw new Error("Database clock is invalid");
  return new Date(epochMilliseconds);
};

const quarantineIdentityConflict = async (
  database: Database,
  row: DispatchRow,
  identity: QualificationCohortScrubDispatchIdentity,
  clock: Date,
) => {
  const failureChecksum = qualificationChecksum({
    dispatchId: identity.dispatchId,
    failure: "qualificationCohortScrubDispatchIdentityConflict",
    protocolVersion: qualificationCohortScrubDispatchProtocol,
  });
  const [updated] = await database
    .update(qualificationCohortScrubDispatches)
    .set({
      claim_token: null,
      claimed_at: null,
      last_observed_at: clock,
      last_status: "identityConflict",
      last_status_checksum: failureChecksum,
      lease_expires_at: null,
      restart_applied_at: null,
      restart_generation: 0,
      restart_intent_checksum: null,
      restart_reserved_at: null,
      settled_at: clock,
      state: "CONFLICT",
      terminal_failure_checksum: failureChecksum,
    })
    .where(eq(qualificationCohortScrubDispatches.dispatch_id, row.dispatch_id))
    .returning({ dispatchId: qualificationCohortScrubDispatches.dispatch_id });
  if (updated === undefined) throw new Error("Scrub dispatch quarantine disappeared");
};

const lockedDispatch = (database: Database, dispatchId: string) =>
  database
    .select()
    .from(qualificationCohortScrubDispatches)
    .where(eq(qualificationCohortScrubDispatches.dispatch_id, dispatchId))
    .limit(1)
    .for("update");

const claimedRowOutcome = (
  row: DispatchRow | undefined,
  identity: QualificationCohortScrubDispatchIdentity,
  claimToken: string,
  clock: Date,
): Extract<
  QualificationCohortScrubDispatchMutation,
  { _tag: "Conflict" | "LeaseExpired" }
> | null => {
  if (
    row === undefined ||
    !rowMatches(row, identity) ||
    row.state !== "PENDING" ||
    row.claim_token !== claimToken
  ) {
    return { _tag: "Conflict" };
  }
  return row.lease_expires_at === null || row.lease_expires_at <= clock
    ? { _tag: "LeaseExpired", leaseExpiresAt: row.lease_expires_at ?? clock }
    : null;
};

const mutateClaimed = (
  database: Database,
  operation: string,
  identity: QualificationCohortScrubDispatchIdentity,
  claimToken: string,
  values: (
    clock: Date,
    row: DispatchRow,
  ) => Partial<typeof qualificationCohortScrubDispatches.$inferInsert> | null,
) =>
  attempt(operation, () =>
    database.transaction(async (transaction): Promise<QualificationCohortScrubDispatchMutation> => {
      const clock = await databaseClock(transaction);
      const [row] = await lockedDispatch(transaction, identity.dispatchId);
      const exact = claimedRowOutcome(row, identity, claimToken, clock);
      if (exact !== null) return exact;
      if (row === undefined) return { _tag: "Conflict" };
      const next = values(clock, row);
      if (next === null) return { _tag: "Conflict" };
      const [updated] = await transaction
        .update(qualificationCohortScrubDispatches)
        .set(next)
        .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
        .returning({ dispatchId: qualificationCohortScrubDispatches.dispatch_id });
      return updated === undefined ? { _tag: "Conflict" } : { _tag: "Applied" };
    }),
  );

const attempt = <Value>(operation: string, evaluate: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new QualificationCohortScrubDispatchUnavailable({ cause, operation }),
  });

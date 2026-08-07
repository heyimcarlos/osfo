import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AcceptanceReceipt,
  type AdmissionCapacityReconciliation,
  AdmissionCommitUnknown,
  AdmissionNotAccepted,
  AdmissionUnavailable,
  AuthenticationRejected,
  CapacityRejected,
  IdempotencyConflict,
  MessageAdmission,
  type MessageAdmissionReconciliationError,
  ThreadNotFound,
  type SubmitMessageCommand,
} from "@osfo/api";
import { makeUserMessageAppended } from "@osfo/session";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  acceptanceReceipts,
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  admissionPrincipalSetGeneration,
  admissionRejections,
  agentRunCapacityReservations,
  agentRuns,
  authenticationSessions,
  outboxObligations,
  principals,
  relayPrincipals,
  relayThreads,
  threadEvents,
  threads,
  userMessages,
} from "./schema.js";
import { ADMISSION_CAPACITY_LOCK_KEY } from "./admission-capacity.js";
import { OUTBOX_RELAY_WAKE_CHANNEL, OUTBOX_RELAY_WAKE_PAYLOAD } from "./outbox-relay-wake.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const AdmissionLimit = PositiveInteger.check(Schema.isLessThanOrEqualTo(256));
const QueryResultRowCount = Schema.Struct({ rowCount: Schema.Int });

export const MessageAdmissionDatabaseConfigSchema = Schema.Struct({
  capacityReconciliationBatchSize: Schema.optional(AdmissionLimit),
  databaseUrl: Schema.NonEmptyString,
  executionProfileRef: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  globalNonTerminalLimit: AdmissionLimit,
  maxConnections: PositiveInteger,
  principalNonTerminalLimit: AdmissionLimit,
});

export type MessageAdmissionDatabaseConfig = typeof MessageAdmissionDatabaseConfigSchema.Type;

export class InvalidMessageAdmissionDatabaseConfig extends Data.TaggedError(
  "InvalidMessageAdmissionDatabaseConfig",
)<{
  readonly cause: unknown;
}> {}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const widenWithCommitUnknown = <E>(error: E): E | AdmissionCommitUnknown => error;

const isMessageAdmissionError = Schema.is(
  Schema.Union([
    AdmissionCommitUnknown,
    AdmissionNotAccepted,
    AdmissionUnavailable,
    AuthenticationRejected,
    CapacityRejected,
    IdempotencyConflict,
    ThreadNotFound,
  ]),
);

const isMessageAdmissionReconciliationError = Schema.is(
  Schema.Union([
    AdmissionCommitUnknown,
    AdmissionNotAccepted,
    AuthenticationRejected,
    IdempotencyConflict,
    ThreadNotFound,
  ]),
);

const requestFingerprint = (command: SubmitMessageCommand) =>
  sha256(
    JSON.stringify({
      protocolVersion: command.protocolVersion,
      threadId: command.threadId,
      message: { content: command.message.content },
    }),
  );

const receiptFromRow = (row: typeof acceptanceReceipts.$inferSelect) =>
  new AcceptanceReceipt({
    protocolVersion: 1,
    receiptId: row.receiptId,
    idempotencyKey: row.idempotencyKey,
    threadId: row.threadId,
    userMessageId: row.userMessageId,
    agentRunId: row.agentRunId,
    threadPosition: String(row.threadPosition),
    acceptedAt: new Date(row.acceptedAt).toISOString(),
  });

const messageAdmissionLayer = (config: MessageAdmissionDatabaseConfig) => {
  const postgresLayer = PgClient.layer({
    applicationName: "osfo-api",
    maxConnections: config.maxConnections,
    url: Redacted.make(config.databaseUrl),
  });

  return Layer.effect(
    MessageAdmission,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();

      const reconcile = Effect.fn("DatabaseMessageAdmission.reconcile")(function* (
        command: SubmitMessageCommand,
      ) {
        const fingerprint = requestFingerprint(command);
        const transaction = db.transaction((tx) =>
          Effect.gen(function* () {
            const [session] = yield* tx
              .select({ principalId: authenticationSessions.principalId })
              .from(authenticationSessions)
              .where(
                and(
                  eq(authenticationSessions.tokenSha256, sha256(command.authenticationToken)),
                  isNull(authenticationSessions.revokedAt),
                  gt(authenticationSessions.expiresAt, sql`transaction_timestamp()`),
                ),
              )
              .limit(1);
            if (session === undefined) return yield* new AuthenticationRejected();

            yield* tx.execute(
              sql`SELECT pg_advisory_xact_lock(
                hashtextextended(${`${session.principalId}:${command.idempotencyKey}`}, 0)
              )`,
            );

            const [ownedThread] = yield* tx
              .select({ threadId: threads.threadId })
              .from(threads)
              .where(
                and(
                  eq(threads.threadId, command.threadId),
                  eq(threads.principalId, session.principalId),
                ),
              );
            if (ownedThread === undefined) return yield* new ThreadNotFound();

            const [receipt] = yield* tx
              .select()
              .from(acceptanceReceipts)
              .where(
                and(
                  eq(acceptanceReceipts.principalId, session.principalId),
                  eq(acceptanceReceipts.idempotencyKey, command.idempotencyKey),
                ),
              );
            if (receipt !== undefined) {
              if (receipt.requestFingerprint !== fingerprint) {
                return yield* new IdempotencyConflict();
              }
              return receiptFromRow(receipt);
            }
            const [rejection] = yield* tx
              .select()
              .from(admissionRejections)
              .where(
                and(
                  eq(admissionRejections.principalId, session.principalId),
                  eq(admissionRejections.idempotencyKey, command.idempotencyKey),
                ),
              );
            if (rejection !== undefined && rejection.requestFingerprint !== fingerprint) {
              return yield* new IdempotencyConflict();
            }
            if (rejection === undefined) {
              yield* tx.insert(admissionRejections).values({
                principalId: session.principalId,
                idempotencyKey: command.idempotencyKey,
                threadId: command.threadId,
                requestFingerprint: fingerprint,
                rejectedAt: sql`transaction_timestamp()`,
              });
            }
            return { type: "notAccepted" as const };
          }),
        );
        const result = yield* transaction.pipe(
          Effect.mapError(
            (error): MessageAdmissionReconciliationError =>
              isMessageAdmissionReconciliationError(error) ? error : new AdmissionCommitUnknown(),
          ),
        );
        return result instanceof AcceptanceReceipt ? result : yield* new AdmissionNotAccepted();
      });

      const accept = Effect.fn("DatabaseMessageAdmission.accept")(function* (
        command: SubmitMessageCommand,
      ) {
        const fingerprint = requestFingerprint(command);
        let principalIdForReconciliation: string | undefined;
        const transaction = db.transaction((tx) =>
          Effect.gen(function* () {
            const [session] = yield* tx
              .select({ principalId: authenticationSessions.principalId })
              .from(authenticationSessions)
              .where(
                and(
                  eq(authenticationSessions.tokenSha256, sha256(command.authenticationToken)),
                  isNull(authenticationSessions.revokedAt),
                  gt(authenticationSessions.expiresAt, sql`transaction_timestamp()`),
                ),
              )
              .limit(1);
            if (session === undefined) {
              return yield* new AuthenticationRejected();
            }
            const principalId = session.principalId;
            principalIdForReconciliation = principalId;

            yield* tx.execute(
              sql`SELECT pg_advisory_xact_lock(
                hashtextextended(${`${principalId}:${command.idempotencyKey}`}, 0)
              )`,
            );

            const [existingReceipt] = yield* tx
              .select()
              .from(acceptanceReceipts)
              .where(
                and(
                  eq(acceptanceReceipts.principalId, principalId),
                  eq(acceptanceReceipts.idempotencyKey, command.idempotencyKey),
                ),
              );
            const [existingRejection] = yield* tx
              .select()
              .from(admissionRejections)
              .where(
                and(
                  eq(admissionRejections.principalId, principalId),
                  eq(admissionRejections.idempotencyKey, command.idempotencyKey),
                ),
              );
            if (
              existingReceipt !== undefined &&
              existingReceipt.requestFingerprint !== fingerprint
            ) {
              return yield* new IdempotencyConflict();
            }

            const [ownedThread] = yield* tx
              .select({ threadId: threads.threadId })
              .from(threads)
              .where(
                and(eq(threads.threadId, command.threadId), eq(threads.principalId, principalId)),
              );
            if (ownedThread === undefined) {
              return yield* new ThreadNotFound();
            }
            if (existingReceipt !== undefined) {
              return receiptFromRow(existingReceipt);
            }
            if (existingRejection !== undefined) {
              if (existingRejection.requestFingerprint !== fingerprint) {
                return yield* new IdempotencyConflict();
              }
              return yield* new AdmissionNotAccepted();
            }

            yield* tx.execute(
              sql`SELECT pg_advisory_xact_lock(
                hashtextextended(${ADMISSION_CAPACITY_LOCK_KEY}, 0)
              )`,
            );

            const globalCapacity = yield* tx
              .update(admissionGlobalCapacity)
              .set({
                reservedCount: sql`${admissionGlobalCapacity.reservedCount} + 1`,
                revision: sql`${admissionGlobalCapacity.revision} + 1`,
              })
              .where(
                and(
                  eq(admissionGlobalCapacity.singleton, true),
                  lt(admissionGlobalCapacity.reservedCount, config.globalNonTerminalLimit),
                ),
              )
              .returning({ reservedCount: admissionGlobalCapacity.reservedCount });
            if (globalCapacity.length !== 1) {
              return yield* new CapacityRejected({ scope: "global" });
            }

            yield* tx
              .insert(admissionPrincipalCapacity)
              .values({ principalId, reservedCount: 0 })
              .onConflictDoNothing();
            const principalCapacity = yield* tx
              .update(admissionPrincipalCapacity)
              .set({ reservedCount: sql`${admissionPrincipalCapacity.reservedCount} + 1` })
              .where(
                and(
                  eq(admissionPrincipalCapacity.principalId, principalId),
                  lt(admissionPrincipalCapacity.reservedCount, config.principalNonTerminalLimit),
                ),
              )
              .returning({ reservedCount: admissionPrincipalCapacity.reservedCount });
            if (principalCapacity.length !== 1) {
              return yield* new CapacityRejected({ scope: "principal" });
            }

            const [position] = yield* tx
              .update(threads)
              .set({
                nextPosition: sql`${threads.nextPosition} + 1`,
                stateRevision: sql`${threads.stateRevision} + 1`,
              })
              .where(eq(threads.threadId, command.threadId))
              .returning({ threadPosition: sql<bigint>`${threads.nextPosition} - 1` });
            if (position === undefined) {
              return yield* new ThreadNotFound();
            }
            const threadPosition = position.threadPosition;

            const [timestamp] = yield* tx
              .select({ acceptedAt: sql<string>`transaction_timestamp()::text` })
              .from(admissionGlobalCapacity)
              .limit(1);
            if (timestamp === undefined) {
              return yield* new AdmissionUnavailable();
            }
            const acceptedAt = new Date(timestamp.acceptedAt).toISOString();

            const receiptId = randomUUID();
            const userMessageId = randomUUID();
            const agentRunId = randomUUID();
            const eventId = randomUUID();
            const outboxId = randomUUID();
            const [predecessor] = yield* tx
              .select({ outboxId: outboxObligations.outboxId })
              .from(outboxObligations)
              .innerJoin(
                acceptanceReceipts,
                eq(acceptanceReceipts.agentRunId, outboxObligations.agentRunId),
              )
              .where(eq(acceptanceReceipts.threadId, command.threadId))
              .orderBy(desc(acceptanceReceipts.threadPosition))
              .limit(1);
            const event = yield* makeUserMessageAppended({
              eventId,
              threadId: command.threadId,
              threadPosition: String(threadPosition),
              userMessageId,
              agentRunId,
              occurredAt: acceptedAt,
              content: command.message.content,
            });

            yield* tx.insert(userMessages).values({
              userMessageId,
              threadId: command.threadId,
              principalId,
              content: command.message.content,
              createdAt: acceptedAt,
            });
            yield* tx.insert(agentRuns).values({
              agentRunId,
              threadId: command.threadId,
              principalId,
              userMessageId,
              state: "pending",
              executionProfileRef: config.executionProfileRef,
              createdAt: acceptedAt,
            });
            yield* tx.insert(threadEvents).values({
              threadId: command.threadId,
              position: threadPosition,
              eventId: event.eventId,
              principalId,
              userMessageId: event.payload.userMessageId,
              agentRunId: event.payload.agentRunId,
              eventType: event.eventType,
              eventVersion: event.eventVersion,
              payload: event.payload,
              occurredAt: acceptedAt,
            });
            yield* tx.insert(agentRunCapacityReservations).values({
              agentRunId,
              principalId,
              state: "held",
              reservedAt: acceptedAt,
            });
            yield* tx.insert(outboxObligations).values({
              outboxId,
              agentRunId,
              threadId: command.threadId,
              principalId,
              predecessorOutboxId: predecessor?.outboxId,
              kind: "AgentRunPending",
              version: 1,
              createdAt: acceptedAt,
            });
            yield* tx.insert(relayPrincipals).values({ principalId }).onConflictDoNothing();
            yield* tx
              .insert(relayThreads)
              .values({ threadId: command.threadId, principalId })
              .onConflictDoNothing();
            yield* tx.execute(
              sql`SELECT pg_notify(${OUTBOX_RELAY_WAKE_CHANNEL}, ${OUTBOX_RELAY_WAKE_PAYLOAD})`,
            );

            const [receipt] = yield* tx
              .insert(acceptanceReceipts)
              .values({
                receiptId,
                protocolVersion: 1,
                principalId,
                threadId: command.threadId,
                idempotencyKey: command.idempotencyKey,
                requestFingerprint: fingerprint,
                userMessageId,
                agentRunId,
                threadPosition,
                acceptedAt,
              })
              .returning();
            if (receipt === undefined) {
              return yield* new AdmissionUnavailable();
            }
            return receiptFromRow(receipt);
          }),
        );

        const widenedTransaction = transaction.pipe(Effect.mapError(widenWithCommitUnknown));
        return yield* Effect.matchEffect(widenedTransaction, {
          onFailure: (error) => {
            if (isMessageAdmissionError(error)) return Effect.fail(error);
            if (principalIdForReconciliation === undefined) {
              return Effect.fail(new AdmissionUnavailable());
            }
            return reconcile(command).pipe(
              Effect.catchTag("AdmissionNotAccepted", () =>
                Effect.fail(new AdmissionUnavailable()),
              ),
            );
          },
          onSuccess: Effect.succeed,
        });
      });

      const reconciliationBatchSize = config.capacityReconciliationBatchSize ?? 256;
      let nonZeroCapacityReconciliationCursor: string | undefined;
      let principalReconciliationCursor: string | undefined;
      let principalSetGenerationCursor: bigint | undefined;

      const repairCapacityOnce = Effect.fn("DatabaseMessageAdmission.repairCapacityOnce")(
        function* () {
          yield* db
            .insert(admissionGlobalCapacity)
            .values({ singleton: true, reservedCount: 0 })
            .onConflictDoNothing();

          const [globalBefore] = yield* db
            .select({
              reservedCount: admissionGlobalCapacity.reservedCount,
              revision: admissionGlobalCapacity.revision,
            })
            .from(admissionGlobalCapacity)
            .where(eq(admissionGlobalCapacity.singleton, true));
          if (globalBefore === undefined) return yield* new AdmissionUnavailable();
          const [principalSetBefore] = yield* db
            .select({ generation: admissionPrincipalSetGeneration.generation })
            .from(admissionPrincipalSetGeneration)
            .where(eq(admissionPrincipalSetGeneration.singleton, true));
          if (principalSetBefore === undefined) return yield* new AdmissionUnavailable();
          if (
            principalSetGenerationCursor !== undefined &&
            principalSetGenerationCursor !== principalSetBefore.generation
          ) {
            nonZeroCapacityReconciliationCursor = undefined;
            principalReconciliationCursor = undefined;
            principalSetGenerationCursor = undefined;
            return { type: "stale" as const };
          }
          const expectedPrincipalSetGeneration =
            principalSetGenerationCursor ?? principalSetBefore.generation;

          const activeRuns = yield* db
            .select({
              agentRunId: agentRuns.agentRunId,
              createdAt: agentRuns.createdAt,
              principalId: agentRuns.principalId,
              reservationPrincipalId: agentRunCapacityReservations.principalId,
              reservationState: agentRunCapacityReservations.state,
            })
            .from(agentRuns)
            .leftJoin(
              agentRunCapacityReservations,
              eq(agentRunCapacityReservations.agentRunId, agentRuns.agentRunId),
            )
            .where(inArray(agentRuns.state, ["pending", "running"]))
            .limit(reconciliationBatchSize + 1);
          if (activeRuns.length > reconciliationBatchSize) {
            return yield* new AdmissionUnavailable();
          }

          const terminalHeldCondition = and(
            eq(agentRunCapacityReservations.state, "held"),
            inArray(agentRuns.state, ["waiting", "succeeded", "failed", "canceled"]),
          );
          const terminalHeldCandidates = yield* db
            .select({ agentRunId: agentRunCapacityReservations.agentRunId })
            .from(agentRunCapacityReservations)
            .innerJoin(agentRuns, eq(agentRuns.agentRunId, agentRunCapacityReservations.agentRunId))
            .where(terminalHeldCondition)
            .limit(reconciliationBatchSize + 1);
          const terminalHeldBatch = terminalHeldCandidates.slice(0, reconciliationBatchSize);
          const terminalSweepHasMore = terminalHeldCandidates.length > reconciliationBatchSize;

          const nonZeroCapacityCandidates = yield* db
            .select({
              principalId: admissionPrincipalCapacity.principalId,
              reservedCount: admissionPrincipalCapacity.reservedCount,
            })
            .from(admissionPrincipalCapacity)
            .where(
              and(
                gt(admissionPrincipalCapacity.reservedCount, 0),
                nonZeroCapacityReconciliationCursor === undefined
                  ? undefined
                  : gt(admissionPrincipalCapacity.principalId, nonZeroCapacityReconciliationCursor),
              ),
            )
            .orderBy(admissionPrincipalCapacity.principalId)
            .limit(reconciliationBatchSize + 1);
          const nonZeroCapacities = nonZeroCapacityCandidates.slice(0, reconciliationBatchSize);
          const nonZeroCapacitySweepHasMore =
            nonZeroCapacityCandidates.length > reconciliationBatchSize;
          const nextNonZeroCapacityReconciliationCursor = nonZeroCapacitySweepHasMore
            ? nonZeroCapacities.at(-1)?.principalId
            : undefined;

          const principalCandidates = yield* db
            .select({ principalId: principals.principalId })
            .from(principals)
            .where(
              principalReconciliationCursor === undefined
                ? undefined
                : gt(principals.principalId, principalReconciliationCursor),
            )
            .orderBy(principals.principalId)
            .limit(reconciliationBatchSize + 1);
          const principalPage = principalCandidates.slice(0, reconciliationBatchSize);
          const principalSweepHasMore = principalCandidates.length > reconciliationBatchSize;
          const nextPrincipalReconciliationCursor = principalSweepHasMore
            ? principalPage.at(-1)?.principalId
            : undefined;
          const sweepComplete =
            !terminalSweepHasMore && !nonZeroCapacitySweepHasMore && !principalSweepHasMore;
          const pageCapacityRows =
            principalPage.length === 0
              ? []
              : yield* db
                  .select({ principalId: admissionPrincipalCapacity.principalId })
                  .from(admissionPrincipalCapacity)
                  .where(
                    inArray(
                      admissionPrincipalCapacity.principalId,
                      principalPage.map(({ principalId }) => principalId),
                    ),
                  );
          const pageCapacityPrincipalIds = new Set(
            pageCapacityRows.map(({ principalId }) => principalId),
          );
          const missingPrincipals = principalPage.filter(
            ({ principalId }) => !pageCapacityPrincipalIds.has(principalId),
          );

          const expectedByPrincipal = new Map<string, number>();
          for (const run of activeRuns) {
            expectedByPrincipal.set(
              run.principalId,
              (expectedByPrincipal.get(run.principalId) ?? 0) + 1,
            );
          }
          const activeCapacityRows =
            expectedByPrincipal.size === 0
              ? []
              : yield* db
                  .select({
                    principalId: admissionPrincipalCapacity.principalId,
                    reservedCount: admissionPrincipalCapacity.reservedCount,
                  })
                  .from(admissionPrincipalCapacity)
                  .where(
                    inArray(admissionPrincipalCapacity.principalId, [
                      ...expectedByPrincipal.keys(),
                    ]),
                  );
          const actualByPrincipal = new Map(
            activeCapacityRows.map((row) => [row.principalId, row.reservedCount] as const),
          );
          const existingMismatchedPrincipalIds = new Set<string>();
          const missingActivePrincipalIds = new Set<string>();
          for (const [principalId, expected] of expectedByPrincipal) {
            if (!actualByPrincipal.has(principalId)) {
              missingActivePrincipalIds.add(principalId);
            } else if (actualByPrincipal.get(principalId) !== expected) {
              existingMismatchedPrincipalIds.add(principalId);
            }
          }
          for (const row of nonZeroCapacities) {
            if (!expectedByPrincipal.has(row.principalId)) {
              existingMismatchedPrincipalIds.add(row.principalId);
            }
          }
          const missingPrincipalIds = new Set(missingActivePrincipalIds);
          for (const row of missingPrincipals) missingPrincipalIds.add(row.principalId);

          const activeReservationMismatchCount = activeRuns.filter(
            (run) =>
              run.reservationState !== "held" || run.reservationPrincipalId !== run.principalId,
          ).length;
          const reservationMismatchCountBefore =
            activeReservationMismatchCount + terminalHeldCandidates.length;
          const principalMismatchCountBefore =
            missingPrincipalIds.size + existingMismatchedPrincipalIds.size;
          const repaired =
            globalBefore.reservedCount !== activeRuns.length ||
            principalMismatchCountBefore > 0 ||
            reservationMismatchCountBefore > 0;
          const advanceSweep = () => {
            nonZeroCapacityReconciliationCursor = nextNonZeroCapacityReconciliationCursor;
            principalReconciliationCursor = nextPrincipalReconciliationCursor;
            principalSetGenerationCursor = sweepComplete
              ? undefined
              : expectedPrincipalSetGeneration;
          };
          if (!repaired) {
            const validated = yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.execute(
                  sql`SELECT pg_advisory_xact_lock(
                    hashtextextended(${ADMISSION_CAPACITY_LOCK_KEY}, 0)
                  )`,
                );
                const result = yield* tx.execute(sql`SELECT capacity.revision
                  FROM admission_global_capacity capacity
                  CROSS JOIN admission_principal_set_generation principal_set
                  WHERE capacity.singleton = true
                    AND capacity.revision = ${globalBefore.revision}
                    AND principal_set.singleton = true
                    AND principal_set.generation = ${expectedPrincipalSetGeneration}
                  FOR UPDATE OF capacity, principal_set`);
                const { rowCount } = yield* Schema.decodeUnknownEffect(QueryResultRowCount)(result);
                return rowCount === 1;
              }),
            );
            if (!validated) return { type: "stale" as const };
            advanceSweep();
            return {
              type: "complete" as const,
              result: {
                expectedNonTerminalCount: activeRuns.length,
                globalReservedBefore: globalBefore.reservedCount,
                globalReservedAfter: globalBefore.reservedCount,
                principalMismatchCountBefore: 0,
                principalMismatchCountAfter: sweepComplete ? 0 : null,
                reservationMismatchCountBefore: 0,
                reservationMismatchCountAfter: 0,
                repaired: false,
                sweepComplete,
              } satisfies AdmissionCapacityReconciliation,
            };
          }

          const principalRepairs = new Map<string, number>(
            missingPrincipals.map(({ principalId }) => [principalId, 0] as const),
          );
          for (const [principalId, reservedCount] of expectedByPrincipal) {
            principalRepairs.set(principalId, reservedCount);
          }
          const stalePrincipalPayload = JSON.stringify(
            nonZeroCapacities
              .filter(({ principalId }) => !expectedByPrincipal.has(principalId))
              .map(({ principalId }) => principalId),
          );
          const principalRepairPayload = JSON.stringify(
            [...principalRepairs].map(([principalId, reservedCount]) => ({
              principalId,
              reservedCount,
            })),
          );
          const activeReservationPayload = JSON.stringify(
            activeRuns.map(({ agentRunId, createdAt, principalId }) => ({
              agentRunId,
              createdAt,
              principalId,
            })),
          );
          const terminalReservationPayload = JSON.stringify(
            terminalHeldBatch.map(({ agentRunId }) => agentRunId),
          );

          const transaction = db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(
                sql`SELECT pg_advisory_xact_lock(
                  hashtextextended(${ADMISSION_CAPACITY_LOCK_KEY}, 0)
                )`,
              );
              const updated = yield* tx.execute(sql<{
                readonly reservedCount: number;
              }>`WITH principal_set_guard AS MATERIALIZED (
                  SELECT generation
                  FROM admission_principal_set_generation
                  WHERE singleton = true
                    AND generation = ${expectedPrincipalSetGeneration}
                  FOR UPDATE
                ), guard AS MATERIALIZED (
                  SELECT 1 FROM admission_global_capacity
                  CROSS JOIN principal_set_guard
                  WHERE singleton = true
                    AND revision = ${globalBefore.revision}
                ), reset_stale_principals AS (
                  UPDATE admission_principal_capacity
                  SET reserved_count = 0
                  WHERE principal_id IN (
                    SELECT value::uuid
                    FROM jsonb_array_elements_text(${stalePrincipalPayload}::jsonb)
                  )
                    AND EXISTS (SELECT 1 FROM guard)
                  RETURNING principal_id
                ), repair_principals AS (
                  INSERT INTO admission_principal_capacity (principal_id, reserved_count)
                  SELECT
                    (entry ->> 'principalId')::uuid,
                    (entry ->> 'reservedCount')::integer
                  FROM jsonb_array_elements(${principalRepairPayload}::jsonb) entry
                  CROSS JOIN guard
                  ON CONFLICT (principal_id) DO UPDATE
                    SET reserved_count = excluded.reserved_count
                  RETURNING principal_id
                ), repair_active_reservations AS (
                  INSERT INTO agent_run_capacity_reservations (
                    agent_run_id, principal_id, state, reserved_at, released_at
                  )
                  SELECT
                    (entry ->> 'agentRunId')::uuid,
                    (entry ->> 'principalId')::uuid,
                    'held',
                    (entry ->> 'createdAt')::timestamptz,
                    NULL
                  FROM jsonb_array_elements(${activeReservationPayload}::jsonb) entry
                  CROSS JOIN guard
                  ON CONFLICT (agent_run_id) DO UPDATE SET
                    principal_id = excluded.principal_id,
                    state = 'held',
                    released_at = NULL
                  RETURNING agent_run_id
                ), release_terminal_reservations AS (
                  UPDATE agent_run_capacity_reservations
                  SET state = 'released', released_at = transaction_timestamp()
                  WHERE agent_run_id IN (
                    SELECT value::uuid
                    FROM jsonb_array_elements_text(${terminalReservationPayload}::jsonb)
                  )
                    AND EXISTS (SELECT 1 FROM guard)
                  RETURNING agent_run_id
                ), update_global AS (
                  UPDATE admission_global_capacity
                  SET reserved_count = ${activeRuns.length}, revision = revision + 1
                  WHERE singleton = true
                    AND revision = ${globalBefore.revision}
                    AND EXISTS (SELECT 1 FROM guard)
                  RETURNING reserved_count AS "reservedCount"
                )
                SELECT "reservedCount" FROM update_global`);
              const { rowCount } = yield* Schema.decodeUnknownEffect(QueryResultRowCount)(updated);
              if (rowCount !== 1) return { type: "stale" as const };

              return {
                type: "complete" as const,
                result: {
                  expectedNonTerminalCount: activeRuns.length,
                  globalReservedBefore: globalBefore.reservedCount,
                  globalReservedAfter: activeRuns.length,
                  principalMismatchCountBefore,
                  principalMismatchCountAfter: sweepComplete ? 0 : null,
                  reservationMismatchCountBefore,
                  reservationMismatchCountAfter: Math.max(
                    0,
                    terminalHeldCandidates.length - terminalHeldBatch.length,
                  ),
                  repaired: true,
                  sweepComplete,
                } satisfies AdmissionCapacityReconciliation,
              };
            }),
          );
          const outcome = yield* transaction;
          if (outcome.type === "complete") {
            advanceSweep();
          }
          return outcome;
        },
      );

      const reconcileCapacity = Effect.fn("DatabaseMessageAdmission.reconcileCapacity")(
        function* () {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const outcome = yield* repairCapacityOnce().pipe(
              Effect.mapError(() => new AdmissionUnavailable()),
            );
            if (outcome.type === "complete") return outcome.result;
          }
          return yield* new AdmissionUnavailable();
        },
      );

      return MessageAdmission.of({ accept, reconcile, reconcileCapacity });
    }),
  ).pipe(Layer.provide(postgresLayer));
};

export const makeMessageAdmissionLayer = (config: MessageAdmissionDatabaseConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(MessageAdmissionDatabaseConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidMessageAdmissionDatabaseConfig({ cause })),
      Effect.map(messageAdmissionLayer),
    ),
  );

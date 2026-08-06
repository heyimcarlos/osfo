import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AcceptanceReceipt,
  AdmissionUnavailable,
  AuthenticationRejected,
  CapacityRejected,
  IdempotencyConflict,
  MessageAdmission,
  ThreadNotFound,
  type SubmitMessageCommand,
} from "@osfo/api";
import { makeUserMessageAppended } from "@osfo/session";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  acceptanceReceipts,
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  agentRunCapacityReservations,
  agentRuns,
  authenticationSessions,
  outboxObligations,
  threadEvents,
  threads,
  userMessages,
} from "./schema.js";

export interface MessageAdmissionDatabaseConfig {
  readonly databaseUrl: string;
  readonly executionProfileRef: string;
  readonly globalNonTerminalLimit: number;
  readonly principalNonTerminalLimit: number;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const isMessageAdmissionError = Schema.is(
  Schema.Union([
    AdmissionUnavailable,
    AuthenticationRejected,
    CapacityRejected,
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

const validateConfig = (config: MessageAdmissionDatabaseConfig) => {
  if (
    config.databaseUrl.length === 0 ||
    config.executionProfileRef.length === 0 ||
    config.executionProfileRef.length > 255 ||
    !Number.isSafeInteger(config.globalNonTerminalLimit) ||
    config.globalNonTerminalLimit <= 0 ||
    !Number.isSafeInteger(config.principalNonTerminalLimit) ||
    config.principalNonTerminalLimit <= 0
  ) {
    throw new Error("Invalid message admission database configuration");
  }
};

export const makeMessageAdmissionLayer = (config: MessageAdmissionDatabaseConfig) => {
  validateConfig(config);

  const postgresLayer = PgClient.layer({
    applicationName: "osfo-api",
    url: Redacted.make(config.databaseUrl),
  });

  return Layer.effect(
    MessageAdmission,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();

      const accept = Effect.fn("DatabaseMessageAdmission.accept")(function* (
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
            if (session === undefined) {
              return yield* new AuthenticationRejected();
            }
            const principalId = session.principalId;

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

            const globalCapacity = yield* tx
              .update(admissionGlobalCapacity)
              .set({ reservedCount: sql`${admissionGlobalCapacity.reservedCount} + 1` })
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
              .set({ nextPosition: sql`${threads.nextPosition} + 1` })
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
            const event = makeUserMessageAppended({
              eventId,
              threadId: command.threadId,
              threadPosition: String(threadPosition),
              userMessageId,
              agentRunId,
              occurredAt: acceptedAt,
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
              kind: "AgentRunPending",
              version: 1,
              createdAt: acceptedAt,
            });

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

        return yield* transaction.pipe(
          Effect.mapError((error) =>
            isMessageAdmissionError(error) ? error : new AdmissionUnavailable(),
          ),
        );
      });

      return MessageAdmission.of({ accept });
    }),
  ).pipe(Layer.provide(postgresLayer));
};

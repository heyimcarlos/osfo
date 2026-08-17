import { describe, expect, it } from "@effect/vitest";
import { createDb } from "@osfo/db";
import { accounts, users } from "@osfo/db/schema/auth";
import { gmailConnections } from "@osfo/db/schema/gmail";
import { readMigrations } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Config, Data, DateTime, Effect } from "effect";
import postgres from "postgres";

import * as GmailDb from "../src/db/gmail";
import { UserId } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import { GmailConnectionId } from "../src/domain/gmail";

class RealPostgresTestUnavailable extends Data.TaggedError("RealPostgresTestUnavailable")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

describe("Gmail recovery with real PostgreSQL", () => {
  it.effect("claims one stale Action attempt and guards its terminal evidence", () =>
    Effect.acquireUseRelease(
      acquireDatabase,
      ({ database }) =>
        Effect.gen(function* () {
          const userId = UserId.make("gmail-real-recovery-user");
          const connectionId = GmailConnectionId.make("gmail:gmail-real-recovery-credential");
          const actionId = ActionId.make("gmail-real-recovery-action");
          const startedAt = date("2026-08-17T12:00:00.000Z");
          const recoveryAt = date("2026-08-17T12:05:00.000Z");
          yield* Effect.tryPromise({
            try: () =>
              database.insert(users).values({
                email: "gmail-real-recovery@example.test",
                id: userId,
                name: "Gmail real recovery",
              }),
            catch: (cause) => unavailable("Could not seed the Gmail recovery test", cause),
          });
          yield* Effect.tryPromise({
            try: () =>
              database.insert(accounts).values({
                accessToken: "gmail-real-recovery-token",
                accessTokenExpiresAt: date("2027-08-17T12:00:00.000Z"),
                accountId: "gmail-real-recovery-provider",
                id: "gmail-real-recovery-credential",
                providerId: "google",
                scope:
                  "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send",
                userId,
              }),
            catch: (cause) => unavailable("Could not seed the Gmail OAuth credential", cause),
          });
          const gmail = GmailDb.make(database);
          const connection = yield* gmail.connections.completeOAuth(userId, startedAt);
          expect(connection.connectionId).toBe(
            GmailConnectionId.make("gmail:gmail-real-recovery-credential"),
          );
          const first = yield* gmail.attempts.prepare(actionId, connectionId, startedAt);
          const claims = yield* Effect.all(
            [
              gmail.attempts.prepare(actionId, connectionId, recoveryAt),
              gmail.attempts.prepare(actionId, connectionId, recoveryAt),
            ],
            { concurrency: "unbounded" },
          );
          yield* gmail.attempts.markContacted(actionId, recoveryAt);
          const completions = yield* Effect.all(
            [
              Effect.result(gmail.attempts.complete(actionId, "applied")),
              Effect.result(gmail.attempts.complete(actionId, "ambiguous")),
            ],
            { concurrency: "unbounded" },
          );

          expect(first).toMatchObject({ _tag: "AttemptPrepared" });
          expect(new Set(claims.map(({ _tag }) => _tag))).toEqual(
            new Set(["ActiveAttempt", "PreparationRecoveryStarted"]),
          );
          expect(completions.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
          expect(completions.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1);

          yield* Effect.tryPromise({
            try: () =>
              database.delete(accounts).where(eq(accounts.id, connection.credentialReference)),
            catch: (cause) => unavailable("Could not unlink the Gmail recovery credential", cause),
          });
          expect(yield* gmail.attempts.prepare(actionId, connectionId, recoveryAt)).toMatchObject({
            _tag: "ExistingAttempt",
          });

          const raceUserId = UserId.make("gmail-real-account-race-user");
          yield* Effect.tryPromise({
            try: () =>
              database.insert(users).values({
                email: "gmail-real-account-race@example.test",
                id: raceUserId,
                name: "Gmail account race",
              }),
            catch: (cause) => unavailable("Could not seed the Gmail account race User", cause),
          });
          yield* Effect.tryPromise({
            try: () =>
              database.insert(accounts).values({
                accessToken: "gmail-real-account-race-token",
                accessTokenExpiresAt: date("2027-08-17T12:00:00.000Z"),
                accountId: "gmail-real-account-race-provider",
                id: "gmail-real-account-race-credential",
                providerId: "google",
                scope:
                  "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send",
                userId: raceUserId,
              }),
            catch: (cause) =>
              unavailable("Could not seed the Gmail account race credential", cause),
          });
          yield* Effect.all(
            [
              Effect.result(gmail.connections.completeOAuth(raceUserId, startedAt)),
              Effect.result(
                Effect.tryPromise({
                  try: () =>
                    database
                      .delete(accounts)
                      .where(eq(accounts.id, "gmail-real-account-race-credential")),
                  catch: (cause) =>
                    unavailable("Could not delete the raced Gmail credential", cause),
                }),
              ),
            ],
            { concurrency: "unbounded" },
          );
          const orphaned = yield* Effect.tryPromise({
            try: () =>
              database
                .select()
                .from(gmailConnections)
                .where(eq(gmailConnections.userId, raceUserId)),
            catch: (cause) => unavailable("Could not inspect the Gmail account race", cause),
          });

          expect(orphaned).toEqual([]);
        }),
      ({ client }) => Effect.promise(() => client.end()),
    ),
  );
});

const acquireDatabase = Effect.gen(function* () {
  const databaseUrl = yield* Config.string("OSFO_REAL_POSTGRES_URL");
  if (!databaseUrl.endsWith("/osfo_ticket_170")) {
    return yield* unavailable(
      "OSFO_REAL_POSTGRES_URL must target the dedicated osfo_ticket_170 database",
      databaseUrl,
    );
  }
  const client = postgres(databaseUrl, { max: 10 });
  const migrations = yield* readMigrations;
  yield* Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- Postgres.js owns this isolated test database boundary.
    try: async () => {
      await client.unsafe("DROP SCHEMA public CASCADE");
      await client.unsafe("CREATE SCHEMA public");
      // oxlint-disable-next-line effecttsgo/async-function -- Postgres.js owns this migration transaction callback.
      await client.begin(async (transaction) => {
        for (const migration of migrations) {
          for (const statement of migration.statements) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Migration statements must keep deployment order.
            await transaction.unsafe(statement);
          }
        }
      });
    },
    catch: (cause) => unavailable("Could not initialize real PostgreSQL", cause),
  });
  return { client, database: createDb(client) };
});

const unavailable = (message: string, cause: unknown) =>
  new RealPostgresTestUnavailable({ cause, message });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

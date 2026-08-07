import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export class DatabaseMigrationsNotReady extends Data.TaggedError("DatabaseMigrationsNotReady")<{
  readonly actualMigrationCount: number;
  readonly expectedMigrationCount: number;
  readonly expectedLatestMigrationName: string | null;
}> {}

export const checkDatabaseMigrationReadiness = (databaseUrl: string) =>
  Effect.gen(function* () {
    const expected = readMigrationFiles({ migrationsFolder });
    const expectedLatestMigrationName = expected.at(-1)?.name ?? null;
    const sql = yield* PgClient.PgClient;
    const [{ migrationTable } = { migrationTable: null }] = yield* sql.unsafe<{
      readonly migrationTable: string | null;
    }>("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS migration_table");
    const actual =
      migrationTable === null
        ? []
        : yield* sql.unsafe<{ readonly hash: string; readonly name: string | null }>(
            "SELECT hash, name FROM drizzle.__drizzle_migrations ORDER BY id",
          );
    const ready =
      actual.length === expected.length &&
      actual.every(
        (migration, index) =>
          migration.hash === expected[index]?.hash && migration.name === expected[index]?.name,
      );
    if (!ready) {
      return yield* new DatabaseMigrationsNotReady({
        actualMigrationCount: actual.length,
        expectedMigrationCount: expected.length,
        expectedLatestMigrationName,
      });
    }
    return {
      latestMigrationName: expectedLatestMigrationName,
      migrationCount: expected.length,
    } as const;
  }).pipe(
    Effect.provide(
      PgClient.layer({
        applicationName: "osfo-database-migration-readiness",
        maxConnections: 1,
        url: Redacted.make(databaseUrl),
      }),
    ),
  );

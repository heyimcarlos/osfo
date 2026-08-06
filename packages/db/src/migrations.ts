import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate as migrateDrizzle } from "drizzle-orm/effect-postgres/migrator";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface DatabaseConfig {
  readonly databaseUrl: string;
  readonly applicationName: string;
}

export class MigrationVerificationError extends Data.TaggedError("MigrationVerificationError")<{
  readonly appliedMigrationNames: ReadonlyArray<string | null>;
}> {}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const drizzleMigrations = pgSchema("drizzle").table("__drizzle_migrations", {
  id: integer("id").primaryKey(),
  name: text("name"),
});

const postgresLayer = (config: DatabaseConfig) =>
  PgClient.layer({
    applicationName: config.applicationName,
    url: Redacted.make(config.databaseUrl),
  });

export const migrateDatabase = (config: DatabaseConfig) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* migrateDrizzle(db, { migrationsFolder });
  }).pipe(Effect.provide(postgresLayer(config)));

export const verifyDatabaseMigrations = (config: DatabaseConfig) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* migrateDrizzle(db, { migrationsFolder });
    const rows = yield* db
      .select({ id: drizzleMigrations.id, name: drizzleMigrations.name })
      .from(drizzleMigrations)
      .orderBy(drizzleMigrations.id);

    const baseline = rows[0];
    const admission = rows[1];
    const resume = rows[2];
    const agentRun = rows[3];
    const agentRunCorrections = rows[4];
    if (
      rows.length !== 5 ||
      baseline?.name !== "20260805120000_empty_baseline" ||
      admission?.name !== "20260806124719_durable_message_admission" ||
      resume?.name !== "20260806162306_aberrant_sir_ram" ||
      agentRun?.name !== "20260806183059_fancy_frank_castle" ||
      agentRunCorrections?.name !== "20260806190826_big_inertia"
    ) {
      return yield* new MigrationVerificationError({
        appliedMigrationNames: rows.map((row) => row.name),
      });
    }
    return rows;
  }).pipe(Effect.provide(postgresLayer(config)));

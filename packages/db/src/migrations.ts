import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate as migrateDrizzle } from "drizzle-orm/effect-postgres/migrator";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface DatabaseConfig {
  readonly databaseUrl: string;
  readonly applicationName: string;
  readonly migrationsFolder?: string;
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const postgresLayer = (config: DatabaseConfig) =>
  PgClient.layer({
    applicationName: config.applicationName,
    url: Redacted.make(config.databaseUrl),
  });

export const migrateDatabase = (config: DatabaseConfig) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* migrateDrizzle(db, { migrationsFolder: config.migrationsFolder ?? migrationsFolder });
  }).pipe(Effect.provide(postgresLayer(config)));

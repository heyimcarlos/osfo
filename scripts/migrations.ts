import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";
import emptyBaseline from "../migrations/0001_empty_baseline";

const defaultLocalDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle";

const databaseUrl =
  process.env.OSFO_DATABASE_URL ?? process.env.OSFO_TEST_DATABASE_URL ?? defaultLocalDatabaseUrl;

const pgLayer = PgClient.layer({
  applicationName: "osfo-migrations",
  url: Redacted.make(databaseUrl),
});

const migrationLoader = Migrator.fromRecord({
  "0001_empty_baseline": emptyBaseline,
});

const runMigrations = Migrator.make({})({
  loader: migrationLoader,
});

export const migrate = runMigrations.pipe(Effect.provide(pgLayer));

export const verifyMigrationBaseline = Effect.gen(function* () {
  yield* runMigrations;

  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;

  const baseline = rows[0];
  if (rows.length !== 1 || baseline?.migration_id !== 1 || baseline.name !== "empty_baseline") {
    return yield* Effect.fail(new Error(`Unexpected migration baseline: ${JSON.stringify(rows)}`));
  }

  return baseline;
}).pipe(Effect.provide(pgLayer));

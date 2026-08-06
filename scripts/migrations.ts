import { migrateDatabase, verifyDatabaseMigrations } from "@osfo/db";

const defaultLocalDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle";

const databaseUrl =
  process.env.OSFO_DATABASE_URL ?? process.env.OSFO_TEST_DATABASE_URL ?? defaultLocalDatabaseUrl;

export const migrate = migrateDatabase({
  applicationName: "osfo-migrations",
  databaseUrl,
});

export const verifyMigrationBaseline = verifyDatabaseMigrations({
  applicationName: "osfo-migration-verification",
  databaseUrl,
});

import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const runtimeGroup = "osfo_runtime";
const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export const databaseAccessStatements = (
  databaseName: string,
  migrationRole: string,
  runtimeRoles: ReadonlyArray<string>,
) => {
  const migration = quoteIdentifier(migrationRole);
  const runtimes = runtimeRoles.map(quoteIdentifier).join(", ");
  const group = quoteIdentifier(runtimeGroup);
  const database = quoteIdentifier(databaseName);
  return [
    `DO $$ BEGIN CREATE ROLE ${group} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `GRANT CONNECT ON DATABASE ${database} TO ${migration}, ${runtimes}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${migration}`,
    `GRANT ${migration} TO "postgres" WITH ADMIN OPTION`,
    `GRANT USAGE ON SCHEMA public TO ${group}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${group}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${group}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${group}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${group}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${group}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${group}`,
    `GRANT ${group} TO ${runtimes}`,
  ] as const;
};

export const bootstrapDatabaseAccess = (options: {
  readonly databaseAdminUrl: Redacted.Redacted<URL>;
  readonly databaseName: string;
  readonly migrationRole: string;
  readonly runtimeRoles: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.forEach(
        databaseAccessStatements(options.databaseName, options.migrationRole, options.runtimeRoles),
        (statement) => sql.unsafe(statement),
        { discard: true },
      ),
    );
  }).pipe(
    Effect.provide(
      PgClient.layer({
        applicationName: "osfo-development-database-bootstrap",
        maxConnections: 1,
        url: Redacted.make(Redacted.value(options.databaseAdminUrl).toString()),
      }),
    ),
  );

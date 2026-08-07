import { PgClient } from "@effect/sql-pg";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const runtimeGroup = "osfo_runtime";
const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export class DatabaseAccessOwnerUnavailable extends Data.TaggedError(
  "DatabaseAccessOwnerUnavailable",
) {}

export const databaseAccessStatements = (
  databaseName: string,
  ownerRole: string,
  runtimeRoles: ReadonlyArray<string>,
) => {
  const owner = quoteIdentifier(ownerRole);
  const runtimes = runtimeRoles.map(quoteIdentifier).join(", ");
  const group = quoteIdentifier(runtimeGroup);
  const database = quoteIdentifier(databaseName);
  return [
    `DO $$ BEGIN CREATE ROLE ${group} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `GRANT CONNECT ON DATABASE ${database} TO ${runtimes}`,
    `GRANT USAGE ON SCHEMA public TO ${group}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${group}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${group}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${group}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${group}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${group}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${group}`,
    `GRANT ${group} TO ${runtimes}`,
  ] as const;
};

export const bootstrapDatabaseAccess = (options: {
  readonly databaseAdminUrl: Redacted.Redacted<URL>;
  readonly databaseName: string;
  readonly runtimeRoles: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ownerRows = yield* sql.unsafe<{ readonly ownerRole: string }>(
      'SELECT current_user AS "ownerRole"',
    );
    const ownerRole = ownerRows[0]?.ownerRole;
    if (ownerRole === undefined) return yield* new DatabaseAccessOwnerUnavailable();
    yield* sql.withTransaction(
      Effect.forEach(
        databaseAccessStatements(options.databaseName, ownerRole, options.runtimeRoles),
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

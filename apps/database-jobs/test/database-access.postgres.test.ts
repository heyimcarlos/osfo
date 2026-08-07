import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import { bootstrapDatabaseAccess } from "@osfo/db";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const migrationRole = "osfo_test_migration";
const runtimeRoles = ["osfo_test_transport", "osfo_test_relay", "osfo_test_agentrun"];

describe("development database access bootstrap", () => {
  it.live("grants the migration role and inherited runtime access idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      for (const role of [migrationRole, ...runtimeRoles]) {
        yield* sql.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
      }

      const options = {
        databaseAdminUrl: Redacted.make(new URL(databaseUrl)),
        databaseName: new URL(databaseUrl).pathname.slice(1),
        migrationRole,
        runtimeRoles,
      };
      yield* bootstrapDatabaseAccess(options);
      yield* bootstrapDatabaseAccess(options);

      const memberships = yield* sql.unsafe<{ readonly member: boolean }>(
        `SELECT pg_has_role(role_name, 'osfo_runtime', 'member') AS member
         FROM unnest(ARRAY['osfo_test_transport', 'osfo_test_relay', 'osfo_test_agentrun']) role_name`,
      );
      expect(memberships).toEqual([{ member: true }, { member: true }, { member: true }]);
    }).pipe(
      Effect.provide(
        PgClient.layer({
          applicationName: "osfo-database-bootstrap-test",
          maxConnections: 1,
          url: Redacted.make(databaseUrl),
        }),
      ),
    ),
  );
});

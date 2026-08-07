import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import { bootstrapDatabaseAccess } from "@osfo/db";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRoles = ["osfo_test_transport", "osfo_test_relay", "osfo_test_agentrun"];

describe("development database access bootstrap", () => {
  it.live("grants inherited runtime access idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      for (const role of runtimeRoles) {
        yield* sql.unsafe(
          `DO $$ BEGIN CREATE ROLE "${role}" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
        );
      }

      const options = {
        databaseAdminUrl: Redacted.make(new URL(databaseUrl)),
        databaseName: new URL(databaseUrl).pathname.slice(1),
        runtimeRoles,
      };
      yield* bootstrapDatabaseAccess(options);
      yield* bootstrapDatabaseAccess(options);
      yield* sql.unsafe("DROP TABLE IF EXISTS osfo_runtime_access_probe");
      yield* sql.unsafe("CREATE TABLE osfo_runtime_access_probe (id bigint PRIMARY KEY)");

      const memberships = yield* sql.unsafe<{ readonly member: boolean }>(
        `SELECT pg_has_role(role_name, 'osfo_runtime', 'member') AS member
         FROM unnest(ARRAY['osfo_test_transport', 'osfo_test_relay', 'osfo_test_agentrun']) role_name`,
      );
      expect(memberships).toEqual([{ member: true }, { member: true }, { member: true }]);
      const privileges = yield* sql.unsafe<{ readonly allowed: boolean }>(
        `SELECT has_table_privilege(role_name, 'osfo_runtime_access_probe', 'SELECT') AS allowed
         FROM unnest(ARRAY['osfo_test_transport', 'osfo_test_relay', 'osfo_test_agentrun']) role_name`,
      );
      expect(privileges).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
      yield* sql.unsafe("DROP TABLE osfo_runtime_access_probe");
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

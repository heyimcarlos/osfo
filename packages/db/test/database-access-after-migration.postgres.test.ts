import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

describe("operator migration ownership", () => {
  it.live("grants runtime access to tables created after bootstrap", () =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const privileges = yield* sql.unsafe<{ readonly allowed: boolean }>(
        `SELECT has_table_privilege(role_name, 'agent_runs', 'SELECT, INSERT, UPDATE, DELETE') AS allowed
         FROM unnest(ARRAY['osfo_test_transport', 'osfo_test_relay', 'osfo_test_agentrun']) role_name`,
      );
      expect(privileges).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
    }).pipe(
      Effect.provide(
        PgClient.layer({
          applicationName: "osfo-database-post-migration-access-test",
          maxConnections: 1,
          url: Redacted.make(databaseUrl),
        }),
      ),
    ),
  );
});

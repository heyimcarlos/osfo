import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

describe("D1 migrations", () => {
  it.effect("applies new migrations once and skips them on a repeated apply", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        applyD1Migrations(env.DB, Array.from(env.TEST_DB_MIGRATIONS), "migrations"),
      );
      const appliedCount = yield* Effect.promise(() =>
        env.DB.prepare("SELECT COUNT(*) AS count FROM migrations").first<number>("count"),
      );
      const applicationTables = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        ).all<{ readonly name: string }>(),
      );

      expect(appliedCount).toBe(env.TEST_DB_MIGRATIONS.length);
      expect(applicationTables.results.map(({ name }) => name)).toEqual([
        "agents",
        "allowance_periods",
        "migrations",
        "security_audit_facts",
        "subscriptions",
        "users",
      ]);
    }),
  );

  it.effect("rolls back every statement when a deployment migration fails", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        applyD1Migrations(
          env.DB,
          [
            {
              name: "99999_failed_deployment_probe",
              queries: [
                "CREATE TABLE failed_deployment_probe (id TEXT PRIMARY KEY)",
                "INSERT INTO table_that_does_not_exist (id) VALUES ('failure')",
              ],
            },
          ],
          "failed_deployment_probe_migrations",
        ),
      ).pipe(Effect.exit);
      const createdTable = yield* Effect.promise(() =>
        env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .bind("failed_deployment_probe")
          .first<string>("name"),
      );
      const appliedMigration = yield* Effect.promise(() =>
        env.DB.prepare("SELECT name FROM failed_deployment_probe_migrations WHERE name = ?")
          .bind("99999_failed_deployment_probe")
          .first<string>("name"),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(createdTable).toBeNull();
      expect(appliedMigration).toBeNull();
    }),
  );
});

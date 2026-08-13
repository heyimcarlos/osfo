import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

describe("Directory D1 migrations", () => {
  it.effect("applies new migrations once and skips them on a repeated apply", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        applyD1Migrations(
          env.DIRECTORY_DB,
          Array.from(env.TEST_DIRECTORY_MIGRATIONS),
          "directory_migrations",
        ),
      );
      const appliedCount = yield* Effect.promise(() =>
        env.DIRECTORY_DB.prepare(
          "SELECT COUNT(*) AS count FROM directory_migrations",
        ).first<number>("count"),
      );

      expect(appliedCount).toBe(env.TEST_DIRECTORY_MIGRATIONS.length);
      expect(env.TEST_DIRECTORY_MIGRATION_DIGESTS).toHaveLength(appliedCount ?? 0);
      for (const migration of env.TEST_DIRECTORY_MIGRATION_DIGESTS) {
        expect(migration.digest).toMatch(/^[a-f0-9]{64}$/);
      }
    }),
  );

  it.effect("rolls back every statement when a deployment migration fails", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        applyD1Migrations(
          env.DIRECTORY_DB,
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
        env.DIRECTORY_DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .bind("failed_deployment_probe")
          .first<string>("name"),
      );
      const appliedMigration = yield* Effect.promise(() =>
        env.DIRECTORY_DB.prepare(
          "SELECT name FROM failed_deployment_probe_migrations WHERE name = ?",
        )
          .bind("99999_failed_deployment_probe")
          .first<string>("name"),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(createdTable).toBeNull();
      expect(appliedMigration).toBeNull();
    }),
  );
});

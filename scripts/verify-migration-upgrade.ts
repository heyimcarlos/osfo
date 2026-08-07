import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { migrateDatabase } from "@osfo/db";
import { Config, Effect, Redacted } from "effect";

const baselineMigrations = [
  "20260805120000_empty_baseline",
  "20260806124719_durable_message_admission",
  "20260806162306_aberrant_sir_ram",
] as const;

const sourceMigrations = fileURLToPath(new URL("../packages/db/drizzle", import.meta.url));

const program = Config.nonEmptyString("OSFO_DATABASE_URL").pipe(
  Effect.flatMap((databaseUrl) =>
    Effect.gen(function* () {
      const upgradeDatabaseName = "osfo_upgrade_path";
      const upgradeUrl = new URL(databaseUrl);
      upgradeUrl.pathname = `/${upgradeDatabaseName}`;
      const migrationsFolder = mkdtempSync(join(tmpdir(), "osfo-upgrade-migrations-"));
      for (const migration of baselineMigrations) {
        cpSync(join(sourceMigrations, migration), join(migrationsFolder, migration), {
          recursive: true,
        });
      }
      const adminLayer = PgClient.layer({
        applicationName: "osfo-upgrade-database-admin",
        url: Redacted.make(databaseUrl),
      });
      yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${upgradeDatabaseName} WITH (FORCE)`);
        yield* sql.unsafe(`CREATE DATABASE ${upgradeDatabaseName}`);
      }).pipe(Effect.provide(adminLayer));

      yield* migrateDatabase({
        applicationName: "osfo-upgrade-baseline",
        databaseUrl: upgradeUrl.toString(),
        migrationsFolder,
      });

      const upgradeLayer = PgClient.layer({
        applicationName: "osfo-upgrade-fixture",
        url: Redacted.make(upgradeUrl.toString()),
      });
      yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO principals (principal_id)
          VALUES ('b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid)`;
        yield* sql`INSERT INTO threads (thread_id, principal_id)
          VALUES (
            '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
            'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid
          )`;
        yield* sql`INSERT INTO user_messages (
            user_message_id, thread_id, principal_id, content, created_at
          ) VALUES
            (
              '53146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              'Upgrade running AgentRun',
              transaction_timestamp()
            ),
            (
              '63146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              'Upgrade historical canceled AgentRun',
              transaction_timestamp()
            )`;
        yield* sql`INSERT INTO agent_runs (
            agent_run_id, thread_id, principal_id, user_message_id,
            state, execution_profile_ref, created_at
          ) VALUES
            (
              '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              '53146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              'running',
              'oz.upgrade-fixture.v1',
              transaction_timestamp()
            ),
            (
              '86ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              '63146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              'canceled',
              'oz.upgrade-fixture.v1',
              transaction_timestamp()
            )`;
      }).pipe(Effect.provide(upgradeLayer));

      yield* migrateDatabase({
        applicationName: "osfo-upgrade-current",
        databaseUrl: upgradeUrl.toString(),
      });

      yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly claimEpoch: string;
          readonly claimOwner: string | null;
          readonly leaseExpiresAt: string | null;
          readonly state: string;
        }>`SELECT
            state,
            claim_epoch::text AS "claimEpoch",
            claim_owner AS "claimOwner",
            lease_expires_at::text AS "leaseExpiresAt"
          FROM agent_runs
          WHERE agent_run_id = '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid`;
        const row = rows[0];
        if (
          row?.state !== "pending" ||
          row.claimEpoch !== "0" ||
          row.claimOwner !== null ||
          row.leaseExpiresAt !== null
        ) {
          return yield* Effect.die(new Error("Running AgentRun upgrade fixture was not requeued"));
        }

        const canceledRows = yield* sql<{
          readonly cleanupDisposition: string | null;
          readonly externalWorkMayContinue: boolean | null;
          readonly state: string;
        }>`SELECT
            state,
            cleanup_disposition AS "cleanupDisposition",
            external_work_may_continue AS "externalWorkMayContinue"
          FROM agent_runs
          WHERE agent_run_id = '86ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid`;
        const canceled = canceledRows[0];
        if (
          canceled?.state !== "canceled" ||
          canceled.cleanupDisposition !== "unknown" ||
          canceled.externalWorkMayContinue !== true
        ) {
          return yield* Effect.die(
            new Error(
              "Historical canceled AgentRun upgrade fixture was not preserved conservatively",
            ),
          );
        }
      }).pipe(Effect.provide(upgradeLayer));

      yield* Effect.logInfo("AgentRun upgrade-path fixtures passed");
      rmSync(migrationsFolder, { force: true, recursive: true });
    }),
  ),
);

NodeRuntime.runMain(program);

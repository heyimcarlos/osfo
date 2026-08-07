import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { migrateDatabase } from "@osfo/db";
import { Config, Effect, Redacted } from "effect";

const fixedPointMigrations = [
  "20260805120000_empty_baseline",
  "20260806124719_durable_message_admission",
  "20260806162306_aberrant_sir_ram",
  "20260806183059_fancy_frank_castle",
  "20260806190826_big_inertia",
  "20260806195521_brown_captain_midlands",
  "20260807035039_wild_punisher",
  "20260807044657_brown_havok",
  "20260807045646_warm_wolf_cub",
  "20260807050822_dazzling_mojo",
  "20260807053832_sticky_guardian",
  "20260807064812_thread_event_notifications",
] as const;

const sourceMigrations = fileURLToPath(new URL("../packages/db/drizzle", import.meta.url));

const program = Config.nonEmptyString("OSFO_DATABASE_URL").pipe(
  Effect.flatMap((databaseUrl) =>
    Effect.gen(function* () {
      const upgradeDatabaseName = "osfo_upgrade_path";
      const legacyAstralFragment = "😀".repeat(8_193);
      const upgradeUrl = new URL(databaseUrl);
      upgradeUrl.pathname = `/${upgradeDatabaseName}`;
      const migrationsFolder = mkdtempSync(join(tmpdir(), "osfo-upgrade-migrations-"));
      for (const migration of fixedPointMigrations) {
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
        applicationName: "osfo-upgrade-fixed-point",
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
            state, execution_profile_ref, claim_epoch, claim_owner, lease_expires_at, created_at
          ) VALUES
            (
              '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              '53146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              'running',
              'oz.upgrade-fixture.v1',
              1,
              'upgrade-lost-worker',
              transaction_timestamp() - interval '1 minute',
              transaction_timestamp()
            ),
            (
              '86ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              '63146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              'canceled',
              'oz.upgrade-fixture.v1',
              0,
              NULL,
              NULL,
              transaction_timestamp()
            )`;
        yield* sql`INSERT INTO assistant_outputs (
          assistant_output_id, agent_run_id, state, interruption_cause, created_at, terminated_at
        ) VALUES (
          '36290831-b9ca-414a-abf1-4055b5347133'::uuid,
          '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
          'interrupted', 'modelCallFailed', transaction_timestamp(), transaction_timestamp()
        )`;
        yield* sql`INSERT INTO thread_events (
            thread_id, position, event_id, principal_id, user_message_id, agent_run_id,
            event_type, event_version, payload, occurred_at
          ) VALUES
            (
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              1,
              '7b82a82b-7983-49ca-a054-13b040f9f5da'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              '53146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
              'AssistantOutputAppended',
              1,
              jsonb_build_object(
                'assistantOutputId', '36290831-b9ca-414a-abf1-4055b5347133',
                'agentRunId', '96ae49eb-b1ab-41cb-a468-b68893ec82c3',
                'content', jsonb_build_array(jsonb_build_object(
                  'type', 'text', 'text', ${legacyAstralFragment}::text
                ))
              ),
              transaction_timestamp()
            ),
            (
              '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid,
              2,
              '8b82a82b-7983-49ca-a054-13b040f9f5da'::uuid,
              'b3ef0861-2df7-4d2a-a195-fbc5ed75bc81'::uuid,
              '53146ff7-2205-44b0-8de4-685509112ac9'::uuid,
              '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
              'AssistantOutputInterrupted',
              1,
              jsonb_build_object(
                'assistantOutputId', '36290831-b9ca-414a-abf1-4055b5347133',
                'agentRunId', '96ae49eb-b1ab-41cb-a468-b68893ec82c3',
                'cause', 'modelCallFailed'
              ),
              transaction_timestamp()
            )`;
        yield* sql`INSERT INTO model_calls (
            model_call_id, agent_run_id, model_binding, prompt,
            state, failure_cause, created_at, completed_at
          ) VALUES (
            '0f60df64-c87c-4878-8340-001f23623491'::uuid,
            '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
            'oz.upgrade-binding.v1',
            'Upgrade historical dispatched attempt',
            'failed',
            'modelCallFailed',
            transaction_timestamp(),
            transaction_timestamp()
          )`;
        yield* sql`INSERT INTO model_call_attempts (
            model_call_attempt_id, model_call_id, agent_run_id, assistant_output_id,
            attempt_number, claim_epoch, state, started_at, finished_at
          ) VALUES (
            'dd0496f6-c20f-4c86-bc69-e3138b699f06'::uuid,
            '0f60df64-c87c-4878-8340-001f23623491'::uuid,
            '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
            '36290831-b9ca-414a-abf1-4055b5347133'::uuid,
            1,
            1,
            'failed',
            transaction_timestamp(),
            transaction_timestamp()
          )`;
        yield* sql`INSERT INTO model_call_fragments (
            model_call_id, fragment_index, model_call_attempt_id,
            assistant_output_id, agent_run_id, text, thread_event_id, created_at
          ) VALUES (
            '0f60df64-c87c-4878-8340-001f23623491'::uuid,
            0,
            'dd0496f6-c20f-4c86-bc69-e3138b699f06'::uuid,
            '36290831-b9ca-414a-abf1-4055b5347133'::uuid,
            '96ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
            ${legacyAstralFragment}::text,
            '7b82a82b-7983-49ca-a054-13b040f9f5da'::uuid,
            transaction_timestamp()
          )`;
        yield* sql`UPDATE threads
          SET next_position = 3
          WHERE thread_id = '6ef239bd-3f04-4c77-8976-1171e75ea0ab'::uuid`;
      }).pipe(Effect.provide(upgradeLayer));

      yield* migrateDatabase({
        applicationName: "osfo-upgrade-current",
        databaseUrl: upgradeUrl.toString(),
      });

      yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO assistant_outputs (
            assistant_output_id, agent_run_id, state, created_at
          ) VALUES (
            '46290831-b9ca-414a-abf1-4055b5347133'::uuid,
            '86ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
            'open',
            transaction_timestamp()
          )`;
        yield* sql`INSERT INTO model_calls (
            model_call_id, agent_run_id, model_binding, prompt, state, created_at
          ) VALUES (
            '1f60df64-c87c-4878-8340-001f23623491'::uuid,
            '86ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
            'oz.rolling-base-writer.v1',
            'Base writer after expansion migration',
            'pending',
            transaction_timestamp()
          )`;
        yield* sql`INSERT INTO model_call_attempts (
            model_call_attempt_id, model_call_id, agent_run_id, assistant_output_id,
            attempt_number, claim_epoch, state, started_at
          ) VALUES (
            'ed0496f6-c20f-4c86-bc69-e3138b699f06'::uuid,
            '1f60df64-c87c-4878-8340-001f23623491'::uuid,
            '86ae49eb-b1ab-41cb-a468-b68893ec82c3'::uuid,
            '46290831-b9ca-414a-abf1-4055b5347133'::uuid,
            1,
            1,
            'started',
            transaction_timestamp()
          )`;
        yield* sql`UPDATE model_call_attempts
          SET state = 'succeeded', finished_at = transaction_timestamp()
          WHERE model_call_attempt_id = 'ed0496f6-c20f-4c86-bc69-e3138b699f06'::uuid`;
        const rollingRows = yield* sql<{
          readonly dispatchState: string;
          readonly modelBinding: string | null;
          readonly state: string;
        }>`SELECT
            state,
            model_binding AS "modelBinding",
            dispatch_state AS "dispatchState"
          FROM model_call_attempts
          WHERE model_call_attempt_id = 'ed0496f6-c20f-4c86-bc69-e3138b699f06'::uuid`;
        if (
          rollingRows[0]?.state !== "succeeded" ||
          rollingRows[0].modelBinding !== "oz.rolling-base-writer.v1" ||
          rollingRows[0].dispatchState !== "confirmed"
        ) {
          return yield* Effect.die(
            new Error("Expansion migration did not complete base-writer attempt evidence"),
          );
        }
        yield* sql`UPDATE model_call_attempts
          SET usage_type = 'reported',
              input_units = 4,
              output_units = 5,
              reasoning_units = 7
          WHERE model_call_attempt_id = 'ed0496f6-c20f-4c86-bc69-e3138b699f06'::uuid`;
        const reportedUsageRows = yield* sql<{
          readonly inputUnits: number;
          readonly outputUnits: number;
          readonly reasoningUnits: number;
          readonly usageType: string;
        }>`SELECT
            usage_type AS "usageType",
            input_units AS "inputUnits",
            output_units AS "outputUnits",
            reasoning_units AS "reasoningUnits"
          FROM model_call_attempts
          WHERE model_call_attempt_id = 'ed0496f6-c20f-4c86-bc69-e3138b699f06'::uuid`;
        if (
          reportedUsageRows[0]?.usageType !== "reported" ||
          reportedUsageRows[0].inputUnits !== 4 ||
          reportedUsageRows[0].outputUnits !== 5 ||
          reportedUsageRows[0].reasoningUnits !== 7
        ) {
          return yield* Effect.die(
            new Error("Expansion migration did not preserve distinct reasoning usage"),
          );
        }
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
          row?.state !== "running" ||
          row.claimEpoch !== "1" ||
          row.claimOwner !== "upgrade-lost-worker" ||
          row.leaseExpiresAt === null
        ) {
          return yield* Effect.die(
            new Error("Fixed-point running AgentRun claim was not preserved"),
          );
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
        const eventRows = yield* sql<{
          readonly cause: string;
          readonly eventVersion: number;
        }>`SELECT payload ->> 'cause' AS cause, event_version AS "eventVersion"
          FROM thread_events
          WHERE event_id = '8b82a82b-7983-49ca-a054-13b040f9f5da'::uuid`;
        if (eventRows[0]?.cause !== "modelCallFailed" || eventRows[0].eventVersion !== 1) {
          return yield* Effect.die(
            new Error("Historical V1 model-call interruption was not preserved"),
          );
        }
        const attemptRows = yield* sql<{
          readonly dispatchState: string;
          readonly modelBinding: string;
        }>`SELECT
            dispatch_state AS "dispatchState",
            model_binding AS "modelBinding"
          FROM model_call_attempts
          WHERE model_call_attempt_id = 'dd0496f6-c20f-4c86-bc69-e3138b699f06'::uuid`;
        if (
          attemptRows[0]?.dispatchState !== "confirmed" ||
          attemptRows[0].modelBinding !== "oz.upgrade-binding.v1"
        ) {
          return yield* Effect.die(
            new Error("Historical dispatched ModelCall attempt evidence was not preserved"),
          );
        }
        const fragmentConstraintRows = yield* sql<{
          readonly codeUnits: number;
          readonly constraintValidated: boolean;
          readonly legacyCharacters: number;
        }>`SELECT
            length(fragment.text) AS "legacyCharacters",
            text_utf16_code_units(fragment.text) AS "codeUnits",
            constraint_state.convalidated AS "constraintValidated"
          FROM model_call_fragments fragment
          CROSS JOIN pg_constraint constraint_state
          WHERE fragment.model_call_attempt_id =
              'dd0496f6-c20f-4c86-bc69-e3138b699f06'::uuid
            AND constraint_state.conrelid = 'model_call_fragments'::regclass
            AND constraint_state.conname = 'model_call_fragments_text_check'`;
        if (
          fragmentConstraintRows[0]?.legacyCharacters !== 8_193 ||
          fragmentConstraintRows[0].codeUnits !== 16_386 ||
          fragmentConstraintRows[0].constraintValidated !== false
        ) {
          return yield* Effect.die(
            new Error("Expansion migration did not preserve legacy astral fragment evidence"),
          );
        }
      }).pipe(Effect.provide(upgradeLayer));

      yield* Effect.logInfo("AgentRun upgrade-path fixtures passed");
      rmSync(migrationsFolder, { force: true, recursive: true });
    }),
  ),
);

NodeRuntime.runMain(program);

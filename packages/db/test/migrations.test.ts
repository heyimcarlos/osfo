import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";

import {
  applyMigrations,
  closeTestDatabase,
  makeTestDatabase,
  readMigrations,
} from "./postgres-fixture";

class MigrationConstraintRejected extends Data.TaggedError("MigrationConstraintRejected")<{
  readonly cause: unknown;
}> {}

describe("Postgres migrations", () => {
  it.effect("applies new migrations once and skips them on a repeated apply", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          yield* applyMigrations(client, migrations);
          yield* applyMigrations(client, migrations);
          const applied = yield* Effect.promise(() => client.query("SELECT name FROM migrations"));
          const tables = yield* Effect.promise(() =>
            client.query<{ readonly table_name: string }>(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                ORDER BY table_name
              `),
          );
          const deletionCaseColumns = yield* Effect.promise(() =>
            client.query<{ readonly column_name: string }>(`
              SELECT column_name
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'deletion_cases'
            `),
          );

          expect(applied.rows.length).toBe(migrations.length);
          expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
            "account_deletion_actions",
            "accounts",
            "administrative_authorities",
            "agents",
            "allowance_periods",
            "allowance_usage",
            "billing_checkout_sessions",
            "billing_customers",
            "billing_subscriptions",
            "channel_link_audit_events",
            "channel_link_invites",
            "channel_links",
            "deletion_cases",
            "document_build_notifications",
            "document_builds",
            "migrations",
            "rate_limits",
            "research_report_notifications",
            "research_report_provider_operations",
            "research_report_synthesis_operations",
            "research_reports",
            "scheduled_email_notifications",
            "scheduled_emails",
            "sessions",
            "usage_event_components",
            "usage_event_evidence_references",
            "usage_events",
            "user_suspension_events",
            "users",
            "verifications",
            "webhook_events",
            "webhook_jobs",
            "whatsapp_wakeup_sources",
            "whatsapp_wakeups",
          ]);
          expect(deletionCaseColumns.rows.map(({ column_name }) => column_name)).toContain(
            "access_fenced_at",
          );
        }),
      closeTestDatabase,
    ),
  );

  it.effect("removes only false conservative Gmail facts proven NotApplied", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          const accountingMigration = migrations.find(
            ({ name }) => name === "0028_melted_aaron_stack.sql",
          );
          if (accountingMigration === undefined) {
            return yield* Effect.die(new Error("Scheduled Email accounting migration is missing"));
          }
          yield* applyMigrations(
            client,
            migrations.filter(({ name }) => name < accountingMigration.name),
          );
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('accounting-user', 'Accounting User', 'accounting-user@example.test', now());
              INSERT INTO billing_subscriptions (
                billing_subscription_id, user_id, plan, plan_policy_version
              ) VALUES ('accounting-subscription', 'accounting-user', 'free', 'launch-v1');
              INSERT INTO allowance_periods (
                allowance_period_id, user_id, billing_subscription_id, plan,
                plan_policy_version, starts_at, ends_at
              ) VALUES (
                'accounting-period', 'accounting-user', 'accounting-subscription', 'free',
                'launch-v1', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
              );
              INSERT INTO scheduled_emails (
                workflow_id, action_id, user_id, agent_id, route_id, session_id,
                originating_authority_json, plan, approval_presentation, input_digest,
                request_json, due_at, state, allowance_period_id, plan_policy_version,
                capability_catalog_version, model_access_policy_version, model_route,
                resource_price_version, manifest_version, cloudflare_instance_id,
                provider_log_id, send_outcome, send_accounting_basis, safe_failure_code,
                admitted_at, accepted_at, waiting_at, send_started_at, send_outcome_at,
                send_accounted_at, terminal_at, workflow_start_accounted_at
              ) VALUES
                (
                  'not-applied-workflow', 'not-applied-action', 'accounting-user', 'agent',
                  'route', 'session', '{}', 'free', '{}', repeat('a', 64), '{}',
                  '2026-08-02T00:01:00Z', 'failure', 'accounting-period', 'launch-v1',
                  'launch-v1', 'launch-v1', 'test', 'launch-v1', 'scheduled-email-v1',
                  'not-applied-instance', 'not-applied-log', 'notApplied', 'conservative',
                  'send-not-applied', '2026-08-02T00:00:00Z', '2026-08-02T00:00:01Z',
                  '2026-08-02T00:00:02Z', '2026-08-02T00:01:00Z',
                  '2026-08-02T00:03:00Z', '2026-08-02T00:03:01Z',
                  '2026-08-02T00:03:00Z', '2026-08-02T00:00:03Z'
                ),
                (
                  'ambiguous-workflow', 'ambiguous-action', 'accounting-user', 'agent',
                  'route', 'session', '{}', 'free', '{}', repeat('b', 64), '{}',
                  '2026-08-03T00:01:00Z', 'failure', 'accounting-period', 'launch-v1',
                  'launch-v1', 'launch-v1', 'test', 'launch-v1', 'scheduled-email-v1',
                  'ambiguous-instance', NULL, 'ambiguous', 'conservative',
                  'send-outcome-unknown', '2026-08-03T00:00:00Z', '2026-08-03T00:00:01Z',
                  '2026-08-03T00:00:02Z', '2026-08-03T00:01:00Z',
                  '2026-08-03T00:03:00Z', '2026-08-03T00:06:01Z',
                  '2026-08-03T00:03:00Z', '2026-08-03T00:00:03Z'
                ),
                (
                  'observed-not-applied-workflow', 'observed-not-applied-action',
                  'accounting-user', 'agent', 'route', 'session', '{}', 'free', '{}',
                  repeat('c', 64), '{}', '2026-08-04T00:01:00Z', 'failure',
                  'accounting-period', 'launch-v1', 'launch-v1', 'launch-v1', 'test',
                  'launch-v1', 'scheduled-email-v1', 'observed-not-applied-instance',
                  'observed-not-applied-log', 'notApplied', 'conservative',
                  'send-not-applied', '2026-08-04T00:00:00Z', '2026-08-04T00:00:01Z',
                  '2026-08-04T00:00:02Z', '2026-08-04T00:01:00Z',
                  '2026-08-04T00:03:00Z', '2026-08-04T00:03:01Z',
                  '2026-08-04T00:03:00Z', '2026-08-04T00:00:03Z'
                );
              INSERT INTO allowance_usage (
                allowance_period_id, allowance_kind, source_type, source_id,
                user_id, quantity, basis
              ) VALUES
                (
                  'accounting-period', 'gmailSends', 'integrationAction',
                  'not-applied-action', 'accounting-user', 1, 'conservative'
                ),
                (
                  'accounting-period', 'gmailSends', 'integrationAction',
                  'ambiguous-action', 'accounting-user', 1, 'conservative'
                ),
                (
                  'accounting-period', 'gmailSends', 'integrationAction',
                  'observed-not-applied-action', 'accounting-user', 1, 'observed'
                );
            `),
          );

          yield* applyMigrations(client, migrations);
          const emails = yield* Effect.promise(() =>
            client.query<{
              readonly action_id: string;
              readonly send_accounting_basis: string | null;
              readonly send_reconciliation_claimed_at: Date | null;
              readonly send_reconciliation_lease_expires_at: Date | null;
              readonly send_reconciliation_recovery_used: boolean;
            }>(`
              SELECT action_id, send_accounting_basis, send_reconciliation_claimed_at,
                     send_reconciliation_lease_expires_at, send_reconciliation_recovery_used
              FROM scheduled_emails
              ORDER BY action_id
            `),
          );
          const usage = yield* Effect.promise(() =>
            client.query<{ readonly source_id: string }>(`
              SELECT source_id
              FROM allowance_usage
              WHERE allowance_kind = 'gmailSends'
              ORDER BY source_id
            `),
          );

          expect(emails.rows).toEqual([
            {
              action_id: "ambiguous-action",
              send_accounting_basis: "conservative",
              send_reconciliation_claimed_at: null,
              send_reconciliation_lease_expires_at: null,
              send_reconciliation_recovery_used: false,
            },
            {
              action_id: "not-applied-action",
              send_accounting_basis: null,
              send_reconciliation_claimed_at: null,
              send_reconciliation_lease_expires_at: null,
              send_reconciliation_recovery_used: false,
            },
            {
              action_id: "observed-not-applied-action",
              send_accounting_basis: "conservative",
              send_reconciliation_claimed_at: null,
              send_reconciliation_lease_expires_at: null,
              send_reconciliation_recovery_used: false,
            },
          ]);
          expect(usage.rows).toEqual([
            { source_id: "ambiguous-action" },
            { source_id: "observed-not-applied-action" },
          ]);
          const partialLease = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                UPDATE scheduled_emails
                SET send_accounting_basis = null,
                    send_accounted_at = null,
                    send_reconciliation_claimed_at = '2026-08-03T00:04:59Z'
                WHERE workflow_id = 'ambiguous-workflow'
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(partialLease)).toBe(true);
          const oversizedLease = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                UPDATE scheduled_emails
                SET send_accounting_basis = null,
                    send_accounted_at = null,
                    send_reconciliation_claimed_at = '2026-08-03T00:04:59Z',
                    send_reconciliation_lease_expires_at = '2026-08-03T00:07:01Z'
                WHERE workflow_id = 'ambiguous-workflow'
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(oversizedLease)).toBe(true);
          const mismatchedRecoveryState = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                UPDATE scheduled_emails
                SET send_accounting_basis = null,
                    send_accounted_at = null,
                    send_reconciliation_claimed_at = '2026-08-03T00:04:59Z',
                    send_reconciliation_lease_expires_at = '2026-08-03T00:05:59Z',
                    send_reconciliation_recovery_used = true
                WHERE workflow_id = 'ambiguous-workflow'
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(mismatchedRecoveryState)).toBe(true);
          const preSendLease = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                UPDATE scheduled_emails
                SET send_accounting_basis = null,
                    send_accounted_at = null,
                    send_reconciliation_claimed_at = '2026-08-03T00:00:59Z',
                    send_reconciliation_lease_expires_at = '2026-08-03T00:01:00Z',
                    send_reconciliation_recovery_used = false
                WHERE workflow_id = 'ambiguous-workflow'
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(preSendLease)).toBe(true);
          return undefined;
        }),
      closeTestDatabase,
    ),
  );

  it.effect("enforces one active WhatsApp Wake-up per User and closed lifecycle rows", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          yield* applyMigrations(client);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, locale, registration_completed_at, updated_at)
              VALUES ('wakeup-user', 'Wake-up User', 'wakeup@example.test', 'en', now(), now());
              INSERT INTO channel_links (channel_link_id, channel_id, author_id, user_id)
              VALUES ('wakeup-link', 'whatsapp', '15551234567', 'wakeup-user');
              INSERT INTO whatsapp_wakeups (
                wakeup_id, fingerprint, user_id, channel_link_id, endpoint_fingerprint,
                source_kind, source_identity, source_committed_at, locale,
                template_policy_version, trace_id
              ) VALUES (
                'wakeup-1', repeat('a', 64), 'wakeup-user', 'wakeup-link', repeat('b', 64),
                'reminder', 'reminder-1', now(), 'en', 'whatsapp-wakeup-v1', 'trace-1'
              );
            `),
          );

          const secondActive = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                INSERT INTO whatsapp_wakeups (
                  wakeup_id, fingerprint, user_id, channel_link_id, endpoint_fingerprint,
                  source_kind, source_identity, source_committed_at, locale,
                  template_policy_version, trace_id
                ) VALUES (
                  'wakeup-2', repeat('c', 64), 'wakeup-user', 'wakeup-link', repeat('d', 64),
                  'researchReport', 'report-1', now(), 'en', 'whatsapp-wakeup-v1', 'trace-2'
                )
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(secondActive)).toBe(true);

          const invalidAccepted = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                UPDATE whatsapp_wakeups
                SET state = 'accepted', provider_outcome = 'accepted', settled_at = now()
                WHERE wakeup_id = 'wakeup-1'
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(invalidAccepted)).toBe(true);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("backfills retained administrative cases before adding the authority foreign key", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          const authorityMigration = migrations.find(
            ({ name }) => name === "0009_dashing_vin_gonzales.sql",
          );
          if (authorityMigration === undefined) {
            return yield* Effect.die(new Error("Administrative authority migration is missing"));
          }
          yield* applyMigrations(
            client,
            migrations.filter(({ name }) => name !== authorityMigration.name),
          );
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('legacy-user', 'Legacy User', 'legacy-user@example.test', now());
              INSERT INTO deletion_cases (
                deletion_case_id, user_id, requested_by_admin_id, reason
              ) VALUES (
                'legacy-deletion-case', 'legacy-user', 'legacy-admin', 'Required erasure'
              );
            `),
          );

          yield* applyMigrations(client, migrations);
          const authorities = yield* Effect.promise(() =>
            client.query<{ readonly admin_actor_id: string; readonly revoked_at: Date | null }>(`
              SELECT admin_actor_id, revoked_at
              FROM administrative_authorities
              WHERE admin_actor_id = 'legacy-admin'
            `),
          );

          expect(authorities.rows).toEqual([{ admin_actor_id: "legacy-admin", revoked_at: null }]);
          const rejected = yield* Effect.tryPromise({
            try: () =>
              client.exec(`
                INSERT INTO users (id, name, email, updated_at)
                VALUES ('new-user', 'New User', 'new-user@example.test', now());
                INSERT INTO deletion_cases (
                  deletion_case_id, user_id, requested_by_admin_id, reason
                ) VALUES (
                  'new-deletion-case', 'new-user', 'unknown-admin', 'Required erasure'
                );
              `),
            catch: (cause) => new MigrationConstraintRejected({ cause }),
          }).pipe(Effect.exit);
          expect(Exit.isFailure(rejected)).toBe(true);
          return undefined;
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rejects malformed deletion actors before the approval migration", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          yield* applyMigrations(
            client,
            migrations.filter(({ name }) => name <= "0006_milky_bishop.sql"),
          );
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('staged-user', 'Staged User', 'staged-user@example.test', now()),
                     ('   ', 'Blank User', 'blank-staged-user@example.test', now());
              INSERT INTO deletion_cases (
                deletion_case_id, user_id, requested_by_user_id, reason
              ) VALUES (
                'staged-valid-self-case', 'staged-user', 'staged-user', 'User request'
              );
            `),
          );

          const malformedStatements = [
            `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, requested_by_user_id, reason)
             VALUES ('staged-null-actors', 'staged-user', NULL, NULL, 'User request')`,
            `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_user_id, reason)
             VALUES ('staged-blank-requester', '   ', '   ', 'User request')`,
          ];
          for (const statement of malformedStatements) {
            const result = yield* Effect.tryPromise({
              try: () => client.exec(statement),
              catch: (cause) => new MigrationConstraintRejected({ cause }),
            }).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
          }
        }),
      closeTestDatabase,
    ),
  );

  it.effect(
    "binds consumed account deletion actions to a deletion case owned by the same User",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        ({ client }) =>
          Effect.gen(function* () {
            yield* applyMigrations(client);
            yield* Effect.promise(() =>
              client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('action-user-1', 'Action User 1', 'action-1@example.test', now()),
                     ('action-user-2', 'Action User 2', 'action-2@example.test', now()),
                     ('action-user-3', 'Action User 3', 'action-3@example.test', now()),
                     ('   ', 'Blank User', 'blank-action-user@example.test', now());
              INSERT INTO administrative_authorities (admin_actor_id)
              VALUES ('action-admin');
              INSERT INTO deletion_cases (
                deletion_case_id, user_id, requested_by_admin_id, reason
              ) VALUES
                ('action-case-1', 'action-user-1', 'action-admin', 'Required erasure'),
                ('action-case-2', 'action-user-2', 'action-admin', 'Required erasure');
              INSERT INTO account_deletion_actions (
                action_id, user_id, auth_session_id, replay_token_hash,
                presentation, presentation_version,
                expires_at, consumed_at, deletion_case_id
              ) VALUES (
                'action-exact', 'action-user-1', 'session-1', repeat('a', 64),
                '{}', 'account-deletion-v1',
                now() + interval '5 minutes', now(), 'action-case-1'
              );
              INSERT INTO account_deletion_actions (
                action_id, user_id, auth_session_id, replay_token_hash,
                presentation, presentation_version, expires_at
              ) VALUES (
                'action-unconsumed', 'action-user-3', 'session-3', repeat('b', 64), '{}',
                'account-deletion-v1', now() + interval '5 minutes'
              );
            `),
            );

            const rejectedStatements = [
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version,
               expires_at, consumed_at, deletion_case_id
             ) VALUES (
               'action-missing-case', 'action-user-3', 'session-3', repeat('c', 64), '{}',
               'account-deletion-v1', now() + interval '5 minutes', now(), 'missing-case'
             )`,
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version,
               expires_at, consumed_at, deletion_case_id
             ) VALUES (
               'action-wrong-user', 'action-user-1', 'session-1', repeat('d', 64), '{}',
               'account-deletion-v1', now() + interval '5 minutes', now(), 'action-case-2'
             )`,
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version,
               expires_at, consumed_at
             ) VALUES (
               'action-consumed-without-case', 'action-user-3', 'session-3', repeat('e', 64), '{}',
               'account-deletion-v1', now() + interval '5 minutes', now()
             )`,
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version,
               expires_at, consumed_at, deletion_case_id
             ) VALUES (
               'action-consumed-blank-case', 'action-user-3', 'session-3', repeat('f', 64), '{}',
               'account-deletion-v1', now() + interval '5 minutes', now(), '   '
             )`,
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version,
               expires_at, deletion_case_id
             ) VALUES (
               'action-unconsumed-with-case', 'action-user-3', 'session-3', repeat('0', 64), '{}',
               'account-deletion-v1', now() + interval '5 minutes', 'action-case-1'
             )`,
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version, expires_at
             ) VALUES (
               'action-blank-user', '   ', 'session-blank-user', repeat('1', 64), '{}',
               'account-deletion-v1', now() + interval '5 minutes'
             )`,
              `INSERT INTO account_deletion_actions (
               action_id, user_id, auth_session_id, replay_token_hash,
               presentation, presentation_version, expires_at
             ) VALUES (
               'action-bad-replay-hash', 'action-user-3', 'session-3', 'not-a-sha256', '{}',
               'account-deletion-v1', now() + interval '5 minutes'
             )`,
            ];

            for (const statement of rejectedStatements) {
              const result = yield* Effect.tryPromise({
                try: () => client.exec(statement),
                catch: (cause) => new MigrationConstraintRejected({ cause }),
              }).pipe(Effect.exit);
              expect(Exit.isFailure(result)).toBe(true);
            }
          }),
        closeTestDatabase,
      ),
  );

  it.effect("enforces Channel Link lifecycle and active-address invariants", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          yield* applyMigrations(client);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at, registration_completed_at)
              VALUES ('channel-user-1', 'Channel User 1', 'channel-1@example.test', now(), now()),
                     ('channel-user-2', 'Channel User 2', 'channel-2@example.test', now(), now());
              INSERT INTO channel_link_invites (
                invite_id, channel_id, author_id, token_hash, expires_at
              ) VALUES (
                'invite-1', 'telegram:bot-1', 'author-1', repeat('a', 64), now() + interval '1 day'
              );
              INSERT INTO channel_links (channel_link_id, channel_id, author_id, user_id)
              VALUES ('link-1', 'telegram:bot-1', 'author-2', 'channel-user-1');
            `),
          );

          const rejectedStatements = [
            `INSERT INTO channel_link_invites
               (invite_id, channel_id, author_id, token_hash, expires_at)
             VALUES ('invite-duplicate', 'telegram:bot-1', 'author-1', repeat('b', 64), now() + interval '1 day')`,
            `INSERT INTO channel_link_invites
               (invite_id, channel_id, author_id, token_hash, expires_at)
             VALUES ('invite-hash-collision', 'telegram:bot-2', 'author-3', repeat('a', 64), now() + interval '1 day')`,
            `INSERT INTO channel_link_invites
               (invite_id, channel_id, author_id, token_hash, expires_at)
             VALUES ('invite-hash-format', 'telegram:bot-2', 'author-3', 'not-a-sha256', now() + interval '1 day')`,
            `UPDATE channel_link_invites
             SET state = 'accepted', accepted_at = now(), accepted_user_id = 'channel-user-1'
             WHERE invite_id = 'invite-1'`,
            `INSERT INTO channel_links (channel_link_id, channel_id, author_id, user_id)
             VALUES ('link-duplicate', 'telegram:bot-1', 'author-2', 'channel-user-2')`,
            `UPDATE channel_links SET revoked_at = now() WHERE channel_link_id = 'link-1'`,
            `UPDATE channel_links
             SET revoked_at = now(), revoked_by = 'user:channel-user-1',
                 revocation_reason = repeat('x', 201)
             WHERE channel_link_id = 'link-1'`,
            `UPDATE channel_link_invites
             SET state = 'accepted', accepted_at = now(), accepted_user_id = 'channel-user-1',
                 accepted_channel_link_id = 'link-missing'
             WHERE invite_id = 'invite-1'`,
            `INSERT INTO channel_link_audit_events (event_id, event_type, actor_id)
             VALUES ('event-type', 'unknown', 'actor-1')`,
            `INSERT INTO channel_link_audit_events (event_id, event_type, actor_id)
             VALUES ('event-actor', 'invite_issued', '   ')`,
          ];

          for (const statement of rejectedStatements) {
            const result = yield* Effect.tryPromise({
              try: () => client.exec(statement),
              catch: (cause) => new MigrationConstraintRejected({ cause }),
            }).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
          }

          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO channel_links (channel_link_id, channel_id, author_id, user_id)
              VALUES ('link-accepted', 'telegram:bot-1', 'author-accepted', 'channel-user-1');
              UPDATE channel_link_invites
              SET state = 'accepted', accepted_at = now(), accepted_user_id = 'channel-user-1',
                  accepted_channel_link_id = 'link-accepted'
              WHERE invite_id = 'invite-1';
              UPDATE channel_links
              SET revoked_at = now(), revoked_by = 'channel-user-1', revocation_reason = 'user-request'
              WHERE channel_link_id = 'link-1';
              INSERT INTO channel_links (channel_link_id, channel_id, author_id, user_id)
              VALUES ('link-2', 'telegram:bot-1', 'author-2', 'channel-user-2');
            `),
          );
        }),
      closeTestDatabase,
    ),
  );

  it.effect("enforces Research Report running, manifest, artifact, and safe-terminal truth", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          yield* applyMigrations(client);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at, registration_completed_at)
              VALUES ('report-user', 'Report User', 'report@example.test', now(), now());
              INSERT INTO billing_subscriptions (
                billing_subscription_id, plan, plan_policy_version, user_id
              ) VALUES ('report-subscription', 'free', 'launch-v1', 'report-user');
              INSERT INTO allowance_periods (
                allowance_period_id, billing_subscription_id, ends_at, plan,
                plan_policy_version, starts_at, user_id
              ) VALUES (
                'report-period', 'report-subscription', now() + interval '30 days',
                'free', 'launch-v1', now() - interval '1 minute', 'report-user'
              );
              INSERT INTO research_reports (
                workflow_id, action_id, user_id, agent_id, route_id, session_id,
                originating_authority_json, input_digest, request_json, state,
                allowance_period_id, plan_policy_version, capability_catalog_version,
                model_access_policy_version, model_route, resource_price_version,
                cloudflare_instance_id, admitted_at, deadline_at, accepted_at
              ) VALUES (
                'report-lifecycle', 'report-action', 'report-user', 'report-agent',
                'report-route', 'report-session', '{}', repeat('a', 64), '{}', 'accepted',
                'report-period', 'launch-v1', 'capability-v1', 'model-v1', 'route-v1',
                'prices-v1', 'report-lifecycle', now(), now() + interval '1 hour', now()
              );
            `),
          );

          const reject = (statement: string) =>
            Effect.tryPromise({
              try: () => client.exec(statement),
              catch: (cause) => new MigrationConstraintRejected({ cause }),
            }).pipe(Effect.exit);

          expect(
            Exit.isFailure(
              yield* reject(
                `UPDATE research_reports SET state = 'running' WHERE workflow_id = 'report-lifecycle'`,
              ),
            ),
          ).toBe(true);
          yield* Effect.promise(() =>
            client.exec(
              `UPDATE research_reports SET state = 'running', started_at = now() WHERE workflow_id = 'report-lifecycle'`,
            ),
          );
          expect(
            Exit.isFailure(
              yield* reject(
                `UPDATE research_reports SET state = 'sources_committed' WHERE workflow_id = 'report-lifecycle'`,
              ),
            ),
          ).toBe(true);
          yield* Effect.promise(() =>
            client.exec(
              `UPDATE research_reports SET state = 'sources_committed', source_manifest_key = 'users/report/manifest.json', source_manifest_digest = repeat('b', 64), sources_committed_at = now() WHERE workflow_id = 'report-lifecycle'`,
            ),
          );
          expect(
            Exit.isFailure(
              yield* reject(
                `UPDATE research_reports SET state = 'artifact_stored', artifact_content_id = 'document:report' WHERE workflow_id = 'report-lifecycle'`,
              ),
            ),
          ).toBe(true);
          yield* Effect.promise(() =>
            client.exec(
              `UPDATE research_reports SET state = 'artifact_stored', artifact_content_id = 'document:report', artifact_stored_at = now() WHERE workflow_id = 'report-lifecycle'`,
            ),
          );
          expect(
            Exit.isFailure(
              yield* reject(
                `UPDATE research_reports SET state = 'publication_committed' WHERE workflow_id = 'report-lifecycle'`,
              ),
            ),
          ).toBe(true);
          yield* Effect.promise(() =>
            client.exec(
              `UPDATE research_reports SET state = 'publication_committed', publication_committed_at = now() WHERE workflow_id = 'report-lifecycle'`,
            ),
          );
          expect(
            Exit.isFailure(
              yield* reject(
                `UPDATE research_reports SET state = 'success', terminal_at = now(), safe_failure_code = 'not-allowed' WHERE workflow_id = 'report-lifecycle'`,
              ),
            ),
          ).toBe(true);
          yield* Effect.promise(() =>
            client.exec(
              `UPDATE research_reports SET state = 'success', terminal_at = now() WHERE workflow_id = 'report-lifecycle'`,
            ),
          );
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rolls back every statement when a deployment migration fails", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const result = yield* applyMigrations(client, [
            {
              name: "99999_failed_deployment_probe.sql",
              statements: [
                "CREATE TABLE failed_deployment_probe (id text PRIMARY KEY)",
                "INSERT INTO table_that_does_not_exist (id) VALUES ('failure')",
              ],
            },
          ]).pipe(Effect.exit);
          const createdTable = yield* Effect.promise(() =>
            client.query<{ readonly table_name: string }>(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = 'failed_deployment_probe'
              `),
          );
          const appliedMigration = yield* Effect.promise(() =>
            client.query<{ readonly name: string }>(`
                SELECT name
                FROM migrations
                WHERE name = '99999_failed_deployment_probe.sql'
              `),
          );

          expect(Exit.isFailure(result)).toBe(true);
          expect(createdTable.rows).toEqual([]);
          expect(appliedMigration.rows).toEqual([]);
        }),
      closeTestDatabase,
    ),
  );

  it.effect(
    "enforces the billing and allowance ownership, time, quantity, and retry invariants",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        ({ client }) =>
          Effect.gen(function* () {
            yield* applyMigrations(client);
            yield* Effect.promise(() =>
              client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('user-1', 'User 1', 'user-1@example.test', now()),
                     ('user-2', 'User 2', 'user-2@example.test', now()),
                     ('   ', 'Blank User', 'blank-self-user@example.test', now());
              INSERT INTO billing_subscriptions (
                billing_subscription_id, user_id, plan, plan_policy_version
              ) VALUES
                ('subscription-1', 'user-1', 'free', 'launch-v1'),
                ('subscription-2', 'user-2', 'free', 'launch-v1');
              INSERT INTO allowance_periods (
                allowance_period_id, user_id, billing_subscription_id,
                plan, plan_policy_version, starts_at, ends_at
              ) VALUES (
                'period-1', 'user-1', 'subscription-1',
                'free', 'launch-v1', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
              );
              INSERT INTO administrative_authorities (admin_actor_id)
              VALUES ('admin-1');
              INSERT INTO deletion_cases (
                deletion_case_id, user_id, requested_by_admin_id, reason
              ) VALUES ('deletion-case-1', 'user-1', 'admin-1', 'User request');
            `),
            );

            const rejectedStatements = [
              `INSERT INTO billing_subscriptions
               (billing_subscription_id, user_id, plan, plan_policy_version)
             VALUES ('subscription-duplicate', 'user-1', 'free', 'launch-v1')`,
              `INSERT INTO allowance_periods
               (allowance_period_id, user_id, billing_subscription_id,
                plan, plan_policy_version, starts_at, ends_at)
             VALUES ('period-invalid-bounds', 'user-1', 'subscription-1',
                     'free', 'launch-v1', '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
              `INSERT INTO allowance_periods
               (allowance_period_id, user_id, billing_subscription_id,
                plan, plan_policy_version, starts_at, ends_at)
             VALUES ('period-duplicate-start', 'user-1', 'subscription-1',
                     'free', 'launch-v1', '2026-08-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
              `INSERT INTO allowance_periods
               (allowance_period_id, user_id, billing_subscription_id,
                plan, plan_policy_version, starts_at, ends_at)
             VALUES ('period-wrong-owner', 'user-1', 'subscription-2',
                     'free', 'launch-v1', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
              `INSERT INTO allowance_usage
               (user_id, allowance_period_id, allowance_kind, source_type, source_id, quantity, basis)
             VALUES ('user-1', 'period-1', 'acceptedMessages', 'acceptanceReceipt', 'receipt-0', 0, 'observed')`,
              `INSERT INTO allowance_usage
               (user_id, allowance_period_id, allowance_kind, source_type, source_id, quantity, basis)
             VALUES ('user-2', 'period-1', 'acceptedMessages', 'acceptanceReceipt', 'receipt-owner', 1, 'observed')`,
              `INSERT INTO allowance_usage
               (user_id, allowance_period_id, allowance_kind, source_type, source_id, quantity, basis)
             VALUES ('user-1', 'period-1', 'acceptedMessages', 'acceptanceReceipt', 'receipt-basis', 1, 'estimated')`,
              `INSERT INTO user_suspension_events
               (event_id, user_id, action, admin_actor_id, reason)
             VALUES ('event-invalid-action', 'user-1', 'paused', 'admin-1', 'Invalid action')`,
              `INSERT INTO user_suspension_events
               (event_id, user_id, action, admin_actor_id, reason)
             VALUES ('event-empty-reason', 'user-1', 'suspended', 'admin-1', '')`,
              `INSERT INTO user_suspension_events
               (event_id, user_id, action, admin_actor_id, reason)
             VALUES ('event-blank-actor', 'user-1', 'suspended', '   ', 'Valid reason')`,
              `INSERT INTO user_suspension_events
               (event_id, user_id, action, admin_actor_id, reason)
             VALUES ('event-blank-reason', 'user-1', 'suspended', 'admin-1', '   ')`,
              `INSERT INTO administrative_authorities (admin_actor_id)
             VALUES ('   ')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-blank-actor', 'user-2', '   ', 'Valid reason')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-untrusted-admin', 'user-2', 'admin-2', 'Valid reason')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-blank-reason', 'user-2', 'admin-1', '   ')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-duplicate', 'user-1', 'admin-1', 'Duplicate')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_user_id, reason)
             VALUES ('self-case-null-action', 'user-2', 'user-2', 'User request')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, approval_action_id, approval_presentation, reason)
             VALUES ('self-case-null-requester', 'user-2',
                     'account-delete:null-requester', '{}', 'User request')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_user_id, approval_action_id,
                approval_presentation, reason)
             VALUES ('self-case-null-presentation', 'user-2', 'user-2',
                     'account-delete:null-presentation', NULL, 'User request')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_user_id, approval_action_id,
                approval_presentation, reason)
             VALUES ('self-case-blank-action', 'user-2', 'user-2', '   ', '{}', 'User request')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_user_id, approval_action_id,
                approval_presentation, reason)
             VALUES ('self-case-blank-presentation', 'user-2', 'user-2',
                     'account-delete:blank-presentation', '   ', 'User request')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_user_id, approval_action_id,
                approval_presentation, reason)
             VALUES ('self-case-blank-requester', '   ', '   ',
                     'account-delete:blank-requester', '{}', 'User request')`,
            ];

            for (const statement of rejectedStatements) {
              const result = yield* Effect.tryPromise({
                try: () => client.exec(statement),
                catch: (cause) => new MigrationConstraintRejected({ cause }),
              }).pipe(Effect.exit);
              expect(Exit.isFailure(result)).toBe(true);
            }

            yield* Effect.promise(() =>
              client.exec(`
              INSERT INTO allowance_usage
                (user_id, allowance_period_id, allowance_kind, source_type, source_id, quantity, basis)
              VALUES ('user-1', 'period-1', 'acceptedMessages', 'acceptanceReceipt', 'receipt-1', 1, 'observed')
            `),
            );
            const duplicate = yield* Effect.tryPromise({
              try: () =>
                client.exec(`
                INSERT INTO allowance_usage
                  (user_id, allowance_period_id, allowance_kind, source_type, source_id, quantity, basis)
                VALUES ('user-1', 'period-1', 'acceptedMessages', 'acceptanceReceipt', 'receipt-1', 1, 'observed')
              `),
              catch: (cause) => new MigrationConstraintRejected({ cause }),
            }).pipe(Effect.exit);

            expect(Exit.isFailure(duplicate)).toBe(true);
          }),
        closeTestDatabase,
      ),
  );

  it.effect("rejects malformed Plan Usage ledger facts", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          yield* applyMigrations(client);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('usage-user-1', 'Usage User', 'usage@example.test', now());
              INSERT INTO billing_subscriptions (
                billing_subscription_id, user_id, plan, plan_policy_version
              ) VALUES ('usage-subscription-1', 'usage-user-1', 'free', 'shared-usage-v1');
              INSERT INTO allowance_periods (
                allowance_period_id, user_id, billing_subscription_id,
                plan, plan_policy_version, starts_at, ends_at
              ) VALUES (
                'usage-period-1', 'usage-user-1', 'usage-subscription-1',
                'free', 'shared-usage-v1', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
              );
              INSERT INTO usage_events (
                allowance_period_id, capability_catalog_version, facts_json,
                model_access_policy_version, occurred_at, outcome, plan_usage_micros,
                rated_cost_usd_micros, root_operation_id, source_id, source_type,
                usage_policy_version, user_id
              ) VALUES (
                'usage-period-1', 'governed-capabilities-v1', '{
                  "allowancePeriodId":"usage-period-1",
                  "capabilityCatalogVersion":"governed-capabilities-v1",
                  "evidenceReferences":[],
                  "manifestVersion":null,
                  "modelAccessPolicyVersion":"managed-routing-v1",
                  "occurredAt":"2026-08-24T00:00:00.000Z",
                  "outcome":{"_tag":"Completed","charge":{}},
                  "rootOperationId":"usage-root-1",
                  "source":{"sourceId":"usage-source-1","sourceType":"testOperation"},
                  "usagePolicyVersion":"shared-usage-v1"
                }',
                'managed-routing-v1', now(), 'completed', 1, 1,
                'usage-root-1', 'usage-source-1', 'testOperation',
                'shared-usage-v1', 'usage-user-1'
              );
            `),
          );

          const rejectedStatements = [
            `INSERT INTO usage_events (
               allowance_period_id, capability_catalog_version, facts_json,
               model_access_policy_version, occurred_at, outcome, plan_usage_micros,
               rated_cost_usd_micros, root_operation_id, source_id, source_type,
               usage_policy_version, user_id
             ) VALUES (
               'usage-period-1', 'governed-capabilities-v1', '{
                 "allowancePeriodId":"usage-period-1",
                 "capabilityCatalogVersion":"governed-capabilities-v1",
                 "evidenceReferences":[],
                 "manifestVersion":null,
                 "modelAccessPolicyVersion":"managed-routing-v1",
                 "occurredAt":"2026-08-24T00:00:00.000Z",
                 "outcome":{"_tag":"Completed","charge":{}},
                 "rootOperationId":"conversion-root",
                 "source":{"sourceId":"conversion-source","sourceType":"testOperation"},
                 "usagePolicyVersion":"shared-usage-v1"
               }',
               'managed-routing-v1', now(), 'completed', 1, 700,
               'conversion-root', 'conversion-source', 'testOperation',
               'shared-usage-v1', 'usage-user-1'
             )`,
            `INSERT INTO usage_events (
               allowance_period_id, capability_catalog_version, facts_json,
               model_access_policy_version, occurred_at, outcome, plan_usage_micros,
               rated_cost_usd_micros, root_operation_id, source_id, source_type,
               usage_policy_version, user_id
             ) VALUES (
               'usage-period-1', 'governed-capabilities-v1', '{}',
               'managed-routing-v1', now(), 'completed', 1, 1,
               'malformed-root', 'malformed-source', 'testOperation',
               'shared-usage-v1', 'usage-user-1'
             )`,
            `INSERT INTO usage_event_components (
               activity, allowance_period_id, component_index, component_kind, evidence_json,
               rated_cost_usd_micros, resource_price_version, source_id, source_type
             ) VALUES (
               'unknown', 'usage-period-1', 0, 'model', '{}', 1,
               'resource-prices-v1', 'usage-source-1', 'testOperation'
             )`,
            `INSERT INTO usage_event_components (
               activity, allowance_period_id, component_index, component_kind, evidence_json,
               rated_cost_usd_micros, resource_price_version, source_id, source_type
             ) VALUES (
               'automations', 'usage-period-1', 1, 'unknown', '{}', 1,
               'resource-prices-v1', 'usage-source-1', 'testOperation'
             )`,
            `INSERT INTO usage_event_components (
               activity, allowance_period_id, component_index, component_kind, evidence_json,
               rated_cost_usd_micros, resource_price_version, source_id, source_type
             ) VALUES (
               'automations', 'usage-period-1', -1, 'model', '{}', 1,
               'resource-prices-v1', 'usage-source-1', 'testOperation'
             )`,
            `INSERT INTO usage_event_evidence_references (
               allowance_period_id, reference, reference_kind, source_id, source_type
             ) VALUES (
               'usage-period-1', 'provider-log-1', 'unknown',
               'usage-source-1', 'testOperation'
             )`,
            `INSERT INTO usage_event_evidence_references (
               allowance_period_id, reference, reference_kind, source_id, source_type
             ) VALUES (
               'usage-period-1', '   ', 'providerLog',
               'usage-source-1', 'testOperation'
             )`,
          ];

          for (const statement of rejectedStatements) {
            const result = yield* Effect.tryPromise({
              try: () => client.exec(statement),
              catch: (cause) => new MigrationConstraintRejected({ cause }),
            }).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
          }
        }),
      closeTestDatabase,
    ),
  );

  it.effect("enforces Stripe billing projection and webhook invariants", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          yield* applyMigrations(client);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('stripe-user-1', 'Stripe User 1', 'stripe-1@example.test', now()),
                     ('stripe-user-2', 'Stripe User 2', 'stripe-2@example.test', now());
              INSERT INTO billing_subscriptions (
                billing_subscription_id, user_id, plan, plan_policy_version
              ) VALUES
                ('stripe-subscription-local-1', 'stripe-user-1', 'free', 'launch-v1'),
                ('stripe-subscription-local-2', 'stripe-user-2', 'free', 'launch-v1');
              INSERT INTO billing_customers (billing_customer_id, user_id, stripe_customer_id)
              VALUES ('billing-customer-1', 'stripe-user-1', 'cus_customer1');
              INSERT INTO billing_checkout_sessions (
                billing_checkout_session_id, user_id, billing_customer_id, target_plan,
                stripe_product_id, stripe_price_id, state
              ) VALUES (
                'checkout-attempt-1', 'stripe-user-1', 'billing-customer-1', 'adventurer',
                'prod_adventurer', 'price_adventurer', 'creating'
              );
              INSERT INTO webhook_events (
                webhook_event_id, provider, external_event_id, event_type, payload_json
              ) VALUES (
                'webhook-event-1', 'stripe', 'evt_1', 'invoice.paid', '{}'
              );
            `),
          );

          const rejectedStatements = [
            `INSERT INTO billing_customers (billing_customer_id, user_id)
             VALUES ('billing-customer-duplicate-user', 'stripe-user-1')`,
            `INSERT INTO billing_customers (billing_customer_id, user_id, stripe_customer_id)
             VALUES ('billing-customer-duplicate-stripe', 'stripe-user-2', 'cus_customer1')`,
            `INSERT INTO billing_checkout_sessions (
               billing_checkout_session_id, user_id, billing_customer_id, target_plan,
               stripe_product_id, stripe_price_id, state
             ) VALUES (
               'checkout-wrong-owner', 'stripe-user-2', 'billing-customer-1', 'adventurer',
               'prod_adventurer', 'price_adventurer', 'creating'
             )`,
            `INSERT INTO billing_checkout_sessions (
               billing_checkout_session_id, user_id, billing_customer_id, target_plan,
               stripe_product_id, stripe_price_id, state
             ) VALUES (
               'checkout-bad-state', 'stripe-user-2', 'billing-customer-1', 'adventurer',
               'prod_adventurer', 'price_adventurer', 'unknown'
             )`,
            `UPDATE billing_subscriptions
             SET pending_plan = 'free', pending_plan_effective_at = NULL
             WHERE user_id = 'stripe-user-1'`,
            `UPDATE billing_subscriptions
             SET billing_customer_id = 'billing-customer-1'
             WHERE user_id = 'stripe-user-2'`,
            `UPDATE billing_subscriptions
             SET stripe_subscription_id = 'sub_1', stripe_product_id = NULL,
                 stripe_price_id = 'price_adventurer', stripe_status = 'active'
             WHERE user_id = 'stripe-user-1'`,
            `UPDATE billing_subscriptions
             SET stripe_current_period_start = '2026-08-01T00:00:00Z',
                 stripe_current_period_end = '2026-09-01T00:00:00Z'
             WHERE user_id = 'stripe-user-1'`,
            `UPDATE billing_subscriptions
             SET stripe_subscription_id = 'sub_1', stripe_product_id = 'prod_adventurer',
                 stripe_price_id = 'price_adventurer', stripe_status = 'active',
                 stripe_current_period_start = '2026-09-01T00:00:00Z',
                 stripe_current_period_end = '2026-08-01T00:00:00Z'
             WHERE user_id = 'stripe-user-1'`,
            `INSERT INTO webhook_events (
               webhook_event_id, provider, external_event_id, event_type, payload_json
             ) VALUES ('webhook-event-duplicate', 'stripe', 'evt_1', 'invoice.paid', '{}')`,
          ];

          for (const statement of rejectedStatements) {
            const result = yield* Effect.tryPromise({
              try: () => client.exec(statement),
              catch: (cause) => new MigrationConstraintRejected({ cause }),
            }).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
          }
        }),
      closeTestDatabase,
    ),
  );
});

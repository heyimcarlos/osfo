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

          expect(applied.rows.length).toBe(migrations.length);
          expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
            "accounts",
            "agents",
            "allowance_periods",
            "allowance_usage",
            "billing_checkout_sessions",
            "billing_customers",
            "billing_subscriptions",
            "channel_bindings",
            "deletion_cases",
            "migrations",
            "rate_limits",
            "registration_invitations",
            "sessions",
            "user_suspension_events",
            "users",
            "verifications",
            "webhook_events",
            "webhook_jobs",
          ]);
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

  it.effect("migrates Stripe jobs and drops obsolete chat tables without copying chat data", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          const initial = migrations[0];
          if (initial === undefined) return yield* Effect.die("The initial migration is missing");
          yield* applyMigrations(client, [initial]);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO inbound_whatsapp_events (
                channel_identity, content_digest, message_kind, phone_number_id,
                provider, provider_message_id
              ) VALUES (
                '14165550123', '${"a".repeat(40)}', 'text', '123456789',
                'whatsapp', 'wamid.legacy'
              );
              INSERT INTO webhook_events (
                attempts, event_type, external_event_id, external_object_id,
                provider, webhook_event_id
              ) VALUES (
                0, 'checkout.session.completed', 'evt_legacy', 'cs_legacy',
                'stripe', 'webhook-event-legacy'
              );
            `),
          );

          yield* applyMigrations(client, migrations);
          const events = yield* Effect.promise(() =>
            client.query<{
              readonly external_event_id: string;
              readonly external_object_id: string;
              readonly provider: string;
              readonly webhook_event_id: string;
            }>(`
                SELECT
                  payload_json::jsonb ->> 'externalEventId' AS external_event_id,
                  payload_json::jsonb ->> 'externalObjectId' AS external_object_id,
                  provider,
                  webhook_event_id
                FROM webhook_events
              `),
          );
          const jobs = yield* Effect.promise(() =>
            client.query<{
              readonly attempts: number;
              readonly status: string;
              readonly webhook_event_id: string;
            }>(`
                SELECT attempts, status, webhook_event_id
                FROM webhook_jobs
              `),
          );
          const removedTables = yield* Effect.promise(() =>
            client.query<{ readonly table_name: string }>(`
              SELECT table_name
              FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name IN ('inbound_whatsapp_events', 'telegram_onboarding_deliveries')
            `),
          );

          expect(events.rows).toEqual([
            {
              external_event_id: "evt_legacy",
              external_object_id: "cs_legacy",
              provider: "stripe",
              webhook_event_id: "webhook-event-legacy",
            },
          ]);
          expect(jobs.rows).toEqual([
            {
              attempts: 1,
              status: "pending",
              webhook_event_id: "webhook-event-legacy",
            },
          ]);
          expect(removedTables.rows).toEqual([]);
          return undefined;
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
                     ('user-2', 'User 2', 'user-2@example.test', now());
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
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-blank-actor', 'user-2', '   ', 'Valid reason')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-blank-reason', 'user-2', 'admin-1', '   ')`,
              `INSERT INTO deletion_cases
               (deletion_case_id, user_id, requested_by_admin_id, reason)
             VALUES ('deletion-case-duplicate', 'user-1', 'admin-1', 'Duplicate')`,
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

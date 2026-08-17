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
            "gmail_connections",
            "gmail_send_attempts",
            "inbound_whatsapp_events",
            "migrations",
            "rate_limits",
            "registration_invitations",
            "sessions",
            "telegram_onboarding_deliveries",
            "user_suspension_events",
            "users",
            "verifications",
            "webhook_events",
          ]);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("preserves populated WhatsApp facts across the 0003 to 0004 upgrade and retry", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          const through0003 = migrations.filter(
            (migration) => migration.name.startsWith("000") && migration.name <= "0003_zzzz.sql",
          );
          yield* applyMigrations(client, through0003);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('user-upgrade', 'Upgrade User', 'upgrade@example.test', now());
              INSERT INTO channel_bindings (
                channel_binding_id, provider, channel_identity, user_id
              ) VALUES (
                'binding-upgrade', 'whatsapp', 'whatsapp:14165550190', 'user-upgrade'
              );
              INSERT INTO registration_invitations (
                invitation_id, token_digest, kind, provider, channel_identity,
                invited_phone_number, locale, state, consumption_digest,
                binding_outcome, channel_binding_id, user_id, expires_at, consumed_at
              ) VALUES (
                'invitation-upgrade', repeat('a', 64), 'whatsapp_first', 'whatsapp',
                'whatsapp:14165550190', '+14165550190', 'en', 'consumed', repeat('b', 64),
                'created', 'binding-upgrade', 'user-upgrade', now() + interval '1 day', now()
              );
              INSERT INTO inbound_whatsapp_events (
                binding_resolved_at, channel_identity, content_digest, message_kind,
                phone_number_id, provider_message_id, resolved_channel_binding_id
              ) VALUES (
                now(), 'whatsapp:14165550190', repeat('c', 64), 'text',
                '14165550000', 'wamid.upgrade', 'binding-upgrade'
              );
            `),
          );

          yield* applyMigrations(client, migrations);
          yield* applyMigrations(client, migrations);

          const preserved = yield* Effect.promise(() =>
            client.query(`
              SELECT
                b.provider AS binding_provider,
                i.provider AS invitation_provider,
                i.state AS invitation_state,
                e.provider AS event_provider,
                e.resolved_channel_binding_id
              FROM channel_bindings b
              JOIN registration_invitations i ON i.channel_binding_id = b.channel_binding_id
              JOIN inbound_whatsapp_events e
                ON e.resolved_channel_binding_id = b.channel_binding_id
              WHERE b.channel_binding_id = 'binding-upgrade'
            `),
          );
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO channel_bindings (
                channel_binding_id, provider, channel_identity, user_id
              ) VALUES (
                'binding-telegram-upgrade', 'telegram', 'telegram:900100290', 'user-upgrade'
              );
              INSERT INTO registration_invitations (
                invitation_id, token_digest, kind, provider, provider_event_id,
                channel_identity, locale, expires_at
              ) VALUES (
                'invitation-telegram-upgrade', repeat('d', 64), 'telegram_first', 'telegram',
                'telegram-update-upgrade', 'telegram:900100291', 'en', now() + interval '1 day'
              );
              INSERT INTO inbound_whatsapp_events (
                binding_resolved_at, channel_identity, content_digest, message_kind,
                phone_number_id, provider, provider_message_id, resolved_channel_binding_id
              ) VALUES (
                now(), 'telegram:900100290', repeat('e', 64), 'text',
                'telegram', 'telegram', 'telegram-update-bound', 'binding-telegram-upgrade'
              );
              INSERT INTO telegram_onboarding_deliveries (
                event_id, claim_token, state, lease_expires_at
              ) VALUES (
                'telegram-update-upgrade', 'claim-upgrade', 'prepared', now() + interval '1 minute'
              );
            `),
          );
          const telegram = yield* Effect.promise(() =>
            client.query<{ readonly count: number }>(`
              SELECT count(*)::integer AS count
              FROM inbound_whatsapp_events
              WHERE provider = 'telegram'
            `),
          );

          expect(preserved.rows).toEqual([
            {
              binding_provider: "whatsapp",
              event_provider: "whatsapp",
              invitation_provider: "whatsapp",
              invitation_state: "consumed",
              resolved_channel_binding_id: "binding-upgrade",
            },
          ]);
          expect(telegram.rows).toEqual([{ count: 1 }]);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("preserves populated billing and Telegram facts across 0004 to 0005 and retry", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      ({ client }) =>
        Effect.gen(function* () {
          const migrations = yield* readMigrations;
          const through0004 = migrations.filter(
            (migration) => migration.name.startsWith("000") && migration.name <= "0004_zzzz.sql",
          );
          yield* applyMigrations(client, through0004);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO users (id, name, email, updated_at)
              VALUES ('user-stripe-upgrade', 'Stripe Upgrade', 'stripe-upgrade@example.test', now());
              INSERT INTO billing_subscriptions (
                billing_subscription_id, user_id, plan, plan_policy_version
              ) VALUES (
                'subscription-stripe-upgrade', 'user-stripe-upgrade', 'adventurer', 'launch-v1'
              );
              INSERT INTO allowance_periods (
                allowance_period_id, billing_subscription_id, plan, plan_policy_version,
                starts_at, ends_at, user_id
              ) VALUES (
                'period-stripe-upgrade', 'subscription-stripe-upgrade', 'adventurer', 'launch-v1',
                now() - interval '1 day', now() + interval '1 day', 'user-stripe-upgrade'
              );
              INSERT INTO telegram_onboarding_deliveries (
                event_id, claim_token, state, lease_expires_at
              ) VALUES (
                'telegram-stripe-upgrade', 'claim-stripe-upgrade', 'prepared', now() + interval '1 minute'
              );
            `),
          );

          yield* applyMigrations(client, migrations);
          yield* applyMigrations(client, migrations);
          yield* Effect.promise(() =>
            client.exec(`
              INSERT INTO billing_customers (
                billing_customer_id, stripe_customer_id, user_id
              ) VALUES (
                'customer-stripe-upgrade', 'cus_stripeupgrade', 'user-stripe-upgrade'
              );
              UPDATE billing_subscriptions
              SET billing_customer_id = 'customer-stripe-upgrade'
              WHERE billing_subscription_id = 'subscription-stripe-upgrade';
            `),
          );

          const preserved = yield* Effect.promise(() =>
            client.query(`
              SELECT
                s.plan,
                s.billing_customer_id,
                array_agg(p.plan ORDER BY p.starts_at) AS allowance_plans,
                t.state AS telegram_state
              FROM billing_subscriptions s
              JOIN allowance_periods p
                ON p.billing_subscription_id = s.billing_subscription_id
              CROSS JOIN telegram_onboarding_deliveries t
              WHERE s.billing_subscription_id = 'subscription-stripe-upgrade'
                AND t.event_id = 'telegram-stripe-upgrade'
              GROUP BY s.plan, s.billing_customer_id, t.state
            `),
          );
          const applied0005 = yield* Effect.promise(() =>
            client.query<{ readonly count: number }>(`
              SELECT count(*)::integer AS count
              FROM migrations
              WHERE name = '0005_classy_juggernaut.sql'
            `),
          );

          expect(preserved.rows).toEqual([
            {
              allowance_plans: ["adventurer", "free"],
              billing_customer_id: "customer-stripe-upgrade",
              plan: "free",
              telegram_state: "prepared",
            },
          ]);
          expect(applied0005.rows).toEqual([{ count: 1 }]);
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
                webhook_event_id, provider, external_event_id, event_type, external_object_id
              ) VALUES (
                'webhook-event-1', 'stripe', 'evt_1', 'invoice.paid', 'in_1'
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
               webhook_event_id, provider, external_event_id, event_type, external_object_id
             ) VALUES ('webhook-event-duplicate', 'stripe', 'evt_1', 'invoice.paid', 'in_1')`,
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

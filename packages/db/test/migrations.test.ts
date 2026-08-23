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
            "channel_link_audit_events",
            "channel_link_invites",
            "channel_links",
            "deletion_cases",
            "migrations",
            "rate_limits",
            "sessions",
            "usage_event_components",
            "usage_event_evidence_references",
            "usage_events",
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

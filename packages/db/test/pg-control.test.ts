import { randomUUID } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Config, Data, Effect, Exit, Redacted } from "effect";
import postgres from "postgres";

import {
  cloneTestDatabase,
  createTemplateDatabase,
  dropTestDatabase,
  dropTestDatabases,
} from "./pg-control";

const runId = randomUUID().replaceAll("-", "");
const runPrefix = `osfo_test_${runId}_`;
const templateName = `${runPrefix}template`;
const firstCloneName = `${runPrefix}clone_a`;
const secondCloneName = `${runPrefix}clone_b`;

class PostgreSqlConstraintRejected extends Data.TaggedError("PostgreSqlConstraintRejected")<{
  readonly cause: unknown;
}> {}

describe("PostgreSQL test database control", () => {
  it.effect("refuses to drop a database outside the Osfo test prefix", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        dropTestDatabase({
          databaseName: "postgres",
          maintenanceUrl: "postgres://ignored:ignored@127.0.0.1:1/postgres",
        }),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("clones isolated migrated databases and preserves ledger constraints", () =>
    Effect.gen(function* () {
      const maintenanceUrl = Redacted.value(yield* Config.redacted("OSFO_TEST_POSTGRES_URL"));
      const cleanup = Effect.promise(() =>
        dropTestDatabases({ databaseNamePrefix: runPrefix, maintenanceUrl }),
      );

      yield* Effect.gen(function* () {
        const template = yield* Effect.promise(() =>
          createTemplateDatabase({ maintenanceUrl, templateName }),
        );
        const firstClone = yield* Effect.promise(() =>
          cloneTestDatabase({
            databaseName: firstCloneName,
            maintenanceUrl,
            templateName: template.name,
          }),
        );
        const secondClone = yield* Effect.promise(() =>
          cloneTestDatabase({
            databaseName: secondCloneName,
            maintenanceUrl,
            templateName: template.name,
          }),
        );

        yield* withClient(firstClone.connectionString, (client) =>
          Effect.gen(function* () {
            const [identity] = yield* Effect.promise(
              () => client`select current_database() as name`,
            );
            const [latestMigrationTable] = yield* Effect.promise(
              () => client`select to_regclass('public.channel_links')::text as name`,
            );
            yield* Effect.promise(
              () =>
                client`insert into users (id, name, email) values ('clone-user', 'Clone User', 'clone@example.test')`,
            );
            yield* Effect.promise(() =>
              client.unsafe(`
                insert into billing_subscriptions (
                  billing_subscription_id, user_id, plan, plan_policy_version
                ) values ('clone-subscription', 'clone-user', 'free', 'shared-usage-v1');
                insert into allowance_periods (
                  allowance_period_id, user_id, billing_subscription_id,
                  plan, plan_policy_version, starts_at, ends_at
                ) values (
                  'clone-period', 'clone-user', 'clone-subscription',
                  'free', 'shared-usage-v1', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
                );
                insert into usage_events (
                  allowance_period_id, capability_catalog_version, facts_json,
                  model_access_policy_version, occurred_at, outcome, plan_usage_micros,
                  rated_cost_usd_micros, root_operation_id, source_id, source_type,
                  usage_policy_version, user_id
                ) values (
                  'clone-period', 'governed-capabilities-v1', '{}',
                  'managed-routing-v1', now(), 'completed', 1, 1,
                  'clone-root', 'clone-source', 'testOperation',
                  'shared-usage-v1', 'clone-user'
                )
              `),
            );

            const malformedComponent = yield* Effect.tryPromise({
              try: () =>
                client.unsafe(`
                  insert into usage_event_components (
                    activity, allowance_period_id, component_index, component_kind,
                    evidence_json, rated_cost_usd_micros, resource_price_version,
                    source_id, source_type
                  ) values (
                    'unknown', 'clone-period', 0, 'model', '{}', 1,
                    'resource-prices-v1', 'clone-source', 'testOperation'
                  )
                `),
              catch: (cause) => new PostgreSqlConstraintRejected({ cause }),
            }).pipe(Effect.exit);

            expect(identity?.name).toBe(firstCloneName);
            expect(latestMigrationTable?.name).toBe("channel_links");
            expect(Exit.isFailure(malformedComponent)).toBe(true);
          }),
        );

        yield* withClient(secondClone.connectionString, (client) =>
          Effect.gen(function* () {
            const users = yield* Effect.promise(
              () => client`select id from users where id = 'clone-user'`,
            );
            expect(users).toEqual([]);
          }),
        );
      }).pipe(Effect.ensuring(cleanup));
    }),
  );
});

const withClient = <A, E>(
  connectionString: string,
  use: (client: ReturnType<typeof postgres>) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => postgres(connectionString, { max: 1 })),
    use,
    (client) => Effect.promise(() => client.end()),
  );

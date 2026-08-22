import { randomUUID } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Config, Effect, Exit, Redacted } from "effect";
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

  it.effect("clones isolated databases from one migrated template", () =>
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

            expect(identity?.name).toBe(firstCloneName);
            expect(latestMigrationTable?.name).toBe("channel_links");
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

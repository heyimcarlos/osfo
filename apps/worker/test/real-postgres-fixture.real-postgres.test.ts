import { describe, expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { Config, Effect, Exit, Redacted, Result, Schema } from "effect";
import postgres from "postgres";

import { UserId } from "../src/domain";
import { withRealPostgresFixture } from "./real-postgres-fixture";

const PublicDatabaseResidue = Schema.Struct({
  tableNames: Schema.Array(Schema.String),
  usersTable: Schema.NullOr(Schema.String),
});

describe("Native PostgreSQL fixture cleanup", () => {
  it.effect("removes public test tables and Users after success", () =>
    Effect.gen(function* () {
      yield* withRealPostgresFixture(({ database }) =>
        Effect.promise(() =>
          database.insert(users).values({
            email: "fixture-success@example.test",
            id: UserId.make("fixture-success-user"),
            name: "Fixture Success User",
          }),
        ),
      );

      expect(yield* inspectPublicDatabaseResidue).toEqual({ tableNames: [], usersTable: null });
    }),
  );

  it.effect("removes public test tables and Users after test-body failure", () =>
    Effect.gen(function* () {
      const result = yield* withRealPostgresFixture(({ database }) =>
        Effect.promise(() =>
          database.insert(users).values({
            email: "fixture-failure@example.test",
            id: UserId.make("fixture-failure-user"),
            name: "Fixture Failure User",
          }),
        ).pipe(Effect.andThen(Effect.fail("ExpectedTestBodyFailure" as const))),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* inspectPublicDatabaseResidue).toEqual({ tableNames: [], usersTable: null });
    }),
  );
});

const inspectPublicDatabaseResidue = Config.redacted("OSFO_REAL_POSTGRES_URL").pipe(
  Effect.flatMap((databaseUrl) =>
    Effect.acquireUseRelease(
      Effect.sync(() => postgres(Redacted.value(databaseUrl), { max: 1 })),
      (client) =>
        Effect.gen(function* () {
          const tables = yield* Effect.promise(
            () => client`
            select table_name as "tableName"
            from information_schema.tables
            where table_schema = 'public'
            order by table_name
          `,
          );
          const [relation] = yield* Effect.promise(
            () => client`
            select to_regclass('public.users')::text as "usersTable"
          `,
          );
          return {
            tableNames: tables.map((row) => row.tableName),
            usersTable: relation?.usersTable ?? null,
          };
        }),
      (client) => Effect.promise(() => client.end()),
    ),
  ),
  Effect.flatMap((residue) => {
    const decoded = Schema.decodeResult(PublicDatabaseResidue)(residue);
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.die(decoded.failure);
  }),
);

import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database } from "@osfo/db";
import { drizzle } from "drizzle-orm/pglite";
import { Data, Effect } from "effect";

// oxlint-disable-next-line osfo/no-star-import -- Drizzle requires the complete schema module object for relational reflection; adding a self-namespace export makes that namespace part of the reflected schema.
import * as DbSchema from "../src/schema";
import { readMigrations, type TestMigration } from "./migration-files";

export { readMigrations, type TestMigration } from "./migration-files";

type TestRowValue = boolean | Date | number | string | null;
type TestRow = Readonly<Record<string, TestRowValue>>;

class TestPostgresError extends Data.TaggedError("TestPostgresError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Isolated PGlite database and Drizzle client used by integration tests. */
export interface TestDatabase {
  readonly client: PGlite;
  readonly database: Database;
}

/** Create one isolated PGlite database for a test. */
export const makeTestDatabase = Effect.sync((): TestDatabase => {
  const client = new PGlite();
  const database = drizzle(client, { schema: DbSchema });

  return { client, database };
});

/** Apply each unapplied migration in its own Postgres transaction. */
export const applyMigrations = (
  client: PGlite,
  migrations?: Effect.Success<typeof readMigrations>,
) =>
  Effect.gen(function* () {
    const ordered = migrations ?? (yield* readMigrations);
    yield* query(
      client,
      "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamp DEFAULT now() NOT NULL)",
    );
    yield* Effect.forEach(ordered, (migration) => applyMigration(client, migration), {
      discard: true,
    });
  });

const applyMigration = (client: PGlite, migration: TestMigration) =>
  Effect.gen(function* () {
    const existing = yield* query<{ readonly name: string }>(
      client,
      "SELECT name FROM migrations WHERE name = $1",
      [migration.name],
    );
    if (existing[0] !== undefined) {
      return;
    }

    yield* Effect.tryPromise({
      try: () =>
        client.transaction(async (transaction) => {
          for (const statement of migration.statements) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Migration statements must run in committed order.
            await transaction.exec(statement);
          }
          await transaction.query("INSERT INTO migrations (name) VALUES ($1)", [migration.name]);
        }),
      catch: (cause) =>
        new TestPostgresError({ cause, message: "Postgres rejected a test migration" }),
    });
  });

/** Close one isolated PGlite test database. */
export const closeTestDatabase = ({ client }: TestDatabase) => Effect.promise(() => client.close());

const query = <Row extends TestRow = TestRow>(
  client: PGlite | Transaction,
  text: string,
  values?: ReadonlyArray<boolean | number | string | null>,
) =>
  Effect.tryPromise({
    try: async () => (await client.query<Row>(text, values === undefined ? [] : [...values])).rows,
    catch: (cause) => new TestPostgresError({ cause, message: "Postgres rejected a test query" }),
  });

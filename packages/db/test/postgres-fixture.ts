import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database } from "@osfo/db";
import { drizzle } from "drizzle-orm/pglite";
import { Data, Effect } from "effect";

// oxlint-disable-next-line effecttsgo/node-builtin-import -- The Postgres test fixture reads committed migrations.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as tables from "../src/schema";

/** One committed migration split into ordered PostgreSQL statements. */
export interface TestMigration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

type TestRowValue = boolean | Date | number | string | null;
type TestRow = Readonly<Record<string, TestRowValue>>;

class TestPostgresError extends Data.TaggedError("TestPostgresError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const migrationsDirectory = fileURLToPath(new URL("../src/migrations", import.meta.url));

/** Isolated PGlite database and Drizzle client used by integration tests. */
export interface TestDatabase {
  readonly client: PGlite;
  readonly database: Database;
}

/** Create one isolated PGlite database for a test. */
export const makeTestDatabase = Effect.sync((): TestDatabase => {
  const client = new PGlite();
  const database = drizzle(client, { schema: tables });

  return { client, database };
});

/** Read the committed Postgres migrations in deployment order. */
export const readMigrations = Effect.tryPromise({
  try: async () => {
    const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 has no toSorted, and this local array must follow deployment order.
    names.sort((left, right) => left.localeCompare(right));
    return Promise.all(
      names.map(async (name): Promise<TestMigration> => {
        const sql = await readFile(`${migrationsDirectory}/${name}`, "utf8");
        return {
          name,
          statements: sql
            .split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0),
        };
      }),
    );
  },
  catch: (cause) =>
    new TestPostgresError({ cause, message: "Could not read the Postgres migrations" }),
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

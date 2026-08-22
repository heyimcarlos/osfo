/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- Database test support reads committed migration files. */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Data, Effect } from "effect";

const migrationsDirectory = fileURLToPath(new URL("../src/migrations", import.meta.url));

/** One committed migration split into ordered PostgreSQL statements. */
export interface TestMigration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

export class TestMigrationReadError extends Data.TaggedError("TestMigrationReadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Read the committed PostgreSQL migrations in deployment order. */
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
    new TestMigrationReadError({ cause, message: "Could not read the PostgreSQL migrations" }),
});

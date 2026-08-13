import { hashMigrations } from "alchemy/SQL/SqlFile";
import { Effect, Schema } from "effect";

const directoryMigrationDigests = {
  "20260813020336_initial_directory/migration.sql":
    "c5b90a2f49c294f0b2cb1765f0352a5abc53a0b2bfdd6eee0206c8bc4db24845",
  "20260813020824_add_denial_facts/migration.sql":
    "de752a2d656070025451a88841d4e5140edcccff6ba3df4812949707a69cd4be",
} as const;

const erasureReceiptMigrationDigests = {
  "20260813021043_initial_erasure_receipts/migration.sql":
    "9289ef009825306635001e4858fcdc40b21d404e17f318a2181a8c0995d83aab",
} as const;

/** Deployment failure when a released forward-only migration was edited or removed. */
export class MigrationDigestMismatch extends Schema.TaggedError<MigrationDigestMismatch>()(
  "MigrationDigestMismatch",
  {
    directory: Schema.String,
    message: Schema.String,
  },
) {}

/** Verify all released D1 migration digests before Alchemy changes resources. */
export const verifyD1MigrationDigests = Effect.fn("verifyD1MigrationDigests")(function* () {
  yield* verifyMigrationDirectory("./apps/worker/drizzle/directory", directoryMigrationDigests);
  yield* verifyMigrationDirectory(
    "./apps/worker/drizzle/erasure-receipts",
    erasureReceiptMigrationDigests,
  );
});

/** Verify one migration directory against its immutable released digest manifest. */
export const verifyMigrationDirectory = Effect.fn("verifyMigrationDirectory")(function* (
  directory: string,
  expected: Readonly<Record<string, string>>,
) {
  const actual = yield* hashMigrations(directory);
  const expectedNames = Object.keys(expected);
  const actualNames = Object.keys(actual);
  const matches =
    expectedNames.length === actualNames.length &&
    actualNames.every((name) => expected[name] === actual[name]);
  if (!matches) {
    return yield* new MigrationDigestMismatch({
      directory,
      message: "A released forward-only D1 migration was edited, removed, or left untracked",
    });
  }
  return yield* Effect.void;
});

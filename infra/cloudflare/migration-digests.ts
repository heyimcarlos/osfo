import { hashMigrations } from "alchemy/SQL/SqlFile";
import { Effect, Schema } from "effect";

const dbMigrationDigests = {
  "20260813224000_redundant_pyro/migration.sql":
    "beea34b73f3eb535bac94f09e7ea9efd9b3508e0a10e482b7fcfab504a4e735b",
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
  yield* verifyMigrationDirectory("./apps/worker/src/db/migrations", dbMigrationDigests);
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

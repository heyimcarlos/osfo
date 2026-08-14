import { hashMigrations } from "alchemy/SQL/SqlFile";
import { Effect, Schema } from "effect";

const dbMigrationDigests = {
  "0000_demonic_doorman.sql": "2c97e5ef113342bcfc920d38996fa1602fa75468593f6579b3c26379859bd7d5",
} as const;

/** Deployment failure when a released forward-only migration was edited or removed. */
export class MigrationDigestMismatch extends Schema.TaggedError<MigrationDigestMismatch>()(
  "MigrationDigestMismatch",
  {
    directory: Schema.String,
    message: Schema.String,
  },
) {}

/** Verify all released Postgres migration digests before Alchemy changes resources. */
export const verifyPostgresMigrationDigests = Effect.fn("verifyPostgresMigrationDigests")(
  function* () {
    yield* verifyMigrationDirectory("./packages/db/src/migrations", dbMigrationDigests);
  },
);

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
      message: "A released forward-only Postgres migration was edited, removed, or left untracked",
    });
  }
  return yield* Effect.void;
});

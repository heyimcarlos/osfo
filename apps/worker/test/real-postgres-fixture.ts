import { createDb, type Database } from "@osfo/db";
import { readMigrations } from "@osfo/db/testing";
import { Config, Data, Effect, Redacted, Result, Schema } from "effect";
import postgres from "postgres";

/** Failure to prepare or use the dedicated native PostgreSQL test database. */
export class RealPostgresTestUnavailable extends Data.TaggedError("RealPostgresTestUnavailable")<{
  readonly message: string;
}> {}

/** Migrated native PostgreSQL resources owned by one real-database test. */
export interface RealPostgresFixture {
  readonly client: ReturnType<typeof postgres>;
  readonly database: Database;
}

const CurrentDatabaseRows = Schema.Array(Schema.Struct({ databaseName: Schema.String }));

/** Run one test against a freshly reset dedicated native PostgreSQL database. */
export const withRealPostgresFixture = <A, E>(
  use: (fixture: RealPostgresFixture) => Effect.Effect<A, E>,
): Effect.Effect<A, E | RealPostgresTestUnavailable> =>
  Effect.scoped(
    Config.redacted("OSFO_REAL_POSTGRES_URL").pipe(
      Effect.mapError(
        () =>
          new RealPostgresTestUnavailable({
            message: "OSFO_REAL_POSTGRES_URL is required for native PostgreSQL tests",
          }),
      ),
      Effect.flatMap(parseDedicatedDatabaseUrl),
      Effect.flatMap((databaseUrl) =>
        Effect.acquireUseRelease(
          acquireClient(databaseUrl),
          (client) =>
            initializeDatabase(client).pipe(
              Effect.flatMap((database) => use({ client, database })),
            ),
          (client) =>
            Effect.tryPromise({
              try: () => client.end(),
              catch: () =>
                new RealPostgresTestUnavailable({
                  message: "Could not close the native PostgreSQL test client",
                }),
            }),
        ),
      ),
    ),
  );

const parseDedicatedDatabaseUrl = (databaseUrl: Redacted.Redacted) =>
  Effect.try({
    try: () => new URL(Redacted.value(databaseUrl)),
    catch: () =>
      new RealPostgresTestUnavailable({
        message: "OSFO_REAL_POSTGRES_URL must be a PostgreSQL URL",
      }),
  }).pipe(
    Effect.filterOrFail(
      (url) => (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hash === "",
      () =>
        new RealPostgresTestUnavailable({
          message: "OSFO_REAL_POSTGRES_URL must be a PostgreSQL URL without a fragment",
        }),
    ),
    Effect.as(databaseUrl),
  );

const acquireClient = (databaseUrl: Redacted.Redacted) =>
  Effect.try({
    try: () => postgres(Redacted.value(databaseUrl), { max: 10 }),
    catch: () =>
      new RealPostgresTestUnavailable({
        message: "Could not create the native PostgreSQL test client",
      }),
  });

const initializeDatabase = (client: ReturnType<typeof postgres>) =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () => client`select current_database() as "databaseName"`,
      catch: () =>
        new RealPostgresTestUnavailable({
          message: "Could not read the native PostgreSQL test database identity",
        }),
    });
    const decoded = Schema.decodeUnknownResult(CurrentDatabaseRows)(rows);
    if (Result.isFailure(decoded)) {
      return yield* new RealPostgresTestUnavailable({
        message: "Native PostgreSQL returned an invalid database identity",
      });
    }
    const [current] = decoded.success;
    if (current?.databaseName !== "osfo_ticket_170") {
      return yield* new RealPostgresTestUnavailable({
        message: "OSFO_REAL_POSTGRES_URL must target the dedicated osfo_ticket_170 database",
      });
    }
    const migrations = yield* readMigrations.pipe(
      Effect.mapError(
        () =>
          new RealPostgresTestUnavailable({
            message: "Could not read migrations for the native PostgreSQL test database",
          }),
      ),
    );
    yield* Effect.tryPromise({
      // oxlint-disable-next-line effecttsgo/async-function -- Postgres.js owns this Promise transaction boundary.
      try: async () => {
        await client.unsafe("DROP SCHEMA public CASCADE");
        await client.unsafe("CREATE SCHEMA public");
        // oxlint-disable-next-line effecttsgo/async-function -- Postgres.js owns this Promise transaction callback.
        await client.begin(async (transaction) => {
          for (const migration of migrations) {
            for (const statement of migration.statements) {
              // oxlint-disable-next-line eslint/no-await-in-loop -- Migration statements must keep deployment order.
              await transaction.unsafe(statement);
            }
          }
        });
      },
      catch: () =>
        new RealPostgresTestUnavailable({
          message: "Could not initialize the dedicated native PostgreSQL test database",
        }),
    });
    return createDb(client);
  });

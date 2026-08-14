import { createDb, type Database } from "@osfo/db";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import postgres, { type Sql } from "postgres";

/** UTC timestamp stored as an ISO 8601 string. */
export const DbTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.endsWith("Z") && Option.isSome(DateTime.make(value))) ||
      "must be a valid UTC ISO 8601 timestamp",
  ),
).pipe(Schema.brand("DbTimestamp"));

/** UTC timestamp stored as an ISO 8601 string. */
export type DbTimestamp = typeof DbTimestamp.Type;

/** Database operations used in safe failures and telemetry. */
export const DbOperation = Schema.Literals(["establishRegistration", "resolveAgent"]);

/** Database operations used in safe failures and telemetry. */
export type DbOperation = typeof DbOperation.Type;

/** Expected failure when Postgres rejects one atomic product operation. */
export class DbWriteRejected extends Schema.TaggedError<DbWriteRejected>()("DbWriteRejected", {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: DbOperation,
  operationId: Schema.String,
}) {}

/** Safe typed failure for an unavailable or inconsistent database operation. */
export class DbUnavailable extends Schema.TaggedError<DbUnavailable>()("DbUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: DbOperation,
}) {}

/** Cloudflare Hyperdrive binding used by the Worker database. */
export interface Options {
  readonly db: Pick<Hyperdrive, "connectionString">;
}

export type { Database } from "@osfo/db";

interface DbService {
  readonly database: Database;
}

/** Worker-local access to the shared Postgres database. */
export class Db extends Context.Service<Db, DbService>()("@osfo/worker/Db") {}

/** Acquire the shared Drizzle database from the current Effect context. */
export const database: Effect.Effect<Database, never, Db> = Effect.map(
  Db,
  (service) => service.database,
);

/** Construct the Worker database from one request-scoped Postgres client. */
export const make = (client: Sql): DbService => ({
  database: createDb(client),
});

/** Database Layer backed by one provided Postgres client. */
export const layerFromClient = (client: Sql) => Layer.succeed(Db, make(client));

/** Database Layer backed by one provided Drizzle PostgreSQL database. */
export const layerFromDatabase = (provided: Database) => Layer.succeed(Db, { database: provided });

/** Production database Layer backed by one Cloudflare Hyperdrive binding. */
export const layer = (options: Options) =>
  Layer.effect(
    Db,
    Effect.acquireRelease(
      Effect.sync(() =>
        postgres(options.db.connectionString, {
          fetch_types: false,
          max: 5,
          prepare: true,
        }),
      ),
      (client) => Effect.promise(() => client.end()),
    ).pipe(Effect.map(make)),
  );

/** Translate an unknown Postgres failure into a safe database failure. */
export const dbUnavailable = (operation: DbOperation, cause: unknown) =>
  new DbUnavailable({
    cause,
    message: `The database could not complete ${operation}`,
    operation,
  });

/** Create the typed failure for an atomic write rejected by Postgres. */
export const dbWriteRejected = (operation: DbOperation, operationId: string, cause: unknown) =>
  new DbWriteRejected({
    cause,
    message: `The database rejected the atomic ${operation} facts`,
    operation,
    operationId,
  });

/** Run one Postgres promise and translate its failure. */
export const execute = <A>(operation: DbOperation, query: () => Promise<A>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) => dbUnavailable(operation, cause),
  });

/** Decode one database row into a trusted application value. */
export const decodeRow = <A, Encoded extends object>(
  schema: Schema.Codec<A, Encoded>,
  row: Encoded,
  operation: DbOperation,
) => {
  const decoded = Schema.decodeResult(schema)(row);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(dbUnavailable(operation, decoded.failure));
};

/** Decode an optional database row into a trusted application value. */
export const decodeOptionalRow = <A, Encoded extends object>(
  schema: Schema.Codec<A, Encoded>,
  row: Encoded | undefined,
  operation: DbOperation,
) =>
  Effect.gen(function* () {
    return row === undefined ? undefined : yield* decodeRow(schema, row, operation);
  });

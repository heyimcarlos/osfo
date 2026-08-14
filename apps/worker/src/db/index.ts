import * as D1Client from "@effect/sql-d1/D1Client";
import * as SQLiteD1Drizzle from "drizzle-orm/effect-d1";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";

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

/** Expected failure when D1 rejects one atomic product operation. */
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

/** Cloudflare D1 binding used by the Worker database. */
export interface Options {
  readonly db: D1Database;
}

/** Drizzle database and Effect D1 client acquired once for a database Layer. */
export type Database = SQLiteD1Drizzle.EffectSQLiteD1Database & {
  readonly $client: D1Client.D1Client;
};

interface DbService {
  readonly database: Database;
}

interface DrizzleQuery {
  readonly toSQL: () => {
    readonly params: ReadonlyArray<unknown>;
    readonly sql: string;
  };
}

/** Worker-local access to the shared D1 database. */
export class Db extends Context.Service<Db, DbService>()("@osfo/worker/Db") {}

/** Acquire the shared Drizzle database from the current Effect context. */
export const database: Effect.Effect<Database, never, Db> = Effect.map(
  Db,
  (service) => service.database,
);

/** Construct the Worker database from the provided D1 client. */
export const make = Effect.fn("Db.make")(function* () {
  const drizzle = yield* SQLiteD1Drizzle.makeWithDefaults({});
  return Db.of({ database: drizzle });
});

/** Database Layer that preserves its D1 client requirement for composition. */
export const layerWithoutDependencies = Layer.effect(Db, make());

/** Production database Layer backed by one Cloudflare D1 binding. */
export const layer = (options: Options) =>
  layerWithoutDependencies.pipe(
    Layer.provide(D1Client.layer({ db: options.db }).pipe(Layer.orDie)),
  );

/** Translate an unknown D1 failure into a safe database failure. */
export const dbUnavailable = (operation: DbOperation, cause: unknown) =>
  new DbUnavailable({
    cause,
    message: `The database could not complete ${operation}`,
    operation,
  });

/** Create the typed failure for an atomic write rejected by D1. */
export const dbWriteRejected = (operation: DbOperation, operationId: string, cause: unknown) =>
  new DbWriteRejected({
    cause,
    message: `The database rejected the atomic ${operation} facts`,
    operation,
    operationId,
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

/** Compile one Drizzle query into an Effect D1 statement for an atomic batch. */
export const toD1Statement = (db: Database, query: DrizzleQuery) => {
  const compiled = query.toSQL();
  return db.$client.unsafe(compiled.sql, compiled.params);
};

import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

// oxlint-disable-next-line osfo/no-star-import -- Drizzle requires the complete schema module object for relational reflection; adding a self-namespace export makes that namespace part of the reflected schema.
import * as DbSchema from "./schema";

/** Shared PostgreSQL Drizzle database. */
export type Database = PgDatabase<PgQueryResultHKT, typeof DbSchema>;

/** Create the shared database from one Postgres.js client. */
export const createDb = (client: Sql): Database => drizzle(client, { schema: DbSchema });

export { DbSchema };

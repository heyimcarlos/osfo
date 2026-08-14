import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

import * as schema from "./schema";

/** Shared PostgreSQL Drizzle database. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Create the shared database from one Postgres.js client. */
export const createDb = (client: Sql): Database => drizzle(client, { schema });

export { schema };

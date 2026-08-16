import type { Database } from "../index";

/** Drizzle capability required by complete PostgreSQL billing transactions. */
export type BillingDatabase = Pick<Database, "transaction">;

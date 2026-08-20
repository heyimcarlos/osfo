import { drizzle } from "drizzle-orm/durable-sqlite";

// oxlint-disable-next-line osfo/no-star-import -- Drizzle requires the complete Agent SQLite schema module object for relational reflection.
import * as AgentSchema from "./schema";

/** Construct the typed Drizzle client for one Agent Durable Object SQLite database. */
export const makeAgentDb = (storage: DurableObjectStorage) =>
  drizzle(storage, { schema: AgentSchema });

/** Typed Drizzle client for Osfo-owned Agent SQLite tables. */
export type AgentDb = ReturnType<typeof makeAgentDb>;

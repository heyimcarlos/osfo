import { drizzle } from "drizzle-orm/durable-sqlite";

import * as schema from "./schema";

/** Construct the typed Drizzle client for one Agent Durable Object SQLite database. */
export const makeAgentDb = (storage: DurableObjectStorage) => drizzle(storage, { schema });

/** Typed Drizzle client for Osfo-owned Agent SQLite tables. */
export type AgentDb = ReturnType<typeof makeAgentDb>;

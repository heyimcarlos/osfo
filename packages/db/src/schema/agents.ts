import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Stable routing from one User to one User-scoped Agent. */
export const agents = pgTable(
  "agents",
  {
    agentId: text("agent_id").notNull(),
    createdAt: text("created_at").notNull(),
    userId: text("user_id")
      .notNull()
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("agents_agent_id_unique").on(table.agentId)],
);

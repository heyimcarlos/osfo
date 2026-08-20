import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Stable routing from one User to one User-scoped Agent. */
export const agents = pgTable(
  "agents",
  {
    agent_id: text().notNull(),
    created_at: text().notNull(),
    user_id: text()
      .notNull()
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("agents_agent_id_unique").on(table.agent_id)],
);

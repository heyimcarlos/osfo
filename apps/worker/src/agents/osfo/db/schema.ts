import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type {
  AgentId,
  AgentInitializationId,
  ConversationRouteId,
  SessionId,
} from "../../../domain";
import type { DbTimestamp } from "../../../db";

const agentId = customType<{ data: AgentId; driverData: string }>({
  dataType: () => "text",
});
const initializationId = customType<{ data: AgentInitializationId; driverData: string }>({
  dataType: () => "text",
});
const routeId = customType<{ data: ConversationRouteId; driverData: string }>({
  dataType: () => "text",
});
const sessionId = customType<{ data: SessionId; driverData: string }>({
  dataType: () => "text",
});
const timestamp = customType<{ data: DbTimestamp; driverData: string }>({
  dataType: () => "text",
});

/** Singleton evidence that the named Durable Object completed Agent initialization. */
export const agentInitialization = sqliteTable(
  "osfo_agent_initialization",
  {
    agentId: agentId("agent_id").notNull().unique(),
    initializationId: initializationId("initialization_id").notNull().unique(),
    initializedAt: timestamp("initialized_at").notNull(),
    singletonKey: text("singleton_key").primaryKey(),
  },
  (table) => [check("osfo_agent_initialization_singleton", sql`${table.singletonKey} = 'agent'`)],
);

/** Stable Agent-local conversation routes. */
export const conversationRoutes = sqliteTable(
  "osfo_conversation_routes",
  {
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
    routeId: routeId("route_id").primaryKey(),
  },
  (table) => [
    check("osfo_conversation_route_primary_boolean", sql`${table.isPrimary} IN (0, 1)`),
    uniqueIndex("osfo_one_primary_route")
      .on(table.isPrimary)
      .where(sql`${table.isPrimary} = 1`),
  ],
);

/** Think Session identities and their ownership by an Agent-local route. */
export const sessionOwnership = sqliteTable(
  "osfo_session_ownership",
  {
    becameCurrentAt: timestamp("became_current_at").notNull(),
    replacedAt: timestamp("replaced_at"),
    routeId: routeId("route_id")
      .notNull()
      .references(() => conversationRoutes.routeId, { onDelete: "restrict", onUpdate: "restrict" }),
    sessionId: sessionId("session_id").primaryKey(),
  },
  (table) => [
    uniqueIndex("osfo_one_current_session_per_route")
      .on(table.routeId)
      .where(sql`${table.replacedAt} IS NULL`),
    index("osfo_sessions_by_route").on(table.routeId, table.becameCurrentAt),
  ],
);

/** Idempotent Osfo projection references for committed Think turns. */
export const committedTurns = sqliteTable(
  "osfo_committed_turns",
  {
    assistantMessageId: text("assistant_message_id").notNull().unique(),
    observationSequence: integer("observation_sequence").primaryKey({ autoIncrement: true }),
    observedAt: text("observed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    sessionId: sessionId("session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, { onDelete: "restrict", onUpdate: "restrict" }),
    source: text("source", { enum: ["hook", "reconciliation"] }).notNull(),
    thinkRequestId: text("think_request_id"),
  },
  (table) => [
    check("osfo_committed_turn_source", sql`${table.source} IN ('hook', 'reconciliation')`),
    index("osfo_committed_turns_by_session").on(table.sessionId, table.observationSequence),
    uniqueIndex("osfo_committed_turn_think_request_unique")
      .on(table.thinkRequestId)
      .where(sql`${table.thinkRequestId} IS NOT NULL`),
  ],
);

/** Row read from the Agent initialization fact table. */
export type AgentInitializationRecord = typeof agentInitialization.$inferSelect;

/** Row read from the conversation route table. */
export type ConversationRouteRecord = typeof conversationRoutes.$inferSelect;

/** Row read from the Session ownership table. */
export type SessionOwnershipRecord = typeof sessionOwnership.$inferSelect;

/** Row read from the committed-turn projection table. */
export type CommittedTurnRecord = typeof committedTurns.$inferSelect;

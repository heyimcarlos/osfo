import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const channelBindings = sqliteTable("channel_bindings", {
  agentId: text("agent_id").notNull(),
  channelIdentity: text("channel_identity").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const activationAudit = sqliteTable("activation_audit", {
  activationCount: integer("activation_count").notNull().default(0),
  agentId: text("agent_id").primaryKey(),
  lastActivatedAt: integer("last_activated_at").notNull(),
  lastActivationId: text("last_activation_id").notNull(),
});

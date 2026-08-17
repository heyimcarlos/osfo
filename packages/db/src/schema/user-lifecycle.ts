import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Append-only administrative suspension and restoration history. */
export const userSuspensionEvents = pgTable(
  "user_suspension_events",
  {
    eventId: text("event_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    adminActorId: text("admin_actor_id").notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("user_suspension_events_action_check", sql`${table.action} in ('suspended', 'restored')`),
    check("user_suspension_events_actor_check", sql`length(btrim(${table.adminActorId})) > 0`),
    check("user_suspension_events_reason_check", sql`length(btrim(${table.reason})) > 0`),
    index("user_suspension_events_user_order_index").on(
      table.userId,
      table.occurredAt,
      table.eventId,
    ),
  ],
);

/** One administrative deletion request that immediately ends User access. */
export const deletionCases = pgTable(
  "deletion_cases",
  {
    deletionCaseId: text("deletion_case_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedByAdminId: text("requested_by_admin_id").notNull(),
    reason: text("reason").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("deletion_cases_user_unique").on(table.userId),
    check("deletion_cases_actor_check", sql`length(btrim(${table.requestedByAdminId})) > 0`),
    check("deletion_cases_reason_check", sql`length(btrim(${table.reason})) > 0`),
  ],
);

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Append-only administrative suspension and restoration history. */
export const userSuspensionEvents = pgTable(
  "user_suspension_events",
  {
    event_id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text().notNull(),
    admin_actor_id: text().notNull(),
    reason: text().notNull(),
    occurred_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("user_suspension_events_action_check", sql`${table.action} in ('suspended', 'restored')`),
    check("user_suspension_events_actor_check", sql`length(btrim(${table.admin_actor_id})) > 0`),
    check("user_suspension_events_reason_check", sql`length(btrim(${table.reason})) > 0`),
    index("user_suspension_events_user_order_index").on(
      table.user_id,
      table.occurred_at,
      table.event_id,
    ),
  ],
);

/** One administrative deletion request that immediately ends User access. */
export const deletionCases = pgTable(
  "deletion_cases",
  {
    deletion_case_id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requested_by_admin_id: text(),
    requested_by_user_id: text().references(() => users.id, { onDelete: "cascade" }),
    approval_action_id: text(),
    approval_presentation: text(),
    reason: text().notNull(),
    requested_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("deletion_cases_user_unique").on(table.user_id),
    check(
      "deletion_cases_actor_check",
      sql`(${table.requested_by_admin_id} is not null and length(btrim(${table.requested_by_admin_id})) > 0 and ${table.requested_by_user_id} is null and ${table.approval_action_id} is null and ${table.approval_presentation} is null)
        or (${table.requested_by_admin_id} is null and ${table.requested_by_user_id} = ${table.user_id} and length(btrim(${table.approval_action_id})) > 0 and length(btrim(${table.approval_presentation})) > 0)`,
    ),
    check("deletion_cases_reason_check", sql`length(btrim(${table.reason})) > 0`),
  ],
);

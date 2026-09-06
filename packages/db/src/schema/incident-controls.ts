import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Current operator controls for admitting new work during an incident. */
export const incidentControls = pgTable(
  "incident_controls",
  {
    id: boolean().primaryKey().default(true),
    pause_new_ingress: boolean().default(false).notNull(),
    pause_new_costly_work: boolean().default(false).notNull(),
    changed_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    actor: text().notNull(),
    reason: text().notNull(),
  },
  (table) => [
    check("incident_controls_singleton_check", sql`${table.id} = true`),
    check("incident_controls_actor_check", sql`length(trim(${table.actor})) > 0`),
    check("incident_controls_reason_check", sql`length(trim(${table.reason})) > 0`),
  ],
);

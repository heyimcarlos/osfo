import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

const webhookStatusValues = ["pending", "processed", "failed"] as const;

/** One normalized event from an authenticated provider webhook. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    event_type: text().notNull(),
    external_event_id: text().notNull(),
    payload_json: text().notNull(),
    provider: text().notNull(),
    received_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    webhook_event_id: text().notNull().primaryKey(),
  },
  (table) => [
    unique("webhook_events_provider_external_event_unique").on(
      table.provider,
      table.external_event_id,
    ),
    check("webhook_events_provider_check", sql`${table.provider} = 'stripe'`),
  ],
);

/** Generic durable processing state created atomically with a new webhook event. */
export const webhookJobs = pgTable(
  "webhook_jobs",
  {
    attempts: integer().default(1).notNull(),
    error_code: text(),
    processed_at: timestamp({
      mode: "date",
      withTimezone: true,
    }),
    status: text({ enum: webhookStatusValues }).default("pending").notNull(),
    updated_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    webhook_event_id: text().notNull().primaryKey(),
  },
  (table) => [
    foreignKey({
      columns: [table.webhook_event_id],
      foreignColumns: [webhookEvents.webhook_event_id],
      name: "webhook_jobs_event_fk",
    }).onDelete("cascade"),
    check("webhook_jobs_attempts_check", sql`${table.attempts} >= 1`),
    check("webhook_jobs_status_check", sql`${table.status} in ('pending', 'processed', 'failed')`),
    check(
      "webhook_jobs_processed_at_check",
      sql`(${table.status} = 'processed') = (${table.processed_at} is not null)`,
    ),
  ],
);

import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

const webhookStatusValues = ["pending", "processed", "failed"] as const;

/** One normalized event from an authenticated provider webhook. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    eventType: text("event_type").notNull(),
    externalEventId: text("external_event_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    provider: text("provider").notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    webhookEventId: text("webhook_event_id").notNull().primaryKey(),
  },
  (table) => [
    unique("webhook_events_provider_external_event_unique").on(
      table.provider,
      table.externalEventId,
    ),
    check("webhook_events_provider_check", sql`${table.provider} = 'stripe'`),
  ],
);

/** Generic durable processing state created atomically with a new webhook event. */
export const webhookJobs = pgTable(
  "webhook_jobs",
  {
    attempts: integer("attempts").default(1).notNull(),
    errorCode: text("error_code"),
    processedAt: timestamp("processed_at", {
      mode: "date",
      withTimezone: true,
    }),
    status: text("status", { enum: webhookStatusValues }).default("pending").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    webhookEventId: text("webhook_event_id").notNull().primaryKey(),
  },
  (table) => [
    foreignKey({
      columns: [table.webhookEventId],
      foreignColumns: [webhookEvents.webhookEventId],
      name: "webhook_jobs_event_fk",
    }).onDelete("cascade"),
    check("webhook_jobs_attempts_check", sql`${table.attempts} >= 1`),
    check("webhook_jobs_status_check", sql`${table.status} in ('pending', 'processed', 'failed')`),
    check(
      "webhook_jobs_processed_at_check",
      sql`(${table.status} = 'processed') = (${table.processedAt} is not null)`,
    ),
  ],
);

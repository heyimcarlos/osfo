import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

const webhookStatusValues = ["pending", "processed", "failed"] as const;

/** Verified external webhook identity and durable processing state. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    attempts: integer("attempts").default(0).notNull(),
    billingCheckoutSessionId: text("billing_checkout_session_id"),
    errorCode: text("error_code"),
    eventType: text("event_type").notNull(),
    externalEventId: text("external_event_id").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    processedAt: timestamp("processed_at", { mode: "date", withTimezone: true }),
    provider: text("provider").notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    status: text("status", { enum: webhookStatusValues }).default("pending").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    webhookEventId: text("webhook_event_id").notNull().primaryKey(),
  },
  (table) => [
    unique("webhook_events_provider_external_event_unique").on(
      table.provider,
      table.externalEventId,
    ),
    check("webhook_events_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "webhook_events_status_check",
      sql`${table.status} in ('pending', 'processed', 'failed')`,
    ),
    check(
      "webhook_events_processed_at_check",
      sql`(${table.status} = 'processed') = (${table.processedAt} is not null)`,
    ),
  ],
);

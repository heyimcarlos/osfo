import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Lease-fenced Telegram onboarding delivery facts; never conversation authority. */
export const telegramOnboardingDeliveries = pgTable(
  "telegram_onboarding_deliveries",
  {
    eventId: text("event_id").primaryKey(),
    claimToken: text("claim_token").notNull(),
    state: text("state").default("not_applied").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "telegram_onboarding_deliveries_state_check",
      sql`${table.state} in ('not_applied', 'prepared', 'ambiguous', 'applied')`,
    ),
    check(
      "telegram_onboarding_deliveries_lifecycle_check",
      sql`(${table.state} in ('not_applied', 'prepared') and ${table.leaseExpiresAt} is not null and ${table.appliedAt} is null) or (${table.state} = 'ambiguous' and ${table.leaseExpiresAt} is null and ${table.appliedAt} is null) or (${table.state} = 'applied' and ${table.leaseExpiresAt} is null and ${table.appliedAt} is not null)`,
    ),
  ],
);

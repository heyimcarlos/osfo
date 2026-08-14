import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

const planValues = ["free", "adventurer"] as const;

/** Current commercial facts without payment-provider data. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    createdAt: text("created_at").notNull(),
    plan: text("plan", { enum: planValues }).notNull(),
    planPolicyVersion: text("plan_policy_version").notNull(),
    subscriptionId: text("subscription_id").notNull().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("subscriptions_user_id_unique").on(table.userId)],
);

/** Stable identities and bounds for Plan-scoped Usage Allowance periods. */
export const allowancePeriods = pgTable(
  "allowance_periods",
  {
    allowancePeriodId: text("allowance_period_id").notNull().primaryKey(),
    endsAt: text("ends_at").notNull(),
    plan: text("plan", { enum: planValues }).notNull(),
    planPolicyVersion: text("plan_policy_version").notNull(),
    startsAt: text("starts_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("allowance_periods_user_start_unique").on(table.userId, table.startsAt),
    index("allowance_periods_user_end_index").on(table.userId, table.endsAt),
  ],
);

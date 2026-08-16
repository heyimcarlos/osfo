import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { users } from "./auth";

const planValues = ["free", "adventurer"] as const;

/** Current commercial facts and the per-User allowance-period writer lock. */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    billingSubscriptionId: text("billing_subscription_id").notNull().primaryKey(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    plan: text("plan", { enum: planValues }).notNull(),
    planPolicyVersion: text("plan_policy_version").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("billing_subscriptions_user_id_unique").on(table.userId),
    unique("billing_subscriptions_user_subscription_unique").on(
      table.userId,
      table.billingSubscriptionId,
    ),
  ],
);

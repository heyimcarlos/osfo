import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { users } from "./auth";

const planValues = ["free", "adventurer"] as const;
const checkoutStateValues = ["creating", "open", "complete", "expired", "failed"] as const;

/** Stable local Customer identity established before a Stripe request begins. */
export const billingCustomers = pgTable(
  "billing_customers",
  {
    billing_customer_id: text().notNull().primaryKey(),
    created_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    stripe_customer_id: text(),
    updated_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("billing_customers_user_id_unique").on(table.user_id),
    unique("billing_customers_stripe_customer_id_unique").on(table.stripe_customer_id),
    unique("billing_customers_user_customer_unique").on(table.user_id, table.billing_customer_id),
  ],
);

/** Current commercial facts and the per-User allowance-period writer lock. */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    billing_subscription_id: text().notNull().primaryKey(),
    billing_customer_id: text(),
    created_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    pending_plan: text({ enum: planValues }),
    pending_plan_effective_at: timestamp({
      mode: "date",
      withTimezone: true,
    }),
    plan: text({ enum: planValues }).notNull(),
    plan_policy_version: text().notNull(),
    stripe_cancel_at_period_end: boolean(),
    stripe_current_period_end: timestamp({
      mode: "date",
      withTimezone: true,
    }),
    stripe_current_period_start: timestamp({
      mode: "date",
      withTimezone: true,
    }),
    stripe_latest_invoice_id: text(),
    stripe_price_id: text(),
    stripe_product_id: text(),
    stripe_status: text(),
    stripe_subscription_id: text(),
    updated_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.user_id, table.billing_customer_id],
      foreignColumns: [billingCustomers.user_id, billingCustomers.billing_customer_id],
      name: "billing_subscriptions_user_customer_fk",
    }).onDelete("restrict"),
    unique("billing_subscriptions_user_id_unique").on(table.user_id),
    unique("billing_subscriptions_user_subscription_unique").on(
      table.user_id,
      table.billing_subscription_id,
    ),
    unique("billing_subscriptions_stripe_subscription_id_unique").on(table.stripe_subscription_id),
    check(
      "billing_subscriptions_pending_plan_pair_check",
      sql`(${table.pending_plan} is null) = (${table.pending_plan_effective_at} is null)`,
    ),
    check(
      "billing_subscriptions_stripe_identity_check",
      sql`(${table.stripe_subscription_id} is null and ${table.stripe_product_id} is null and ${table.stripe_price_id} is null and ${table.stripe_status} is null and ${table.stripe_current_period_start} is null and ${table.stripe_current_period_end} is null) or (${table.stripe_subscription_id} is not null and ${table.stripe_product_id} is not null and ${table.stripe_price_id} is not null and ${table.stripe_status} is not null)`,
    ),
    check(
      "billing_subscriptions_stripe_period_pair_check",
      sql`(${table.stripe_current_period_start} is null) = (${table.stripe_current_period_end} is null)`,
    ),
    check(
      "billing_subscriptions_stripe_period_bounds_check",
      sql`${table.stripe_current_period_start} is null or ${table.stripe_current_period_start} < ${table.stripe_current_period_end}`,
    ),
    check(
      "billing_subscriptions_adventurer_evidence_check",
      sql`${table.plan} <> 'adventurer' or (${table.stripe_subscription_id} is not null and ${table.stripe_current_period_start} is not null and ${table.stripe_latest_invoice_id} is not null)`,
    ),
  ],
);

/** Stable local Checkout attempt established before a Stripe request begins. */
export const billingCheckoutSessions = pgTable(
  "billing_checkout_sessions",
  {
    billing_checkout_session_id: text().notNull().primaryKey(),
    billing_customer_id: text().notNull(),
    completed_at: timestamp({ mode: "date", withTimezone: true }),
    created_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp({ mode: "date", withTimezone: true }),
    state: text({ enum: checkoutStateValues }).notNull(),
    stripe_checkout_session_id: text(),
    stripe_payment_status: text(),
    stripe_price_id: text().notNull(),
    stripe_product_id: text().notNull(),
    stripe_subscription_id: text(),
    target_plan: text({ enum: planValues }).notNull(),
    updated_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.user_id, table.billing_customer_id],
      foreignColumns: [billingCustomers.user_id, billingCustomers.billing_customer_id],
      name: "billing_checkout_sessions_user_customer_fk",
    }).onDelete("cascade"),
    unique("billing_checkout_sessions_stripe_session_id_unique").on(
      table.stripe_checkout_session_id,
    ),
    check(
      "billing_checkout_sessions_state_check",
      sql`${table.state} in ('creating', 'open', 'complete', 'expired', 'failed')`,
    ),
    check("billing_checkout_sessions_target_plan_check", sql`${table.target_plan} = 'adventurer'`),
  ],
);

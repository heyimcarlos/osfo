import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { users } from "./auth";

const planValues = ["free", "adventurer"] as const;
const checkoutStateValues = ["creating", "open", "complete", "expired", "failed"] as const;

/** Stable local Customer identity established before a Stripe request begins. */
export const billingCustomers = pgTable(
  "billing_customers",
  {
    billingCustomerId: text("billing_customer_id").notNull().primaryKey(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("billing_customers_user_id_unique").on(table.userId),
    unique("billing_customers_stripe_customer_id_unique").on(table.stripeCustomerId),
    unique("billing_customers_user_customer_unique").on(table.userId, table.billingCustomerId),
  ],
);

/** Current commercial facts and the per-User allowance-period writer lock. */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    billingSubscriptionId: text("billing_subscription_id").notNull().primaryKey(),
    billingCustomerId: text("billing_customer_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    pendingPlan: text("pending_plan", { enum: planValues }),
    pendingPlanEffectiveAt: timestamp("pending_plan_effective_at", {
      mode: "date",
      withTimezone: true,
    }),
    plan: text("plan", { enum: planValues }).notNull(),
    planPolicyVersion: text("plan_policy_version").notNull(),
    stripeCancelAtPeriodEnd: boolean("stripe_cancel_at_period_end"),
    stripeCurrentPeriodEnd: timestamp("stripe_current_period_end", {
      mode: "date",
      withTimezone: true,
    }),
    stripeCurrentPeriodStart: timestamp("stripe_current_period_start", {
      mode: "date",
      withTimezone: true,
    }),
    stripeLatestInvoiceId: text("stripe_latest_invoice_id"),
    stripePriceId: text("stripe_price_id"),
    stripeProductId: text("stripe_product_id"),
    stripeStatus: text("stripe_status"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.billingCustomerId],
      foreignColumns: [billingCustomers.userId, billingCustomers.billingCustomerId],
      name: "billing_subscriptions_user_customer_fk",
    }).onDelete("restrict"),
    unique("billing_subscriptions_user_id_unique").on(table.userId),
    unique("billing_subscriptions_user_subscription_unique").on(
      table.userId,
      table.billingSubscriptionId,
    ),
    unique("billing_subscriptions_stripe_subscription_id_unique").on(table.stripeSubscriptionId),
    check(
      "billing_subscriptions_pending_plan_pair_check",
      sql`(${table.pendingPlan} is null) = (${table.pendingPlanEffectiveAt} is null)`,
    ),
    check(
      "billing_subscriptions_stripe_identity_check",
      sql`(${table.stripeSubscriptionId} is null and ${table.stripeProductId} is null and ${table.stripePriceId} is null and ${table.stripeStatus} is null and ${table.stripeCurrentPeriodStart} is null and ${table.stripeCurrentPeriodEnd} is null) or (${table.stripeSubscriptionId} is not null and ${table.stripeProductId} is not null and ${table.stripePriceId} is not null and ${table.stripeStatus} is not null)`,
    ),
    check(
      "billing_subscriptions_stripe_period_pair_check",
      sql`(${table.stripeCurrentPeriodStart} is null) = (${table.stripeCurrentPeriodEnd} is null)`,
    ),
    check(
      "billing_subscriptions_stripe_period_bounds_check",
      sql`${table.stripeCurrentPeriodStart} is null or ${table.stripeCurrentPeriodStart} < ${table.stripeCurrentPeriodEnd}`,
    ),
    check(
      "billing_subscriptions_adventurer_evidence_check",
      sql`${table.plan} <> 'adventurer' or (${table.stripeSubscriptionId} is not null and ${table.stripeCurrentPeriodStart} is not null and ${table.stripeLatestInvoiceId} is not null)`,
    ),
  ],
);

/** Stable local Checkout attempt established before a Stripe request begins. */
export const billingCheckoutSessions = pgTable(
  "billing_checkout_sessions",
  {
    billingCheckoutSessionId: text("billing_checkout_session_id").notNull().primaryKey(),
    billingCustomerId: text("billing_customer_id").notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    state: text("state", { enum: checkoutStateValues }).notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentStatus: text("stripe_payment_status"),
    stripePriceId: text("stripe_price_id").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    targetPlan: text("target_plan", { enum: planValues }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.billingCustomerId],
      foreignColumns: [billingCustomers.userId, billingCustomers.billingCustomerId],
      name: "billing_checkout_sessions_user_customer_fk",
    }).onDelete("cascade"),
    unique("billing_checkout_sessions_stripe_session_id_unique").on(table.stripeCheckoutSessionId),
    check(
      "billing_checkout_sessions_state_check",
      sql`${table.state} in ('creating', 'open', 'complete', 'expired', 'failed')`,
    ),
    check("billing_checkout_sessions_target_plan_check", sql`${table.targetPlan} = 'adventurer'`),
  ],
);

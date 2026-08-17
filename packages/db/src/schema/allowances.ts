import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { billingSubscriptions } from "./billing";

const planValues = ["free", "adventurer"] as const;
const basisValues = ["known_at_start", "observed", "conservative"] as const;

/** Stable identities and half-open bounds for one common User allowance period. */
export const allowancePeriods = pgTable(
  "allowance_periods",
  {
    allowancePeriodId: text("allowance_period_id").notNull().primaryKey(),
    billingSubscriptionId: text("billing_subscription_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    endsAt: timestamp("ends_at", { mode: "date", withTimezone: true }).notNull(),
    plan: text("plan", { enum: planValues }).notNull(),
    planPolicyVersion: text("plan_policy_version").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    startsAt: timestamp("starts_at", { mode: "date", withTimezone: true }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("allowance_periods_starts_before_ends_check", sql`${table.startsAt} < ${table.endsAt}`),
    foreignKey({
      columns: [table.userId, table.billingSubscriptionId],
      foreignColumns: [billingSubscriptions.userId, billingSubscriptions.billingSubscriptionId],
      name: "allowance_periods_user_subscription_fk",
    }).onDelete("cascade"),
    unique("allowance_periods_user_start_unique").on(table.userId, table.startsAt),
    unique("allowance_periods_user_period_unique").on(table.userId, table.allowancePeriodId),
    unique("allowance_periods_stripe_invoice_id_unique").on(table.stripeInvoiceId),
    index("allowance_periods_user_bounds_index").on(table.userId, table.startsAt, table.endsAt),
  ],
);

/** Immutable normalized Allowance Consumption keyed by one existing source identity. */
export const allowanceUsage = pgTable(
  "allowance_usage",
  {
    allowanceKind: text("allowance_kind").notNull(),
    allowancePeriodId: text("allowance_period_id").notNull(),
    basis: text("basis", { enum: basisValues }).notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    sourceId: text("source_id").notNull(),
    sourceType: text("source_type").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.allowancePeriodId, table.allowanceKind, table.sourceType, table.sourceId],
      name: "allowance_usage_pk",
    }),
    check("allowance_usage_positive_quantity_check", sql`${table.quantity} > 0`),
    check(
      "allowance_usage_basis_check",
      sql`${table.basis} in ('known_at_start', 'observed', 'conservative')`,
    ),
    foreignKey({
      columns: [table.userId, table.allowancePeriodId],
      foreignColumns: [allowancePeriods.userId, allowancePeriods.allowancePeriodId],
      name: "allowance_usage_user_period_fk",
    }).onDelete("cascade"),
    index("allowance_usage_period_kind_index").on(table.allowancePeriodId, table.allowanceKind),
  ],
);

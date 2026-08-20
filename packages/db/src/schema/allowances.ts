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
    allowance_period_id: text().notNull().primaryKey(),
    billing_subscription_id: text().notNull(),
    created_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    ends_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    plan: text({ enum: planValues }).notNull(),
    plan_policy_version: text().notNull(),
    stripe_invoice_id: text(),
    starts_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("allowance_periods_starts_before_ends_check", sql`${table.starts_at} < ${table.ends_at}`),
    foreignKey({
      columns: [table.user_id, table.billing_subscription_id],
      foreignColumns: [billingSubscriptions.user_id, billingSubscriptions.billing_subscription_id],
      name: "allowance_periods_user_subscription_fk",
    }).onDelete("cascade"),
    unique("allowance_periods_user_start_unique").on(table.user_id, table.starts_at),
    unique("allowance_periods_user_period_unique").on(table.user_id, table.allowance_period_id),
    unique("allowance_periods_stripe_invoice_id_unique").on(table.stripe_invoice_id),
    index("allowance_periods_user_bounds_index").on(table.user_id, table.starts_at, table.ends_at),
  ],
);

/** Immutable normalized Allowance Consumption keyed by one existing source identity. */
export const allowanceUsage = pgTable(
  "allowance_usage",
  {
    allowance_kind: text().notNull(),
    allowance_period_id: text().notNull(),
    basis: text({ enum: basisValues }).notNull(),
    quantity: bigint({ mode: "bigint" }).notNull(),
    recorded_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    source_id: text().notNull(),
    source_type: text().notNull(),
    user_id: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.allowance_period_id,
        table.allowance_kind,
        table.source_type,
        table.source_id,
      ],
      name: "allowance_usage_pk",
    }),
    check("allowance_usage_positive_quantity_check", sql`${table.quantity} > 0`),
    check(
      "allowance_usage_basis_check",
      sql`${table.basis} in ('known_at_start', 'observed', 'conservative')`,
    ),
    foreignKey({
      columns: [table.user_id, table.allowance_period_id],
      foreignColumns: [allowancePeriods.user_id, allowancePeriods.allowance_period_id],
      name: "allowance_usage_user_period_fk",
    }).onDelete("cascade"),
    index("allowance_usage_period_kind_index").on(table.allowance_period_id, table.allowance_kind),
  ],
);

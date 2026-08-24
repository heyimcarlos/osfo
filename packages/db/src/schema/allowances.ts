import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
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

const usageEventOutcomeValues = ["completed", "useful_partial", "failed", "cancelled"] as const;
const usageActivityValues = [
  "conversationsAndMemory",
  "webAndResearch",
  "integrations",
  "filesAndArtifacts",
  "imagesAndDiagrams",
  "automations",
] as const;
const usageComponentKindValues = ["model", "non_model"] as const;
const usageEvidenceReferenceKindValues = [
  "providerLog",
  "gatewayLog",
  "companyCost",
  "operationEvidence",
] as const;

/** Immutable final outcome for one existing operation identity in its original period. */
export const usageEvents = pgTable(
  "usage_events",
  {
    allowance_period_id: text().notNull(),
    capability_catalog_version: text().notNull(),
    facts_json: text().notNull(),
    manifest_version: text(),
    model_access_policy_version: text().notNull(),
    occurred_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    outcome: text({ enum: usageEventOutcomeValues }).notNull(),
    plan_usage_micros: bigint({ mode: "bigint" }),
    rated_cost_usd_micros: bigint({ mode: "bigint" }),
    root_operation_id: text().notNull(),
    source_id: text().notNull(),
    source_type: text().notNull(),
    usage_policy_version: text().notNull(),
    user_id: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.allowance_period_id, table.source_type, table.source_id],
      name: "usage_events_pk",
    }),
    check(
      "usage_events_charge_consistency_check",
      sql`(
        ${table.outcome} in ('completed', 'useful_partial')
        and ${table.rated_cost_usd_micros} > 0
        and ${table.plan_usage_micros} > 0
      ) or (
        ${table.outcome} in ('failed', 'cancelled')
        and ${table.rated_cost_usd_micros} is null
        and ${table.plan_usage_micros} is null
      )`,
    ),
    check(
      "usage_events_outcome_check",
      sql`${table.outcome} in ('completed', 'useful_partial', 'failed', 'cancelled')`,
    ),
    check(
      "usage_events_required_text_check",
      sql`length(btrim(${table.allowance_period_id})) > 0
        and length(btrim(${table.capability_catalog_version})) > 0
        and length(btrim(${table.facts_json})) > 0
        and (${table.manifest_version} is null or length(btrim(${table.manifest_version})) > 0)
        and length(btrim(${table.model_access_policy_version})) > 0
        and length(btrim(${table.root_operation_id})) > 0
        and length(btrim(${table.source_id})) > 0
        and length(btrim(${table.source_type})) > 0
        and length(btrim(${table.usage_policy_version})) > 0
        and length(btrim(${table.user_id})) > 0`,
    ),
    foreignKey({
      columns: [table.user_id, table.allowance_period_id],
      foreignColumns: [allowancePeriods.user_id, allowancePeriods.allowance_period_id],
      name: "usage_events_user_period_fk",
    }).onDelete("cascade"),
    index("usage_events_root_operation_index").on(table.user_id, table.root_operation_id),
    index("usage_events_period_outcome_index").on(table.allowance_period_id, table.outcome),
  ],
);

/** Low-level reproducible Rated Cost component retained beneath one Usage Event. */
export const usageEventComponents = pgTable(
  "usage_event_components",
  {
    activity: text({ enum: usageActivityValues }).notNull(),
    allowance_period_id: text().notNull(),
    component_index: integer().notNull(),
    component_kind: text({ enum: usageComponentKindValues }).notNull(),
    evidence_json: text().notNull(),
    rated_cost_usd_micros: bigint({ mode: "bigint" }).notNull(),
    resource_price_version: text().notNull(),
    source_id: text().notNull(),
    source_type: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.allowance_period_id,
        table.source_type,
        table.source_id,
        table.component_index,
      ],
      name: "usage_event_components_pk",
    }),
    check(
      "usage_event_components_activity_check",
      sql`${table.activity} in ('conversationsAndMemory', 'webAndResearch', 'integrations', 'filesAndArtifacts', 'imagesAndDiagrams', 'automations')`,
    ),
    check(
      "usage_event_components_component_kind_check",
      sql`${table.component_kind} in ('model', 'non_model')`,
    ),
    check("usage_event_components_index_check", sql`${table.component_index} >= 0`),
    check("usage_event_components_positive_cost_check", sql`${table.rated_cost_usd_micros} > 0`),
    check(
      "usage_event_components_required_text_check",
      sql`length(btrim(${table.allowance_period_id})) > 0
        and length(btrim(${table.evidence_json})) > 0
        and length(btrim(${table.resource_price_version})) > 0
        and length(btrim(${table.source_id})) > 0
        and length(btrim(${table.source_type})) > 0`,
    ),
    foreignKey({
      columns: [table.allowance_period_id, table.source_type, table.source_id],
      foreignColumns: [
        usageEvents.allowance_period_id,
        usageEvents.source_type,
        usageEvents.source_id,
      ],
      name: "usage_event_components_event_fk",
    }).onDelete("cascade"),
  ],
);

/** Opaque provider, Company Cost, gateway, or operation reference beneath one Usage Event. */
export const usageEventEvidenceReferences = pgTable(
  "usage_event_evidence_references",
  {
    allowance_period_id: text().notNull(),
    reference: text().notNull(),
    reference_kind: text({ enum: usageEvidenceReferenceKindValues }).notNull(),
    source_id: text().notNull(),
    source_type: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.allowance_period_id,
        table.source_type,
        table.source_id,
        table.reference_kind,
        table.reference,
      ],
      name: "usage_event_evidence_references_pk",
    }),
    check(
      "usage_event_evidence_references_kind_check",
      sql`${table.reference_kind} in ('providerLog', 'gatewayLog', 'companyCost', 'operationEvidence')`,
    ),
    check(
      "usage_event_evidence_references_required_text_check",
      sql`length(btrim(${table.allowance_period_id})) > 0
        and length(btrim(${table.reference})) > 0
        and length(btrim(${table.source_id})) > 0
        and length(btrim(${table.source_type})) > 0`,
    ),
    foreignKey({
      columns: [table.allowance_period_id, table.source_type, table.source_id],
      foreignColumns: [
        usageEvents.allowance_period_id,
        usageEvents.source_type,
        usageEvents.source_id,
      ],
      name: "usage_event_evidence_references_event_fk",
    }).onDelete("cascade"),
  ],
);

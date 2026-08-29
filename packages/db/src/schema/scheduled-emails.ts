import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { allowancePeriods } from "./allowances";
import { users } from "./auth";

const states = [
  "admitted",
  "accepted",
  "waiting",
  "sending",
  "send_pending_reconciliation",
  "success",
  "failure",
  "canceled",
] as const;
const plans = ["free", "adventurer"] as const;

/** PostgreSQL product truth for one exact future Gmail effect. */
export const scheduledEmails = pgTable(
  "scheduled_emails",
  {
    workflow_id: text().primaryKey(),
    action_id: text().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: text().notNull(),
    route_id: text().notNull(),
    session_id: text().notNull(),
    originating_authority_json: text().notNull(),
    plan: text({ enum: plans }).notNull(),
    approval_presentation: text().notNull(),
    input_digest: text().notNull(),
    request_json: text().notNull(),
    due_at: timestamp({ withTimezone: true }).notNull(),
    state: text({ enum: states }).notNull(),
    allowance_period_id: text().notNull(),
    plan_policy_version: text().notNull(),
    capability_catalog_version: text().notNull(),
    model_access_policy_version: text().notNull(),
    model_route: text().notNull(),
    resource_price_version: text().notNull(),
    manifest_version: text().notNull(),
    cloudflare_instance_id: text().notNull(),
    provider_log_id: text(),
    provider_resource_id: text(),
    send_outcome: text({ enum: ["applied", "ambiguous", "notApplied"] }),
    send_accounting_basis: text({ enum: ["conservative", "observed"] }),
    safe_failure_code: text(),
    admitted_at: timestamp({ withTimezone: true }).notNull(),
    accepted_at: timestamp({ withTimezone: true }),
    waiting_at: timestamp({ withTimezone: true }),
    send_started_at: timestamp({ withTimezone: true }),
    send_claim_generation: integer().default(0).notNull(),
    send_outcome_at: timestamp({ withTimezone: true }),
    send_accounted_at: timestamp({ withTimezone: true }),
    send_reconciliation_claimed_at: timestamp({ withTimezone: true }),
    send_reconciliation_lease_expires_at: timestamp({ withTimezone: true }),
    cancel_requested_at: timestamp({ withTimezone: true }),
    terminal_at: timestamp({ withTimezone: true }),
    workflow_start_accounted_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.user_id, table.allowance_period_id],
      foreignColumns: [allowancePeriods.user_id, allowancePeriods.allowance_period_id],
      name: "scheduled_emails_user_period_fk",
    }).onDelete("cascade"),
    uniqueIndex("scheduled_emails_instance_unique").on(table.cloudflare_instance_id),
    index("scheduled_emails_user_state_index").on(table.user_id, table.state),
    index("scheduled_emails_due_index").on(table.state, table.due_at),
    check(
      "scheduled_emails_identity_check",
      sql`length(btrim(${table.workflow_id})) > 0
        and length(btrim(${table.action_id})) > 0
        and length(btrim(${table.user_id})) > 0
        and length(btrim(${table.agent_id})) > 0
        and length(btrim(${table.route_id})) > 0
        and length(btrim(${table.session_id})) > 0
        and ${table.input_digest} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.cloudflare_instance_id})) > 0
        and length(${table.approval_presentation}) > 0
        and ${table.send_claim_generation} >= 0`,
    ),
    check(
      "scheduled_emails_policy_check",
      sql`length(btrim(${table.plan_policy_version})) > 0
        and length(btrim(${table.capability_catalog_version})) > 0
        and length(btrim(${table.model_access_policy_version})) > 0
        and length(btrim(${table.model_route})) > 0
        and length(btrim(${table.resource_price_version})) > 0
        and length(btrim(${table.manifest_version})) > 0`,
    ),
    check(
      "scheduled_emails_json_check",
      sql`jsonb_typeof(${table.originating_authority_json}::jsonb) = 'object'
        and jsonb_typeof(${table.approval_presentation}::jsonb) = 'object'
        and jsonb_typeof(${table.request_json}::jsonb) = 'object'`,
    ),
    check(
      "scheduled_emails_state_check",
      sql`${table.state} in ('admitted', 'accepted', 'waiting', 'sending', 'send_pending_reconciliation', 'success', 'failure', 'canceled')`,
    ),
    check(
      "scheduled_emails_outcome_check",
      sql`(
          ${table.state} in ('admitted', 'accepted', 'waiting', 'sending', 'canceled')
          and ${table.send_outcome} is null
          and ${table.send_accounting_basis} is null
          and ${table.send_outcome_at} is null
          and ${table.provider_resource_id} is null
        ) or (
          ${table.state} = 'send_pending_reconciliation'
          and ${table.send_outcome} is not null
          and ${table.send_outcome} = 'ambiguous'
          and ${table.send_accounting_basis} is null
          and ${table.send_outcome_at} is not null
          and ${table.provider_resource_id} is null
        ) or (
          ${table.state} = 'success'
          and ${table.send_outcome} is not null
          and ${table.send_outcome} = 'applied'
          and ${table.send_accounting_basis} in ('observed', 'conservative')
          and ${table.send_outcome_at} is not null
          and ${table.provider_log_id} is not null
          and ${table.provider_resource_id} is not null
        ) or (
          ${table.state} = 'failure'
          and ${table.send_outcome} is not null
          and ${table.send_outcome} in ('notApplied', 'ambiguous')
          and (${table.send_outcome} <> 'ambiguous' or ${table.send_accounting_basis} is null or ${table.send_accounting_basis} = 'conservative')
          and (${table.send_outcome} <> 'notApplied' or ${table.send_accounting_basis} is null or ${table.send_accounting_basis} = 'conservative')
          and ${table.send_outcome_at} is not null
          and ${table.provider_resource_id} is null
        )`,
    ),
    check(
      "scheduled_emails_lifecycle_check",
      sql`${table.due_at} > ${table.admitted_at}
        and (${table.accepted_at} is null or ${table.accepted_at} >= ${table.admitted_at})
        and (${table.waiting_at} is null or ${table.accepted_at} is not null)
        and (${table.send_started_at} is null or ${table.send_started_at} >= ${table.due_at})
        and (${table.send_outcome_at} is null or ${table.send_started_at} is not null)
        and (${table.cancel_requested_at} is null or ${table.cancel_requested_at} >= ${table.admitted_at})
        and ((${table.state} in ('success', 'failure', 'canceled')) = (${table.terminal_at} is not null))
        and (${table.state} <> 'send_pending_reconciliation' or (${table.send_outcome} is not null and ${table.send_outcome} = 'ambiguous' and ${table.send_outcome_at} is not null and ${table.terminal_at} is null))
        and (${table.state} not in ('sending', 'send_pending_reconciliation', 'success', 'failure') or ${table.send_started_at} is not null)
        and (${table.state} <> 'success' or (${table.send_outcome} is not null and ${table.send_outcome} = 'applied' and ${table.send_outcome_at} is not null and ${table.provider_log_id} is not null and ${table.provider_resource_id} is not null))
        and (${table.send_accounted_at} is null or (${table.send_outcome} is not null and (${table.send_outcome} = 'notApplied' or ${table.send_accounting_basis} is not null)))
        and ((${table.send_reconciliation_claimed_at} is null and ${table.send_reconciliation_lease_expires_at} is null) or (${table.state} = 'failure' and ${table.send_outcome} = 'ambiguous' and ${table.send_accounting_basis} is null and ${table.send_reconciliation_claimed_at} is not null and ${table.send_reconciliation_lease_expires_at} is not null and ${table.send_reconciliation_lease_expires_at} > ${table.send_reconciliation_claimed_at}))
        and (${table.send_accounting_basis} <> 'observed' or ${table.send_outcome} = 'applied')
        and (${table.workflow_start_accounted_at} is null or ${table.accepted_at} is not null)
        and (${table.safe_failure_code} is null or length(btrim(${table.safe_failure_code})) between 1 and 120)`,
    ),
  ],
);

/** Durable exactly-once terminal Always delivery, separate from the Action Approval receipt. */
export const scheduledEmailNotifications = pgTable(
  "scheduled_email_notifications",
  {
    notification_id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => scheduledEmails.workflow_id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: text().notNull(),
    route_id: text().notNull(),
    origin_session_id: text().notNull(),
    allowance_period_id: text().notNull(),
    capability_catalog_version: text().notNull(),
    delivery_session_id: text(),
    plan_policy_version: text().notNull(),
    plan: text({ enum: plans }).notNull(),
    model_access_policy_version: text().notNull(),
    model_route: text().notNull(),
    resource_price_version: text().notNull(),
    state: text({ enum: ["success", "failure", "canceled"] }).notNull(),
    send_outcome: text({ enum: ["applied", "ambiguous", "notApplied"] }),
    claimed_at: timestamp({ withTimezone: true }).notNull(),
    think_submission_id: text(),
    accepted_at: timestamp({ withTimezone: true }),
    wake_requested_at: timestamp({ withTimezone: true }),
    source_exposed_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("scheduled_email_notifications_workflow_unique").on(table.workflow_id),
    index("scheduled_email_notifications_user_claimed_index").on(table.user_id, table.claimed_at),
    check(
      "scheduled_email_notifications_identity_check",
      sql`length(btrim(${table.notification_id})) > 0
        and length(btrim(${table.agent_id})) > 0
        and length(btrim(${table.route_id})) > 0
        and length(btrim(${table.origin_session_id})) > 0
        and (${table.delivery_session_id} is null or length(btrim(${table.delivery_session_id})) > 0)
        and ((${table.think_submission_id} is null) = (${table.accepted_at} is null))
        and (${table.think_submission_id} is null or (length(${table.think_submission_id}) between 1 and 160 and position(':' in ${table.think_submission_id}) = 0))
        and (${table.accepted_at} is null or ${table.accepted_at} >= ${table.claimed_at})
        and (${table.wake_requested_at} is null or (${table.accepted_at} is not null and ${table.wake_requested_at} >= ${table.accepted_at}))
        and (${table.source_exposed_at} is null or (${table.accepted_at} is not null and ${table.source_exposed_at} >= ${table.accepted_at}))`,
    ),
  ],
);

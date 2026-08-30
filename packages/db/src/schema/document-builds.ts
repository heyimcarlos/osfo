import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { allowancePeriods } from "./allowances";
import { users } from "./auth";

const documentBuildStates = [
  "admitted",
  "accepted",
  "running",
  "preview_stored",
  "publication_committed",
  "cancel_requested",
  "success",
  "failure",
  "canceled",
] as const;

/** PostgreSQL product truth for one admitted Document Build Workflow. */
export const documentBuilds = pgTable(
  "document_builds",
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
    qualification_context_json: text(),
    input_digest: text().notNull(),
    request_json: text().notNull(),
    state: text({ enum: documentBuildStates }).notNull(),
    allowance_period_id: text().notNull(),
    plan_policy_version: text().notNull(),
    capability_catalog_version: text().notNull(),
    model_access_policy_version: text().notNull(),
    model_route: text().notNull(),
    resource_price_version: text().notNull(),
    manifest_version: text(),
    cloudflare_instance_id: text().notNull(),
    cloudflare_timer_instance_id: text().notNull(),
    artifact_content_id: text(),
    cost_evidence_json: text(),
    safe_failure_code: text(),
    admitted_at: timestamp({ withTimezone: true }).notNull(),
    deadline_at: timestamp({ withTimezone: true }).notNull(),
    accepted_at: timestamp({ withTimezone: true }),
    started_at: timestamp({ withTimezone: true }),
    provider_cost_recorded_at: timestamp({ withTimezone: true }),
    preview_stored_at: timestamp({ withTimezone: true }),
    accounting_committed_at: timestamp({ withTimezone: true }),
    publication_committed_at: timestamp({ withTimezone: true }),
    artifact_accounted_at: timestamp({ withTimezone: true }),
    cancel_requested_at: timestamp({ withTimezone: true }),
    terminal_at: timestamp({ withTimezone: true }),
    milestone_claimed_at: timestamp({ withTimezone: true }),
    milestone_followup_at: timestamp({ withTimezone: true }),
    terminal_followup_claimed_at: timestamp({ withTimezone: true }),
    terminal_followup_at: timestamp({ withTimezone: true }),
    wakeup_requested_at: timestamp({ withTimezone: true }),
    host_recovery_checked_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.user_id, table.allowance_period_id],
      foreignColumns: [allowancePeriods.user_id, allowancePeriods.allowance_period_id],
      name: "document_builds_user_period_fk",
    }).onDelete("cascade"),
    uniqueIndex("document_builds_instance_unique").on(table.cloudflare_instance_id),
    uniqueIndex("document_builds_timer_instance_unique").on(table.cloudflare_timer_instance_id),
    index("document_builds_user_state_index").on(table.user_id, table.state),
    index("document_builds_deadline_index").on(table.state, table.deadline_at),
    index("document_builds_qualification_root_index").on(
      sql`(${table.qualification_context_json}::jsonb ->> 'executionId')`,
      sql`(${table.qualification_context_json}::jsonb ->> 'rootId')`,
    ),
    check(
      "document_builds_identity_check",
      sql`length(btrim(${table.workflow_id})) > 0
        and length(btrim(${table.action_id})) > 0
        and length(btrim(${table.user_id})) > 0
        and length(btrim(${table.agent_id})) > 0
        and length(btrim(${table.route_id})) > 0
        and length(btrim(${table.session_id})) > 0
        and ${table.input_digest} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.cloudflare_instance_id})) > 0
        and length(btrim(${table.cloudflare_timer_instance_id})) > 0`,
    ),
    check(
      "document_builds_policy_check",
      sql`length(btrim(${table.plan_policy_version})) > 0
        and length(btrim(${table.capability_catalog_version})) > 0
        and length(btrim(${table.model_access_policy_version})) > 0
        and length(btrim(${table.model_route})) > 0
        and length(btrim(${table.resource_price_version})) > 0
        and (${table.manifest_version} is null or length(btrim(${table.manifest_version})) > 0)`,
    ),
    check(
      "document_builds_json_check",
      sql`jsonb_typeof(${table.originating_authority_json}::jsonb) = 'object'
        and jsonb_typeof(${table.request_json}::jsonb) = 'object'
        and (${table.qualification_context_json} is null or jsonb_typeof(${table.qualification_context_json}::jsonb) = 'object')
        and (${table.cost_evidence_json} is null or jsonb_typeof(${table.cost_evidence_json}::jsonb) = 'object')`,
    ),
    check(
      "document_builds_state_check",
      sql`${table.state} in ('admitted', 'accepted', 'running', 'preview_stored', 'publication_committed', 'cancel_requested', 'success', 'failure', 'canceled')`,
    ),
    check(
      "document_builds_lifecycle_check",
      sql`${table.deadline_at} > ${table.admitted_at}
        and (${table.accepted_at} is null or ${table.accepted_at} >= ${table.admitted_at})
        and (${table.started_at} is null or (${table.accepted_at} is not null and ${table.started_at} >= ${table.admitted_at}))
        and (${table.provider_cost_recorded_at} is null or (${table.started_at} is not null and ${table.provider_cost_recorded_at} >= ${table.started_at}))
        and (${table.preview_stored_at} is null or ${table.preview_stored_at} >= ${table.admitted_at})
        and (${table.accounting_committed_at} is null or ${table.accounting_committed_at} >= ${table.preview_stored_at})
        and (${table.publication_committed_at} is null or ${table.publication_committed_at} >= ${table.accounting_committed_at})
        and (${table.artifact_accounted_at} is null or ${table.artifact_accounted_at} >= ${table.publication_committed_at})
        and (${table.cancel_requested_at} is null or ${table.cancel_requested_at} >= ${table.admitted_at})
        and (${table.terminal_at} is null or ${table.terminal_at} >= ${table.admitted_at})
        and ((${table.state} in ('success', 'failure', 'canceled')) = (${table.terminal_at} is not null))
        and ((${table.state} in ('failure', 'canceled')) = (${table.safe_failure_code} is not null))
        and (${table.safe_failure_code} is null or (length(btrim(${table.safe_failure_code})) between 1 and 120))
        and ((${table.artifact_content_id} is null) = (${table.preview_stored_at} is null))
        and ((${table.cost_evidence_json} is null) = (${table.provider_cost_recorded_at} is null))
        and (${table.accounting_committed_at} is null or ${table.provider_cost_recorded_at} is not null)
        and (${table.state} not in ('running', 'preview_stored', 'publication_committed', 'success', 'failure') or (${table.accepted_at} is not null and ${table.started_at} is not null))
        and (${table.state} not in ('preview_stored', 'publication_committed', 'success') or (${table.artifact_content_id} is not null and ${table.preview_stored_at} is not null))
        and (${table.state} not in ('publication_committed', 'success') or (${table.accounting_committed_at} is not null and ${table.publication_committed_at} is not null))
        and (${table.state} <> 'success' or ${table.artifact_accounted_at} is not null)
        and (${table.state} in ('publication_committed', 'success', 'canceled') or ${table.publication_committed_at} is null)`,
    ),
  ],
);

/** Global User-scoped Document Build milestone and terminal follow-up claim. */
export const documentBuildNotifications = pgTable(
  "document_build_notifications",
  {
    notification_id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => documentBuilds.workflow_id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text({ enum: ["previewReady", "terminal"] }).notNull(),
    claimed_at: timestamp({ withTimezone: true }).notNull(),
    delivery_session_id: text(),
    think_submission_id: text(),
    delivered_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("document_build_notifications_workflow_kind_unique").on(
      table.workflow_id,
      table.kind,
    ),
    index("document_build_notifications_user_claimed_index").on(table.user_id, table.claimed_at),
    check(
      "document_build_notifications_identity_check",
      sql`length(btrim(${table.notification_id})) > 0
        and ${table.kind} in ('previewReady', 'terminal')
        and (${table.delivery_session_id} is null or length(btrim(${table.delivery_session_id})) > 0)
        and ((${table.think_submission_id} is null) = (${table.delivered_at} is null))
        and (${table.think_submission_id} is null or (length(${table.think_submission_id}) between 1 and 160 and position(':' in ${table.think_submission_id}) = 0))
        and (${table.delivered_at} is null or ${table.delivered_at} >= ${table.claimed_at})`,
    ),
  ],
);

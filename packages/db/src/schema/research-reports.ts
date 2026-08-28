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

const workflowStates = [
  "admitted",
  "accepted",
  "running",
  "sources_committed",
  "artifact_stored",
  "publication_committed",
  "cancel_requested",
  "success",
  "failure",
  "canceled",
] as const;

/** Product truth for one admitted Research Report Workflow. */
export const researchReports = pgTable(
  "research_reports",
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
    approval_json: text(),
    input_digest: text().notNull(),
    request_json: text().notNull(),
    state: text({ enum: workflowStates }).notNull(),
    allowance_period_id: text().notNull(),
    plan_policy_version: text().notNull(),
    capability_catalog_version: text().notNull(),
    model_access_policy_version: text().notNull(),
    model_route: text().notNull(),
    resource_price_version: text().notNull(),
    manifest_version: text(),
    cloudflare_instance_id: text().notNull(),
    source_manifest_key: text(),
    source_manifest_digest: text(),
    artifact_content_id: text(),
    safe_failure_code: text(),
    admitted_at: timestamp({ withTimezone: true }).notNull(),
    deadline_at: timestamp({ withTimezone: true }).notNull(),
    accepted_at: timestamp({ withTimezone: true }),
    started_at: timestamp({ withTimezone: true }),
    sources_committed_at: timestamp({ withTimezone: true }),
    artifact_stored_at: timestamp({ withTimezone: true }),
    publication_committed_at: timestamp({ withTimezone: true }),
    cancel_requested_at: timestamp({ withTimezone: true }),
    terminal_at: timestamp({ withTimezone: true }),
    milestone_claimed_at: timestamp({ withTimezone: true }),
    milestone_followup_at: timestamp({ withTimezone: true }),
    terminal_followup_claimed_at: timestamp({ withTimezone: true }),
    terminal_followup_at: timestamp({ withTimezone: true }),
    wakeup_requested_at: timestamp({ withTimezone: true }),
    source_exposed_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.user_id, table.allowance_period_id],
      foreignColumns: [allowancePeriods.user_id, allowancePeriods.allowance_period_id],
      name: "research_reports_user_period_fk",
    }).onDelete("cascade"),
    uniqueIndex("research_reports_instance_unique").on(table.cloudflare_instance_id),
    index("research_reports_user_state_index").on(table.user_id, table.state),
    index("research_reports_deadline_index").on(table.state, table.deadline_at),
    check(
      "research_reports_identity_check",
      sql`length(btrim(${table.workflow_id})) > 0
        and length(btrim(${table.user_id})) > 0
        and length(btrim(${table.action_id})) > 0
        and length(btrim(${table.agent_id})) > 0
        and length(btrim(${table.route_id})) > 0
        and length(btrim(${table.session_id})) > 0
        and ${table.input_digest} ~ '^[0-9a-f]{64}$'
        and (${table.source_manifest_digest} is null or ${table.source_manifest_digest} ~ '^[0-9a-f]{64}$')
        and length(btrim(${table.cloudflare_instance_id})) > 0`,
    ),
    check(
      "research_reports_policy_check",
      sql`length(btrim(${table.plan_policy_version})) > 0
        and length(btrim(${table.capability_catalog_version})) > 0
        and length(btrim(${table.model_access_policy_version})) > 0
        and length(btrim(${table.model_route})) > 0
        and length(btrim(${table.resource_price_version})) > 0
        and (${table.manifest_version} is null or length(btrim(${table.manifest_version})) > 0)`,
    ),
    check(
      "research_reports_json_check",
      sql`jsonb_typeof(${table.originating_authority_json}::jsonb) = 'object'
        and (${table.approval_json} is null or jsonb_typeof(${table.approval_json}::jsonb) = 'object')
        and jsonb_typeof(${table.request_json}::jsonb) = 'object'`,
    ),
    check(
      "research_reports_state_check",
      sql`${table.state} in ('admitted', 'accepted', 'running', 'sources_committed', 'artifact_stored', 'publication_committed', 'cancel_requested', 'success', 'failure', 'canceled')`,
    ),
    check(
      "research_reports_lifecycle_check",
      sql`${table.deadline_at} > ${table.admitted_at}
        and (${table.accepted_at} is null or ${table.accepted_at} >= ${table.admitted_at})
        and (${table.started_at} is null or ${table.started_at} >= ${table.admitted_at})
        and (${table.started_at} is null or ${table.accepted_at} is not null)
        and (${table.sources_committed_at} is null or ${table.sources_committed_at} >= ${table.admitted_at})
        and (${table.artifact_stored_at} is null or ${table.artifact_stored_at} >= ${table.admitted_at})
        and (${table.publication_committed_at} is null or ${table.publication_committed_at} >= ${table.artifact_stored_at})
        and (${table.cancel_requested_at} is null or ${table.cancel_requested_at} >= ${table.admitted_at})
        and (${table.terminal_at} is null or ${table.terminal_at} >= ${table.admitted_at})
        and ((${table.state} in ('success', 'failure', 'canceled')) = (${table.terminal_at} is not null))
        and ((${table.state} in ('failure', 'canceled')) = (${table.safe_failure_code} is not null))
        and (${table.safe_failure_code} is null or (length(btrim(${table.safe_failure_code})) between 1 and 120))
        and ((${table.source_manifest_key} is null) = (${table.source_manifest_digest} is null))
        and (${table.state} not in ('running', 'sources_committed', 'artifact_stored', 'publication_committed', 'success', 'failure') or (${table.accepted_at} is not null and ${table.started_at} is not null))
        and (${table.state} not in ('sources_committed', 'artifact_stored', 'publication_committed', 'success') or (${table.source_manifest_key} is not null and ${table.source_manifest_digest} is not null))
        and (${table.state} not in ('artifact_stored', 'publication_committed', 'success') or (${table.artifact_content_id} is not null and ${table.artifact_stored_at} is not null))
        and (${table.state} not in ('publication_committed', 'success') or ${table.publication_committed_at} is not null)
        and (${table.state} in ('publication_committed', 'success', 'canceled') or ${table.publication_committed_at} is null)`,
    ),
  ],
);

const providerOperationStates = ["pending", "completed", "unknown", "failed", "canceled"] as const;

/** Exact replay and ambiguity evidence for one Research Report provider operation. */
export const researchReportProviderOperations = pgTable(
  "research_report_provider_operations",
  {
    operation_id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => researchReports.workflow_id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    kind: text({ enum: ["search", "page"] }).notNull(),
    input_digest: text().notNull(),
    input_json: text().notNull(),
    state: text({ enum: providerOperationStates }).notNull(),
    result_json: text(),
    safe_failure_code: text(),
    attempt_count: integer().default(0).notNull(),
    started_at: timestamp({ withTimezone: true }),
    completed_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_report_provider_workflow_sequence_unique").on(
      table.workflow_id,
      table.sequence,
    ),
    index("research_report_provider_workflow_state_index").on(table.workflow_id, table.state),
    check(
      "research_report_provider_identity_check",
      sql`length(btrim(${table.operation_id})) > 0
        and ${table.sequence} >= 0
        and ${table.input_digest} ~ '^[0-9a-f]{64}$'
        and jsonb_typeof(${table.input_json}::jsonb) = 'object'
        and ${table.attempt_count} >= 0`,
    ),
    check(
      "research_report_provider_state_check",
      sql`${table.state} in ('pending', 'completed', 'unknown', 'failed', 'canceled')
        and (${table.result_json} is null or jsonb_typeof(${table.result_json}::jsonb) = 'object')
        and (${table.state} <> 'completed' or (${table.result_json} is not null and ${table.completed_at} is not null))`,
    ),
  ],
);

const synthesisOperationStates = ["pending", "completed", "unknown", "failed", "canceled"] as const;

/** Stable model-operation and Company Cost evidence for one report synthesis. */
export const researchReportSynthesisOperations = pgTable(
  "research_report_synthesis_operations",
  {
    operation_id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => researchReports.workflow_id, { onDelete: "cascade" }),
    input_digest: text().notNull(),
    state: text({ enum: synthesisOperationStates }).notNull(),
    model_route: text().notNull(),
    model_access_policy_version: text().notNull(),
    resource_price_version: text().notNull(),
    result_key: text(),
    result_digest: text(),
    company_cost_json: text(),
    safe_failure_code: text(),
    attempt_count: integer().default(0).notNull(),
    started_at: timestamp({ withTimezone: true }),
    completed_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_report_synthesis_workflow_unique").on(table.workflow_id),
    index("research_report_synthesis_workflow_state_index").on(table.workflow_id, table.state),
    check(
      "research_report_synthesis_identity_check",
      sql`length(btrim(${table.operation_id})) > 0
        and ${table.input_digest} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.model_route})) > 0
        and length(btrim(${table.model_access_policy_version})) > 0
        and length(btrim(${table.resource_price_version})) > 0
        and ${table.attempt_count} >= 0`,
    ),
    check(
      "research_report_synthesis_state_check",
      sql`${table.state} in ('pending', 'completed', 'unknown', 'failed', 'canceled')
        and (${table.company_cost_json} is null or jsonb_typeof(${table.company_cost_json}::jsonb) = 'object')
        and (${table.state} <> 'completed' or (${table.result_key} is not null
          and ${table.result_digest} ~ '^[0-9a-f]{64}$'
          and ${table.company_cost_json} is not null
          and ${table.completed_at} is not null))`,
    ),
  ],
);

/** Global User-scoped milestone and terminal follow-up claim. */
export const researchReportNotifications = pgTable(
  "research_report_notifications",
  {
    notification_id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => researchReports.workflow_id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text({ enum: ["sourcesCollected", "terminal"] }).notNull(),
    claimed_at: timestamp({ withTimezone: true }).notNull(),
    think_submission_id: text(),
    delivered_at: timestamp({ withTimezone: true }),
    source_exposed_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("research_report_notifications_workflow_kind_unique").on(
      table.workflow_id,
      table.kind,
    ),
    index("research_report_notifications_user_claimed_index").on(table.user_id, table.claimed_at),
    check(
      "research_report_notifications_identity_check",
      sql`length(btrim(${table.notification_id})) > 0
        and ${table.kind} in ('sourcesCollected', 'terminal')
        and ((${table.think_submission_id} is null) = (${table.delivered_at} is null))
        and (${table.think_submission_id} is null or (length(${table.think_submission_id}) between 1 and 160 and position(':' in ${table.think_submission_id}) = 0))
        and (${table.delivered_at} is null or ${table.delivered_at} >= ${table.claimed_at})
        and (${table.source_exposed_at} is null or (${table.delivered_at} is not null and ${table.source_exposed_at} >= ${table.delivered_at}))`,
    ),
  ],
);

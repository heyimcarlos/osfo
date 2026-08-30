import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { allowancePeriods } from "./allowances";

const planValues = ["free", "adventurer"] as const;
const cohortStateValues = [
  "PROVISIONING",
  "ACTIVE",
  "PRODUCT_DELETED",
  "SCRUBBING",
  "SCRUBBED",
] as const;
const participantStateValues = ["ACTIVE", "DELETION_REQUESTED", "DELETED"] as const;
const provisionStateValues = ["PENDING", "CONSUMED"] as const;
const attemptStateValues = ["OFFERED", "DECIDED"] as const;

/** Server-owned provenance for one disposable qualification cohort. */
export const qualificationCohorts = pgTable(
  "qualification_cohorts",
  {
    artifact_checksum: text().notNull(),
    artifact_id: text().notNull(),
    activated_at: timestamp({ mode: "date", withTimezone: true }),
    cohort_id: text().primaryKey(),
    created_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    created_for_qualification: boolean().notNull(),
    execution_id: text().notNull(),
    expected_adventurer_participants: integer().notNull(),
    expected_free_participants: integer().notNull(),
    expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    manifest_checksum: text().notNull(),
    not_before: timestamp({ mode: "date", withTimezone: true }).notNull(),
    plan_checksum: text().notNull(),
    source_version: text().notNull(),
    state: text({ enum: cohortStateValues }).notNull(),
    teardown_policy: text().notNull(),
  },
  (table) => [
    unique("qualification_cohorts_execution_unique").on(table.execution_id),
    unique("qualification_cohorts_identity_unique").on(table.cohort_id, table.execution_id),
    check(
      "qualification_cohorts_qualification_only_check",
      sql`${table.created_for_qualification} and ${table.teardown_policy} = 'permanentAccountDeletion'`,
    ),
    check(
      "qualification_cohorts_time_bounds_check",
      sql`${table.created_at} <= ${table.not_before} and ${table.not_before} < ${table.expires_at}`,
    ),
    check(
      "qualification_cohorts_activation_check",
      sql`(${table.state} = 'PROVISIONING' and ${table.activated_at} is null)
        or (${table.state} <> 'PROVISIONING' and ${table.activated_at} is not null)`,
    ),
    check(
      "qualification_cohorts_counts_check",
      sql`${table.expected_free_participants} > 0 and ${table.expected_adventurer_participants} > 0`,
    ),
  ],
);

/** One-shot enrollment minted before Better Auth creates a disposable qualification User. */
export const qualificationParticipantProvisions = pgTable(
  "qualification_participant_provisions",
  {
    cohort_id: text().notNull(),
    consumed_at: timestamp({ mode: "date", withTimezone: true }),
    created_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
    enrollment_digest: text().notNull(),
    execution_id: text().notNull(),
    expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    participant_index: integer().notNull(),
    plan: text({ enum: planValues }).notNull(),
    provision_checksum: text().notNull(),
    provision_id: text().primaryKey(),
    state: text({ enum: provisionStateValues }).notNull(),
    user_id: text(),
  },
  (table) => [
    foreignKey({
      columns: [table.cohort_id, table.execution_id],
      foreignColumns: [qualificationCohorts.cohort_id, qualificationCohorts.execution_id],
      name: "qualification_participant_provisions_cohort_fk",
    }).onDelete("restrict"),
    unique("qualification_participant_provisions_position_unique").on(
      table.cohort_id,
      table.plan,
      table.participant_index,
    ),
    unique("qualification_participant_provisions_digest_unique").on(table.enrollment_digest),
    unique("qualification_participant_provisions_user_unique").on(table.user_id),
    unique("qualification_participant_provisions_identity_unique").on(
      table.provision_id,
      table.user_id,
    ),
    check(
      "qualification_participant_provisions_time_bounds_check",
      sql`${table.created_at} < ${table.expires_at}`,
    ),
    check("qualification_participant_provisions_index_check", sql`${table.participant_index} >= 0`),
    check(
      "qualification_participant_provisions_lifecycle_check",
      sql`(${table.state} = 'PENDING' and ${table.consumed_at} is null and ${table.user_id} is null)
        or (${table.state} = 'CONSUMED' and ${table.consumed_at} is not null and ${table.user_id} is not null)`,
    ),
  ],
);

/** Append-only allocation created only by the disposable qualification provisioner. */
export const qualificationParticipantAllocations = pgTable(
  "qualification_participant_allocations",
  {
    agent_id: text().notNull(),
    allocation_id: text().primaryKey(),
    cohort_id: text().notNull(),
    created_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    created_for_qualification: boolean().notNull(),
    deleted_at: timestamp({ mode: "date", withTimezone: true }),
    deletion_case_id: text(),
    deletion_receipt_checksum: text(),
    deletion_receipt_id: text(),
    deletion_requested_at: timestamp({ mode: "date", withTimezone: true }),
    execution_id: text().notNull(),
    expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    grant_checksum: text().notNull(),
    grant_id: text().notNull(),
    not_before: timestamp({ mode: "date", withTimezone: true }).notNull(),
    participant_index: integer().notNull(),
    plan: text({ enum: planValues }).notNull(),
    provision_checksum: text().notNull(),
    provision_id: text().notNull(),
    route_id: text().notNull(),
    session_id: text().notNull(),
    state: text({ enum: participantStateValues }).notNull(),
    user_id: text().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.cohort_id, table.execution_id],
      foreignColumns: [qualificationCohorts.cohort_id, qualificationCohorts.execution_id],
      name: "qualification_participant_allocations_cohort_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.provision_id, table.user_id],
      foreignColumns: [
        qualificationParticipantProvisions.provision_id,
        qualificationParticipantProvisions.user_id,
      ],
      name: "qualification_participant_allocations_provision_user_fk",
    }).onDelete("restrict"),
    unique("qualification_participant_allocations_position_unique").on(
      table.cohort_id,
      table.plan,
      table.participant_index,
    ),
    unique("qualification_participant_allocations_user_unique").on(table.user_id),
    unique("qualification_participant_allocations_agent_unique").on(table.agent_id),
    unique("qualification_participant_allocations_session_unique").on(table.session_id),
    unique("qualification_participant_allocations_grant_unique").on(table.grant_id),
    check(
      "qualification_participant_allocations_qualification_only_check",
      sql`${table.created_for_qualification}`,
    ),
    check(
      "qualification_participant_allocations_time_bounds_check",
      sql`${table.created_at} <= ${table.not_before} and ${table.not_before} < ${table.expires_at}`,
    ),
    check(
      "qualification_participant_allocations_index_check",
      sql`${table.participant_index} >= 0`,
    ),
    check(
      "qualification_participant_allocations_deletion_check",
      sql`(${table.state} = 'ACTIVE' and ${table.deletion_case_id} is null and ${table.deletion_requested_at} is null and ${table.deleted_at} is null and ${table.deletion_receipt_id} is null and ${table.deletion_receipt_checksum} is null)
        or (${table.state} = 'DELETION_REQUESTED' and ${table.deletion_case_id} is not null and ${table.deletion_requested_at} is not null and ${table.deleted_at} is null and ${table.deletion_receipt_id} is null and ${table.deletion_receipt_checksum} is null)
        or (${table.state} = 'DELETED' and ${table.deletion_case_id} is not null and ${table.deletion_requested_at} is not null and ${table.deleted_at} is not null and ${table.deletion_receipt_id} is not null and ${table.deletion_receipt_checksum} is not null)`,
    ),
  ],
);

/** Producer confirmation written only after one bounded grant page is retained and read back. */
export const qualificationCohortFinalizationPages = pgTable(
  "qualification_cohort_finalization_pages",
  {
    cohort_id: text().notNull(),
    execution_id: text().notNull(),
    first_participant_index: integer().notNull(),
    page_index: integer().notNull(),
    participant_count: integer().notNull(),
    plan: text({ enum: planValues }).notNull(),
    receipt_checksum: text().notNull(),
    receipt_id: text().primaryKey(),
    verified_at: timestamp({ mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.cohort_id, table.execution_id],
      foreignColumns: [qualificationCohorts.cohort_id, qualificationCohorts.execution_id],
      name: "qualification_cohort_finalization_pages_cohort_fk",
    }).onDelete("restrict"),
    unique("qualification_cohort_finalization_pages_position_unique").on(
      table.cohort_id,
      table.plan,
      table.page_index,
    ),
    check(
      "qualification_cohort_finalization_pages_bounds_check",
      sql`${table.page_index} >= 0 and ${table.first_participant_index} >= 0 and ${table.participant_count} > 0 and ${table.participant_count} <= 25`,
    ),
  ],
);

/** Bounded artifact-scrub progress derived from authenticated product-deletion receipts. */
export const qualificationCohortScrubPages = pgTable(
  "qualification_cohort_scrub_pages",
  {
    claim_token: text().notNull(),
    claimed_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    cohort_id: text().notNull(),
    completed_at: timestamp({ mode: "date", withTimezone: true }),
    deleted_artifact_count: integer(),
    deleted_artifacts_checksum: text(),
    deletion_receipts_checksum: text().notNull(),
    execution_id: text().notNull(),
    expected_artifact_count: integer().notNull(),
    expected_artifacts_checksum: text().notNull(),
    first_participant_index: integer().notNull(),
    lease_expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    page_checksum: text(),
    page_index: integer().notNull(),
    participant_count: integer().notNull(),
    plan: text({ enum: planValues }).notNull(),
    previous_page_checksum: text().notNull(),
    scrub_page_id: text().primaryKey(),
  },
  (table) => [
    foreignKey({
      columns: [table.cohort_id, table.execution_id],
      foreignColumns: [qualificationCohorts.cohort_id, qualificationCohorts.execution_id],
      name: "qualification_cohort_scrub_pages_cohort_fk",
    }).onDelete("restrict"),
    unique("qualification_cohort_scrub_pages_position_unique").on(
      table.cohort_id,
      table.plan,
      table.page_index,
    ),
    check(
      "qualification_cohort_scrub_pages_bounds_check",
      sql`${table.page_index} >= 0 and ${table.first_participant_index} >= 0
        and ${table.participant_count} > 0 and ${table.participant_count} <= 25
        and ${table.expected_artifact_count} > 0`,
    ),
    check(
      "qualification_cohort_scrub_pages_time_check",
      sql`${table.claimed_at} < ${table.lease_expires_at}
        and (${table.completed_at} is null or ${table.completed_at} >= ${table.claimed_at})`,
    ),
    check(
      "qualification_cohort_scrub_pages_completion_check",
      sql`(${table.completed_at} is null and ${table.deleted_artifact_count} is null
          and ${table.deleted_artifacts_checksum} is null and ${table.page_checksum} is null)
        or (${table.completed_at} is not null and ${table.deleted_artifact_count} is not null
          and ${table.deleted_artifacts_checksum} is not null and ${table.page_checksum} is not null)`,
    ),
  ],
);

/** One content-free root receipt retained only after every exact scrub page completes. */
export const qualificationCohortScrubRoots = pgTable(
  "qualification_cohort_scrub_roots",
  {
    claim_token: text().notNull(),
    claimed_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    cohort_id: text().notNull(),
    completed_at: timestamp({ mode: "date", withTimezone: true }),
    deleted_artifact_count: integer(),
    deleted_artifacts_checksum: text(),
    execution_id: text().notNull(),
    expected_artifact_count: integer().notNull(),
    expected_artifacts_checksum: text().notNull(),
    expected_page_count: integer().notNull(),
    expected_participant_count: integer().notNull(),
    final_page_checksum: text().notNull(),
    lease_expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    root_checksum: text(),
    scrub_root_id: text().primaryKey(),
  },
  (table) => [
    foreignKey({
      columns: [table.cohort_id, table.execution_id],
      foreignColumns: [qualificationCohorts.cohort_id, qualificationCohorts.execution_id],
      name: "qualification_cohort_scrub_roots_cohort_fk",
    }).onDelete("restrict"),
    unique("qualification_cohort_scrub_roots_cohort_unique").on(
      table.cohort_id,
      table.execution_id,
    ),
    check(
      "qualification_cohort_scrub_roots_bounds_check",
      sql`${table.expected_artifact_count} > 0 and ${table.expected_page_count} > 0
        and ${table.expected_participant_count} > 0`,
    ),
    check(
      "qualification_cohort_scrub_roots_time_check",
      sql`${table.claimed_at} < ${table.lease_expires_at}
        and (${table.completed_at} is null or ${table.completed_at} >= ${table.claimed_at})`,
    ),
    check(
      "qualification_cohort_scrub_roots_completion_check",
      sql`(${table.completed_at} is null and ${table.deleted_artifact_count} is null
          and ${table.deleted_artifacts_checksum} is null and ${table.root_checksum} is null)
        or (${table.completed_at} is not null and ${table.deleted_artifact_count} is not null
          and ${table.deleted_artifacts_checksum} is not null and ${table.root_checksum} is not null)`,
    ),
  ],
);

/** Workload-owned identity index; product outcome authority remains in each owning subsystem. */
export const qualificationRootAttempts = pgTable(
  "qualification_root_attempts",
  {
    admission_decision: text({
      enum: ["accepted", "capacityRejected", "typedStressRejected"],
    }),
    admission_fact_id: text(),
    admission_observed_at: timestamp({ mode: "date", withTimezone: true }),
    agent_id: text().notNull(),
    allocation_id: text().notNull(),
    allowance_period_id: text().notNull(),
    auth_session_expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    auth_session_id: text().notNull(),
    attempt_id: text().primaryKey(),
    execution_id: text().notNull(),
    journey: text().notNull(),
    offered_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    plan_checksum: text().notNull(),
    root_id: text().notNull(),
    run_id: text().notNull(),
    session_id: text().notNull(),
    state: text({ enum: attemptStateValues }).notNull(),
    submission_id: text().notNull(),
    user_id: text().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.allocation_id],
      foreignColumns: [qualificationParticipantAllocations.allocation_id],
      name: "qualification_root_attempts_allocation_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.user_id, table.allowance_period_id],
      foreignColumns: [allowancePeriods.user_id, allowancePeriods.allowance_period_id],
      name: "qualification_root_attempts_user_period_fk",
    }).onDelete("restrict"),
    unique("qualification_root_attempts_root_unique").on(table.execution_id, table.root_id),
    unique("qualification_root_attempts_submission_unique").on(table.submission_id),
    check(
      "qualification_root_attempts_state_check",
      sql`(${table.state} = 'OFFERED' and ${table.admission_decision} is null and ${table.admission_fact_id} is null and ${table.admission_observed_at} is null)
        or (${table.state} = 'DECIDED' and ${table.admission_decision} is not null and ${table.admission_fact_id} is not null and ${table.admission_observed_at} is not null)`,
    ),
    check(
      "qualification_root_attempts_auth_session_lifetime_check",
      sql`${table.offered_at} < ${table.auth_session_expires_at}`,
    ),
  ],
);

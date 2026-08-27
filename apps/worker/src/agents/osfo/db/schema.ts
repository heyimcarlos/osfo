import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type {
  AgentId,
  AgentInitializationId,
  AllowancePeriodId,
  AssistantMessageId,
  ConversationRouteId,
  SessionId,
  ThinkSubmissionId,
  ThinkRequestId,
  UserId,
} from "../../../domain";
import type { ModelCallAttemptId } from "../../../domain/model-call-attempt";
import type { FileDigest, FileMediaType } from "../../../domain/file-content";
import type {
  FileAnalysisId,
  FileAnalysisState,
  FileId,
  FileName,
  FileState,
  FileUploadId,
} from "../../../domain/file";
import type {
  GoodRootOutcomeEvaluationId,
  PersonalSkillId,
  PersonalSkillVersionId,
  SkillLearningCandidateId,
  SkillLearningModelAttemptId,
} from "../../../domain/personal-skill";
import type { DbTimestamp } from "../../../db";

const agentId = customType<{ data: AgentId; driverData: string }>({
  dataType: () => "text",
});
const initializationId = customType<{ data: AgentInitializationId; driverData: string }>({
  dataType: () => "text",
});
const routeId = customType<{ data: ConversationRouteId; driverData: string }>({
  dataType: () => "text",
});
const sessionId = customType<{ data: SessionId; driverData: string }>({
  dataType: () => "text",
});
const assistantMessageId = customType<{ data: AssistantMessageId; driverData: string }>({
  dataType: () => "text",
});
const thinkRequestId = customType<{ data: ThinkRequestId; driverData: string }>({
  dataType: () => "text",
});
const thinkSubmissionId = customType<{ data: ThinkSubmissionId; driverData: string }>({
  dataType: () => "text",
});
const timestamp = customType<{ data: DbTimestamp; driverData: string }>({
  dataType: () => "text",
});
const allowancePeriodId = customType<{ data: AllowancePeriodId; driverData: string }>({
  dataType: () => "text",
});
const modelCallAttemptId = customType<{ data: ModelCallAttemptId; driverData: string }>({
  dataType: () => "text",
});
const fileId = customType<{ data: FileId; driverData: string }>({ dataType: () => "text" });
const fileUploadId = customType<{ data: FileUploadId; driverData: string }>({
  dataType: () => "text",
});
const userId = customType<{ data: UserId; driverData: string }>({ dataType: () => "text" });
const fileDigest = customType<{ data: FileDigest; driverData: string }>({ dataType: () => "text" });
const fileMediaType = customType<{ data: FileMediaType; driverData: string }>({
  dataType: () => "text",
});
const fileName = customType<{ data: FileName; driverData: string }>({ dataType: () => "text" });
const fileState = customType<{ data: FileState; driverData: string }>({ dataType: () => "text" });
const fileAnalysisId = customType<{ data: FileAnalysisId; driverData: string }>({
  dataType: () => "text",
});
const fileAnalysisState = customType<{ data: FileAnalysisState; driverData: string }>({
  dataType: () => "text",
});
const personalSkillId = customType<{ data: PersonalSkillId; driverData: string }>({
  dataType: () => "text",
});
const goodRootOutcomeEvaluationId = customType<{
  data: GoodRootOutcomeEvaluationId;
  driverData: string;
}>({ dataType: () => "text" });
const personalSkillVersionId = customType<{
  data: PersonalSkillVersionId;
  driverData: string;
}>({ dataType: () => "text" });
const skillLearningCandidateId = customType<{
  data: SkillLearningCandidateId;
  driverData: string;
}>({ dataType: () => "text" });
const skillLearningModelAttemptId = customType<{
  data: SkillLearningModelAttemptId;
  driverData: string;
}>({ dataType: () => "text" });

/** Ordered provider work retained until its external effect is confirmed. */
export const memoryProviderOutbox = sqliteTable(
  "osfo_memory_provider_outbox",
  {
    allowance_period_id: allowancePeriodId(),
    attempt_count: integer().notNull().default(0),
    available_at: timestamp().notNull(),
    claim_expires_at: timestamp(),
    claim_token: text(),
    completed_at: timestamp(),
    deletion_progress_json: text(),
    enqueued_at: timestamp().notNull(),
    last_error: text(),
    operation_type: text({
      enum: [
        "saveConversation",
        "deleteSessionConversation",
        "deleteUserKnowledge",
        "forgetKnowledge",
      ],
    }).notNull(),
    ordering_key: text().notNull(),
    outbox_id: text().primaryKey(),
    payload_json: text().notNull(),
    provider_accepted_at: timestamp(),
    provider_document_id: text(),
    provider_submission_ambiguous: integer({ mode: "boolean" }).notNull().default(false),
    provider_status: text({
      enum: ["processing", "done", "failed"],
    }),
    sequence: integer().notNull().unique(),
    status: text({ enum: ["pending", "claimed", "completed", "failed"] }).notNull(),
    usage_json: text(),
  },
  (table) => [
    check(
      "osfo_memory_provider_outbox_operation",
      sql`${table.operation_type} IN ('saveConversation', 'deleteSessionConversation', 'deleteUserKnowledge', 'forgetKnowledge')`,
    ),
    check(
      "osfo_memory_provider_outbox_status",
      sql`${table.status} IN ('pending', 'claimed', 'completed', 'failed')`,
    ),
    check(
      "osfo_memory_provider_outbox_provider_status",
      sql`${table.provider_status} IS NULL OR ${table.provider_status} IN ('processing', 'done', 'failed')`,
    ),
    check("osfo_memory_provider_outbox_attempt_count", sql`${table.attempt_count} >= 0`),
    index("osfo_memory_provider_outbox_reconciliation").on(
      table.status,
      table.available_at,
      table.sequence,
    ),
    index("osfo_memory_provider_outbox_order").on(table.ordering_key, table.sequence),
  ],
);

/** Agent-local repair status for versioned provider extraction guidance. */
export const memoryProviderConfiguration = sqliteTable(
  "osfo_memory_provider_configuration",
  {
    configured_at: timestamp(),
    scope: text({ enum: ["organization", "user"] }).primaryKey(),
    status: text({ enum: ["pending", "configured"] }).notNull(),
    updated_at: timestamp().notNull(),
    version: text().notNull(),
  },
  (table) => [
    check(
      "osfo_memory_provider_configuration_scope",
      sql`${table.scope} IN ('organization', 'user')`,
    ),
    check(
      "osfo_memory_provider_configuration_status",
      sql`${table.status} IN ('pending', 'configured')`,
    ),
    check(
      "osfo_memory_provider_configuration_completion",
      sql`(${table.status} = 'configured' AND ${table.configured_at} IS NOT NULL) OR (${table.status} = 'pending' AND ${table.configured_at} IS NULL)`,
    ),
  ],
);

/** Stable Agent-local conversation routes. */
export const conversationRoutes = sqliteTable(
  "osfo_conversation_routes",
  {
    is_primary: integer({ mode: "boolean" }).notNull(),
    route_id: routeId().primaryKey(),
  },
  (table) => [
    check("osfo_conversation_route_primary_boolean", sql`${table.is_primary} IN (0, 1)`),
    uniqueIndex("osfo_one_primary_route")
      .on(table.is_primary)
      .where(sql`${table.is_primary} = 1`),
  ],
);

/** Think Session identities and their ownership by an Agent-local route. */
export const sessionOwnership = sqliteTable(
  "osfo_session_ownership",
  {
    became_current_at: timestamp().notNull(),
    ownership_sequence: integer().notNull().unique(),
    replaced_at: timestamp(),
    route_id: routeId()
      .notNull()
      .references(() => conversationRoutes.route_id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    session_id: sessionId().primaryKey(),
  },
  (table) => [
    uniqueIndex("osfo_one_current_session_per_route")
      .on(table.route_id)
      .where(sql`${table.replaced_at} IS NULL`),
    index("osfo_sessions_by_route").on(table.route_id, table.ownership_sequence),
  ],
);

/** Short-lived unguessable continuation state for bounded Session Recall pages. */
export const sessionRecallCursors = sqliteTable(
  "osfo_session_recall_cursors",
  {
    after_ownership_sequence: integer(),
    cursor: text().primaryKey(),
    expires_at: timestamp()
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes'))`),
    route_id: routeId()
      .notNull()
      .references(() => conversationRoutes.route_id, { onDelete: "cascade", onUpdate: "restrict" }),
    snapshot_current_session_id: sessionId()
      .notNull()
      .references(() => sessionOwnership.session_id, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    snapshot_max_ownership_sequence: integer().notNull(),
  },
  (table) => [index("osfo_session_recall_cursors_by_expiry").on(table.expires_at)],
);

/** Singleton evidence that the named Durable Object completed Agent initialization. */
export const agentInitialization = sqliteTable(
  "osfo_agent_initialization",
  {
    agent_id: agentId().notNull().unique(),
    initialization_id: initializationId().notNull().unique(),
    initialized_at: timestamp().notNull(),
    initial_route_id: routeId()
      .notNull()
      .references(() => conversationRoutes.route_id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    initial_session_id: sessionId()
      .notNull()
      .references(() => sessionOwnership.session_id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    singleton_key: text().primaryKey(),
  },
  (table) => [check("osfo_agent_initialization_singleton", sql`${table.singleton_key} = 'agent'`)],
);

/** Idempotent Osfo observation receipts for committed Think turns. */
export const committedTurns = sqliteTable(
  "osfo_committed_turns",
  {
    assistant_message_id: assistantMessageId().notNull().unique(),
    observation_sequence: integer().primaryKey({ autoIncrement: true }),
    observed_at: text()
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    session_id: sessionId()
      .notNull()
      .references(() => sessionOwnership.session_id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    source: text({ enum: ["hook", "reconciliation"] }).notNull(),
    think_request_id: thinkRequestId(),
  },
  (table) => [
    check("osfo_committed_turn_source", sql`${table.source} IN ('hook', 'reconciliation')`),
    index("osfo_committed_turns_by_session").on(table.session_id, table.observation_sequence),
    uniqueIndex("osfo_committed_turn_think_request_unique")
      .on(table.think_request_id)
      .where(sql`${table.think_request_id} IS NOT NULL`),
  ],
);

/** Durable normalized model-call evidence awaiting idempotent Allowance recording. */
export const modelCallUsageEvidence = sqliteTable(
  "osfo_model_call_usage_evidence",
  {
    allowance_period_id: allowancePeriodId().notNull(),
    attempt_id: modelCallAttemptId().primaryKey(),
    dispatched_at: timestamp(),
    items_json: text().notNull(),
    recorded_at: timestamp().notNull(),
  },
  (table) => [
    index("osfo_model_call_usage_pending")
      .on(table.recorded_at)
      .where(sql`${table.dispatched_at} IS NULL`),
  ],
);

/** User-owned file metadata and source-byte recovery state. */
export const files = sqliteTable(
  "osfo_files",
  {
    accepted_at: timestamp().notNull(),
    allowance_period_id: allowancePeriodId().notNull(),
    byte_length: integer().notNull(),
    deleted_at: timestamp(),
    file_id: fileId().primaryKey(),
    file_name: fileName().notNull(),
    media_type: fileMediaType().notNull(),
    normalization_claimed_at: timestamp(),
    normalization_error: text(),
    normalized_text: text(),
    object_key: text().notNull().unique(),
    provenance_json: text(),
    sha256: fileDigest().notNull(),
    state: fileState().notNull(),
    upload_id: fileUploadId().notNull().unique(),
    user_id: userId().notNull(),
  },
  (table) => [
    check("osfo_file_byte_length_positive", sql`${table.byte_length} > 0`),
    check(
      "osfo_file_state",
      sql`${table.state} IN ('pending_storage', 'stored', 'normalizing', 'ready', 'normalization_failed', 'deleting', 'deleted')`,
    ),
    check(
      "osfo_file_normalizing_state",
      sql`(${table.state} = 'normalizing' AND ${table.normalization_claimed_at} IS NOT NULL) OR (${table.state} != 'normalizing' AND ${table.normalization_claimed_at} IS NULL)`,
    ),
    check(
      "osfo_file_deleted_state",
      sql`(${table.state} = 'deleted' AND ${table.deleted_at} IS NOT NULL) OR (${table.state} != 'deleted' AND ${table.deleted_at} IS NULL)`,
    ),
    index("osfo_files_by_owner_state").on(table.user_id, table.state),
  ],
);

/** Idempotent file analysis operations and recovery outcomes. */
export const fileAnalyses = sqliteTable(
  "osfo_file_analyses",
  {
    allowance_period_id: allowancePeriodId().notNull(),
    analysis_id: fileAnalysisId().primaryKey(),
    created_at: timestamp().notNull(),
    failure: text(),
    file_id: fileId()
      .notNull()
      .references(() => files.file_id, { onDelete: "restrict", onUpdate: "restrict" }),
    prompt: text().notNull(),
    result_text: text(),
    state: fileAnalysisState().notNull(),
    updated_at: timestamp().notNull(),
    vendor_usd_micros: integer(),
  },
  (table) => [
    check(
      "osfo_file_analysis_state",
      sql`${table.state} IN ('pending', 'ambiguous', 'completed_cleanup_pending', 'failed_cleanup_pending', 'completed', 'failed', 'deleted')`,
    ),
    index("osfo_file_analyses_by_file").on(table.file_id, table.created_at),
  ],
);

/** Source and derived-content deletion lineage for one file. */
export const fileDeletions = sqliteTable("osfo_file_deletions", {
  action_id: text().notNull(),
  analysis_count: integer().notNull(),
  deleted_at: timestamp().notNull(),
  file_id: fileId()
    .primaryKey()
    .references(() => files.file_id, { onDelete: "restrict", onUpdate: "restrict" }),
  source_object_key: text().notNull(),
  source_sha256: fileDigest().notNull(),
  user_id: userId().notNull(),
});

/** Current personal Skill pointers and deterministic selection metadata. */
export const personalSkills = sqliteTable(
  "osfo_personal_skills",
  {
    current_revision: integer().notNull(),
    current_skill_version: personalSkillVersionId().notNull().unique(),
    last_used_at_epoch_millis: integer(),
    owner_user_id: userId().notNull(),
    skill_id: personalSkillId().primaryKey(),
    status: text({ enum: ["active", "archived"] }).notNull(),
  },
  (table) => [
    check("osfo_personal_skill_revision_positive", sql`${table.current_revision} > 0`),
    check("osfo_personal_skill_status", sql`${table.status} IN ('active', 'archived')`),
    index("osfo_personal_skills_by_owner_status").on(table.owner_user_id, table.status),
  ],
);

/** Immutable evidence-backed personal Skill revisions. */
export const personalSkillVersions = sqliteTable(
  "osfo_personal_skill_versions",
  {
    revision: integer().notNull(),
    skill_id: personalSkillId()
      .notNull()
      .references(() => personalSkills.skill_id, { onDelete: "cascade", onUpdate: "restrict" }),
    skill_version: personalSkillVersionId().notNull().unique(),
    version_json: text().notNull(),
  },
  (table) => [
    check("osfo_personal_skill_version_revision_positive", sql`${table.revision} > 0`),
    uniqueIndex("osfo_personal_skill_version_revision").on(table.skill_id, table.revision),
  ],
);

/** Bounded post-root-commit learning candidates and their lease state. */
export const personalSkillLearningCandidates = sqliteTable(
  "osfo_personal_skill_learning_candidates",
  {
    accepted_skill_version: personalSkillVersionId(),
    attempts: integer().notNull().default(0),
    candidate_id: skillLearningCandidateId().primaryKey(),
    candidate_json: text().notNull(),
    claim_expires_at_epoch_millis: integer(),
    claim_token: text(),
    created_at_epoch_millis: integer().notNull(),
    notification_delivered_at_epoch_millis: integer(),
    notification_text: text(),
    owner_user_id: userId().notNull(),
    prior_skill_version: personalSkillVersionId(),
    status: text({ enum: ["pending", "claimed", "accepted", "rejected"] }).notNull(),
    undo_target_skill_version: personalSkillVersionId(),
    updated_at_epoch_millis: integer().notNull(),
  },
  (table) => [
    check("osfo_personal_skill_learning_attempts", sql`${table.attempts} >= 0`),
    check(
      "osfo_personal_skill_learning_status",
      sql`${table.status} IN ('pending', 'claimed', 'accepted', 'rejected')`,
    ),
    check(
      "osfo_personal_skill_learning_claim",
      sql`(${table.status} = 'claimed' AND ${table.claim_token} IS NOT NULL AND ${table.claim_expires_at_epoch_millis} IS NOT NULL) OR (${table.status} != 'claimed' AND ${table.claim_token} IS NULL AND ${table.claim_expires_at_epoch_millis} IS NULL)`,
    ),
    index("osfo_personal_skill_learning_by_owner_status").on(
      table.owner_user_id,
      table.status,
      table.created_at_epoch_millis,
    ),
  ],
);

/** Idempotent company-funded cost evidence for every Skill Learning model attempt. */
export const personalSkillLearningModelAttempts = sqliteTable(
  "osfo_personal_skill_learning_model_attempts",
  {
    attempt_id: skillLearningModelAttemptId().primaryKey(),
    basis: text({ enum: ["conservative", "observed"] }).notNull(),
    candidate_id: skillLearningCandidateId().notNull(),
    model_input_tokens: integer().notNull(),
    model_output_tokens: integer().notNull(),
    outcome: text({ enum: ["failure", "success"] }).notNull(),
    recorded_at_epoch_millis: integer().notNull(),
    vendor_usd_micros: integer().notNull(),
  },
  (table) => [
    check(
      "osfo_personal_skill_learning_model_attempt_nonnegative",
      sql`${table.model_input_tokens} >= 0 AND ${table.model_output_tokens} >= 0 AND ${table.vendor_usd_micros} >= 0`,
    ),
    index("osfo_personal_skill_learning_model_attempts_by_candidate").on(table.candidate_id),
  ],
);

/** Immutable PASS receipts minted by the retained Good Root evaluator authority. */
export const goodRootOutcomeEvaluations = sqliteTable(
  "osfo_good_root_outcome_evaluations",
  {
    evaluation_id: goodRootOutcomeEvaluationId().primaryKey(),
    owner_user_id: userId().notNull(),
    receipt_json: text().notNull(),
    retained_at_epoch_millis: integer().notNull(),
  },
  (table) => [
    index("osfo_good_root_outcome_evaluations_by_owner").on(
      table.owner_user_id,
      table.retained_at_epoch_millis,
    ),
  ],
);

/** Idempotent bounded public-web operations owned by one User turn. */
export const webOperations = sqliteTable(
  "osfo_web_operations",
  {
    created_at_epoch_millis: integer().notNull(),
    fingerprint: text().notNull(),
    kind: text({ enum: ["page", "search"] }).notNull(),
    operation_id: text().primaryKey(),
    owner_user_id: userId().notNull(),
    reserved_pages: integer().notNull(),
    result_json: text(),
    status: text({ enum: ["pending", "completed"] }).notNull(),
    turn_id: thinkSubmissionId().notNull(),
  },
  (table) => [
    check("osfo_web_operation_kind", sql`${table.kind} IN ('page', 'search')`),
    check("osfo_web_operation_status", sql`${table.status} IN ('pending', 'completed')`),
    check(
      "osfo_web_operation_completion",
      sql`(${table.status} = 'completed' AND ${table.result_json} IS NOT NULL) OR (${table.status} = 'pending' AND ${table.result_json} IS NULL)`,
    ),
    check("osfo_web_operation_pages", sql`${table.reserved_pages} BETWEEN 0 AND 3`),
    index("osfo_web_operations_by_turn").on(table.owner_user_id, table.turn_id, table.status),
  ],
);

/** Opaque ranked search identities retained only for recent User result sets. */
export const webResults = sqliteTable(
  "osfo_web_results",
  {
    owner_user_id: userId().notNull(),
    rank: integer().notNull(),
    result_id: text().primaryKey(),
    result_json: text().notNull(),
    result_set_id: text().notNull(),
    retained_at_epoch_millis: integer().notNull(),
  },
  (table) => [
    check("osfo_web_result_rank", sql`${table.rank} BETWEEN 1 AND 10`),
    index("osfo_web_results_by_owner_set").on(
      table.owner_user_id,
      table.retained_at_epoch_millis,
      table.result_set_id,
    ),
  ],
);

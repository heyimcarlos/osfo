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
  AcceptanceReceiptId,
  AllowancePeriodId,
  AssistantMessageId,
  ConversationRouteId,
  ChannelBindingId,
  ProviderMessageId,
  SessionId,
  ThinkRequestId,
  ThinkSubmissionId,
  UserMessageId,
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
const acceptanceReceiptId = customType<{ data: AcceptanceReceiptId; driverData: string }>({
  dataType: () => "text",
});
const channelBindingId = customType<{ data: ChannelBindingId; driverData: string }>({
  dataType: () => "text",
});
const providerMessageId = customType<{ data: ProviderMessageId; driverData: string }>({
  dataType: () => "text",
});
const thinkSubmissionId = customType<{ data: ThinkSubmissionId; driverData: string }>({
  dataType: () => "text",
});
const userMessageId = customType<{ data: UserMessageId; driverData: string }>({
  dataType: () => "text",
});

/** Stable Agent-local conversation routes. */
export const conversationRoutes = sqliteTable(
  "osfo_conversation_routes",
  {
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
    routeId: routeId("route_id").primaryKey(),
  },
  (table) => [
    check("osfo_conversation_route_primary_boolean", sql`${table.isPrimary} IN (0, 1)`),
    uniqueIndex("osfo_one_primary_route")
      .on(table.isPrimary)
      .where(sql`${table.isPrimary} = 1`),
  ],
);

/** Think Session identities and their ownership by an Agent-local route. */
export const sessionOwnership = sqliteTable(
  "osfo_session_ownership",
  {
    becameCurrentAt: timestamp("became_current_at").notNull(),
    ownershipSequence: integer("ownership_sequence").notNull().unique(),
    replacedAt: timestamp("replaced_at"),
    routeId: routeId("route_id")
      .notNull()
      .references(() => conversationRoutes.routeId, { onDelete: "restrict", onUpdate: "restrict" }),
    sessionId: sessionId("session_id").primaryKey(),
  },
  (table) => [
    uniqueIndex("osfo_one_current_session_per_route")
      .on(table.routeId)
      .where(sql`${table.replacedAt} IS NULL`),
    index("osfo_sessions_by_route").on(table.routeId, table.ownershipSequence),
  ],
);

/** Short-lived unguessable continuation state for bounded Session Recall pages. */
export const sessionRecallCursors = sqliteTable(
  "osfo_session_recall_cursors",
  {
    afterOwnershipSequence: integer("after_ownership_sequence"),
    cursor: text("cursor").primaryKey(),
    expiresAt: timestamp("expires_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes'))`),
    routeId: routeId("route_id")
      .notNull()
      .references(() => conversationRoutes.routeId, { onDelete: "cascade", onUpdate: "restrict" }),
    snapshotCurrentSessionId: sessionId("snapshot_current_session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    snapshotMaxOwnershipSequence: integer("snapshot_max_ownership_sequence").notNull(),
  },
  (table) => [index("osfo_session_recall_cursors_by_expiry").on(table.expiresAt)],
);

/** Singleton evidence that the named Durable Object completed Agent initialization. */
export const agentInitialization = sqliteTable(
  "osfo_agent_initialization",
  {
    agentId: agentId("agent_id").notNull().unique(),
    initializationId: initializationId("initialization_id").notNull().unique(),
    initializedAt: timestamp("initialized_at").notNull(),
    initialRouteId: routeId("initial_route_id")
      .notNull()
      .references(() => conversationRoutes.routeId, { onDelete: "restrict", onUpdate: "restrict" }),
    initialSessionId: sessionId("initial_session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, { onDelete: "restrict", onUpdate: "restrict" }),
    singletonKey: text("singleton_key").primaryKey(),
  },
  (table) => [check("osfo_agent_initialization_singleton", sql`${table.singletonKey} = 'agent'`)],
);

/** Idempotent Osfo observation receipts for committed Think turns. */
export const committedTurns = sqliteTable(
  "osfo_committed_turns",
  {
    assistantMessageId: assistantMessageId("assistant_message_id").notNull().unique(),
    observationSequence: integer("observation_sequence").primaryKey({ autoIncrement: true }),
    observedAt: text("observed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    sessionId: sessionId("session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, { onDelete: "restrict", onUpdate: "restrict" }),
    source: text("source", { enum: ["hook", "reconciliation"] }).notNull(),
    thinkRequestId: thinkRequestId("think_request_id"),
  },
  (table) => [
    check("osfo_committed_turn_source", sql`${table.source} IN ('hook', 'reconciliation')`),
    index("osfo_committed_turns_by_session").on(table.sessionId, table.observationSequence),
    uniqueIndex("osfo_committed_turn_think_request_unique")
      .on(table.thinkRequestId)
      .where(sql`${table.thinkRequestId} IS NOT NULL`),
  ],
);

/** Immutable mapping from one Channel Message Key to its Think acceptance. */
export const acceptanceReceipts = sqliteTable(
  "osfo_acceptance_receipts",
  {
    acceptedAt: text("accepted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    allowancePeriodId: allowancePeriodId("allowance_period_id").notNull(),
    channelBindingId: channelBindingId("channel_binding_id").notNull(),
    providerMessageId: providerMessageId("provider_message_id").notNull(),
    receiptId: acceptanceReceiptId("receipt_id").primaryKey(),
    sessionId: sessionId("session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, { onDelete: "restrict", onUpdate: "restrict" }),
    thinkSubmissionId: thinkSubmissionId("think_submission_id").notNull().unique(),
    userMessageId: userMessageId("user_message_id").notNull().unique(),
  },
  (table) => [
    uniqueIndex("osfo_acceptance_receipt_channel_message_unique").on(
      table.channelBindingId,
      table.providerMessageId,
    ),
    index("osfo_acceptance_receipts_by_session").on(table.sessionId, table.acceptedAt),
  ],
);

/** Immutable terminal receipts for accepted provider Session commands. */
export const sessionCommandReceipts = sqliteTable(
  "osfo_session_command_receipts",
  {
    acceptedAt: text("accepted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    allowancePeriodId: allowancePeriodId("allowance_period_id").notNull(),
    channelBindingId: channelBindingId("channel_binding_id").notNull(),
    command: text("command", { enum: ["/new"] }).notNull(),
    currentSessionId: sessionId("current_session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, { onDelete: "restrict", onUpdate: "restrict" }),
    historicalSessionId: sessionId("historical_session_id")
      .notNull()
      .references(() => sessionOwnership.sessionId, { onDelete: "restrict", onUpdate: "restrict" }),
    providerMessageId: providerMessageId("provider_message_id").notNull(),
    receiptId: acceptanceReceiptId("receipt_id").primaryKey(),
    routeId: routeId("route_id")
      .notNull()
      .references(() => conversationRoutes.routeId, { onDelete: "restrict", onUpdate: "restrict" }),
    userMessageId: userMessageId("user_message_id").notNull().unique(),
  },
  (table) => [
    uniqueIndex("osfo_session_command_receipt_channel_message_unique").on(
      table.channelBindingId,
      table.providerMessageId,
    ),
    index("osfo_session_command_receipts_by_route").on(table.routeId, table.acceptedAt),
  ],
);

/** Durable normalized model-call evidence awaiting idempotent Allowance recording. */
export const modelCallUsageEvidence = sqliteTable(
  "osfo_model_call_usage_evidence",
  {
    allowancePeriodId: allowancePeriodId("allowance_period_id").notNull(),
    attemptId: modelCallAttemptId("attempt_id").primaryKey(),
    dispatchedAt: timestamp("dispatched_at"),
    itemsJson: text("items_json").notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (table) => [
    index("osfo_model_call_usage_pending")
      .on(table.recordedAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
  ],
);

/** User-owned file metadata and source-byte recovery state. */
export const files = sqliteTable(
  "osfo_files",
  {
    acceptedAt: timestamp("accepted_at").notNull(),
    allowancePeriodId: allowancePeriodId("allowance_period_id").notNull(),
    byteLength: integer("byte_length").notNull(),
    deletedAt: timestamp("deleted_at"),
    fileId: fileId("file_id").primaryKey(),
    fileName: fileName("file_name").notNull(),
    mediaType: fileMediaType("media_type").notNull(),
    normalizationClaimedAt: timestamp("normalization_claimed_at"),
    normalizationError: text("normalization_error"),
    normalizedText: text("normalized_text"),
    objectKey: text("object_key").notNull().unique(),
    provenanceJson: text("provenance_json"),
    sha256: fileDigest("sha256").notNull(),
    state: fileState("state").notNull(),
    uploadId: fileUploadId("upload_id").notNull().unique(),
    userId: userId("user_id").notNull(),
  },
  (table) => [
    check("osfo_file_byte_length_positive", sql`${table.byteLength} > 0`),
    check(
      "osfo_file_state",
      sql`${table.state} IN ('pending_storage', 'stored', 'normalizing', 'ready', 'normalization_failed', 'deleting', 'deleted')`,
    ),
    check(
      "osfo_file_normalizing_state",
      sql`(${table.state} = 'normalizing' AND ${table.normalizationClaimedAt} IS NOT NULL) OR (${table.state} != 'normalizing' AND ${table.normalizationClaimedAt} IS NULL)`,
    ),
    check(
      "osfo_file_deleted_state",
      sql`(${table.state} = 'deleted' AND ${table.deletedAt} IS NOT NULL) OR (${table.state} != 'deleted' AND ${table.deletedAt} IS NULL)`,
    ),
    index("osfo_files_by_owner_state").on(table.userId, table.state),
  ],
);

/** Idempotent file analysis operations and recovery outcomes. */
export const fileAnalyses = sqliteTable(
  "osfo_file_analyses",
  {
    allowancePeriodId: allowancePeriodId("allowance_period_id").notNull(),
    analysisId: fileAnalysisId("analysis_id").primaryKey(),
    createdAt: timestamp("created_at").notNull(),
    failure: text("failure"),
    fileId: fileId("file_id")
      .notNull()
      .references(() => files.fileId, { onDelete: "restrict", onUpdate: "restrict" }),
    prompt: text("prompt").notNull(),
    resultText: text("result_text"),
    state: fileAnalysisState("state").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    vendorUsdMicros: integer("vendor_usd_micros"),
  },
  (table) => [
    check(
      "osfo_file_analysis_state",
      sql`${table.state} IN ('pending', 'ambiguous', 'completed_cleanup_pending', 'failed_cleanup_pending', 'completed', 'failed', 'deleted')`,
    ),
    index("osfo_file_analyses_by_file").on(table.fileId, table.createdAt),
  ],
);

/** Source and derived-content deletion lineage for one file. */
export const fileDeletions = sqliteTable("osfo_file_deletions", {
  actionId: text("action_id").notNull(),
  analysisCount: integer("analysis_count").notNull(),
  deletedAt: timestamp("deleted_at").notNull(),
  fileId: fileId("file_id")
    .primaryKey()
    .references(() => files.fileId, { onDelete: "restrict", onUpdate: "restrict" }),
  sourceObjectKey: text("source_object_key").notNull(),
  sourceSha256: fileDigest("source_sha256").notNull(),
  userId: userId("user_id").notNull(),
});

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
  ThinkRequestId,
} from "../../../domain";
import type {
  ActionDigest,
  ActionId,
  ActionPresentationId,
  ApprovalRequestId,
} from "../../../domain/action-approval";
import type { AuthorizationOperationName } from "../../../domain/authorization-operation";
import type { ModelCallAttemptId } from "../../../domain/model-call-attempt";
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
const actionId = customType<{ data: ActionId; driverData: string }>({
  dataType: () => "text",
});
const actionPresentationId = customType<{ data: ActionPresentationId; driverData: string }>({
  dataType: () => "text",
});
const approvalRequestId = customType<{ data: ApprovalRequestId; driverData: string }>({
  dataType: () => "text",
});
const actionDigest = customType<{ data: ActionDigest; driverData: string }>({
  dataType: () => "text",
});
const allowancePeriodId = customType<{ data: AllowancePeriodId; driverData: string }>({
  dataType: () => "text",
});
const modelCallAttemptId = customType<{ data: ModelCallAttemptId; driverData: string }>({
  dataType: () => "text",
});
const authorizationOperation = customType<{
  data: AuthorizationOperationName;
  driverData: string;
}>({ dataType: () => "text" });

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
    index("osfo_sessions_by_route").on(table.routeId, table.becameCurrentAt),
  ],
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

/** Immutable client-safe presentation bound to one exact Think Action. */
export const actionPresentations = sqliteTable(
  "osfo_action_presentations",
  {
    actionDefinitionVersion: text("action_definition_version").notNull(),
    actionDigest: actionDigest("action_digest").notNull(),
    actionId: actionId("action_id").notNull().unique(),
    consequencesJson: text("consequences_json").notNull(),
    createdAt: timestamp("created_at").notNull(),
    description: text("description").notNull(),
    executionId: text("execution_id").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    fieldsJson: text("fields_json").notNull(),
    operation: authorizationOperation("operation").notNull(),
    originatingAuthorityId: text("originating_authority_id").notNull(),
    originatingAuthorityKind: text("originating_authority_kind", {
      enum: ["authSession", "channelBinding", "scheduledTask", "workflow"],
    }).notNull(),
    presentationId: actionPresentationId("presentation_id").primaryKey(),
    title: text("title").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    check(
      "osfo_action_presentation_authority_kind",
      sql`${table.originatingAuthorityKind} IN ('authSession', 'channelBinding', 'scheduledTask', 'workflow')`,
    ),
    check(
      "osfo_action_presentation_expiry_after_creation",
      sql`julianday(${table.expiresAt}) > julianday(${table.createdAt})`,
    ),
    index("osfo_action_presentations_by_user").on(table.userId, table.createdAt),
  ],
);

/** Finite Approval Request for one immutable Action Presentation. */
export const approvalRequests = sqliteTable(
  "osfo_approval_requests",
  {
    actorAuthorityId: text("actor_authority_id"),
    actorAuthorityKind: text("actor_authority_kind", {
      enum: ["authSession", "channelBinding"],
    }),
    approvalRequestId: approvalRequestId("approval_request_id").notNull().unique(),
    decidedAt: timestamp("decided_at"),
    dispatchAmbiguousAt: timestamp("dispatch_ambiguous_at"),
    dispatchedAt: timestamp("dispatched_at"),
    presentationId: actionPresentationId("presentation_id")
      .primaryKey()
      .references(() => actionPresentations.presentationId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    reason: text("reason"),
    status: text("status", {
      enum: ["pending", "approved", "denied", "expired", "canceled"],
    }).notNull(),
  },
  (table) => [
    check(
      "osfo_approval_request_status",
      sql`${table.status} IN ('pending', 'approved', 'denied', 'expired', 'canceled')`,
    ),
    check(
      "osfo_approval_request_terminal_facts",
      sql`(${table.status} = 'pending' AND ${table.decidedAt} IS NULL AND ${table.dispatchAmbiguousAt} IS NULL AND ${table.dispatchedAt} IS NULL AND ${table.actorAuthorityKind} IS NULL AND ${table.actorAuthorityId} IS NULL)
        OR (${table.status} IN ('approved', 'denied') AND ${table.decidedAt} IS NOT NULL AND ${table.actorAuthorityKind} IS NOT NULL AND ${table.actorAuthorityId} IS NOT NULL)
        OR (${table.status} IN ('expired', 'canceled') AND ${table.decidedAt} IS NOT NULL AND ${table.actorAuthorityKind} IS NULL AND ${table.actorAuthorityId} IS NULL)`,
    ),
    index("osfo_approval_requests_by_status").on(table.status),
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

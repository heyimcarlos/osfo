import { sql } from "drizzle-orm";
import type { ThreadEvent } from "@osfo/session";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const transactionTimestamp = sql`transaction_timestamp()`;

type PublicationEvidence =
  | { readonly type: "pubsub"; readonly providerMessageId: string }
  | { readonly type: "legacyUnavailable" };

export const principals = pgTable("principals", {
  principalId: uuid("principal_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(transactionTimestamp),
});

export const authenticationSessions = pgTable(
  "authentication_sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.principalId),
    tokenSha256: text("token_sha256").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(transactionTimestamp),
  },
  (table) => [
    check(
      "authentication_sessions_token_sha256_check",
      sql`${table.tokenSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index("authentication_sessions_active_token_idx")
      .on(table.tokenSha256)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const threads = pgTable(
  "threads",
  {
    threadId: uuid("thread_id").primaryKey(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.principalId),
    nextPosition: bigint("next_position", { mode: "bigint" }).notNull().default(1n),
    stateRevision: integer("state_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(transactionTimestamp),
  },
  (table) => [
    unique("threads_thread_id_principal_id_unique").on(table.threadId, table.principalId),
    check("threads_next_position_check", sql`${table.nextPosition} > 0`),
    check("threads_state_revision_check", sql`${table.stateRevision} >= 0`),
  ],
);

export const relayPrincipals = pgTable(
  "relay_principals",
  {
    principalId: uuid("principal_id")
      .primaryKey()
      .references(() => principals.principalId),
    virtualPass: bigint("virtual_pass", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => [
    check("relay_principals_virtual_pass_check", sql`${table.virtualPass} >= 0`),
    index("relay_principals_selection_idx").on(table.virtualPass, table.principalId),
  ],
);

export const relayThreads = pgTable(
  "relay_threads",
  {
    threadId: uuid("thread_id").primaryKey(),
    principalId: uuid("principal_id").notNull(),
    virtualPass: bigint("virtual_pass", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.principalId],
      foreignColumns: [threads.threadId, threads.principalId],
    }),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [relayPrincipals.principalId],
    }),
    check("relay_threads_virtual_pass_check", sql`${table.virtualPass} >= 0`),
    index("relay_threads_selection_idx").on(table.principalId, table.virtualPass, table.threadId),
  ],
);

export const relayDispatchCapacity = pgTable(
  "relay_dispatch_capacity",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    activeCount: integer("active_count").notNull().default(0),
  },
  (table) => [
    check("relay_dispatch_capacity_singleton_check", sql`${table.singleton}`),
    check("relay_dispatch_capacity_active_count_check", sql`${table.activeCount} >= 0`),
  ],
);

export const admissionGlobalCapacity = pgTable(
  "admission_global_capacity",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    reservedCount: integer("reserved_count").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => [
    check("admission_global_capacity_singleton_check", sql`${table.singleton}`),
    check("admission_global_capacity_reserved_count_check", sql`${table.reservedCount} >= 0`),
    check("admission_global_capacity_revision_check", sql`${table.revision} >= 0`),
  ],
);

export const admissionPrincipalSetGeneration = pgTable(
  "admission_principal_set_generation",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    generation: bigint("generation", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => [
    check("admission_principal_set_generation_singleton_check", sql`${table.singleton}`),
    check("admission_principal_set_generation_generation_check", sql`${table.generation} >= 0`),
  ],
);

export const admissionPrincipalCapacity = pgTable(
  "admission_principal_capacity",
  {
    principalId: uuid("principal_id")
      .primaryKey()
      .references(() => principals.principalId),
    reservedCount: integer("reserved_count").notNull(),
  },
  (table) => [
    check("admission_principal_capacity_reserved_count_check", sql`${table.reservedCount} >= 0`),
    index("admission_principal_capacity_nonzero_idx")
      .on(table.principalId)
      .where(sql`${table.reservedCount} <> 0`),
  ],
);

export const userMessages = pgTable(
  "user_messages",
  {
    userMessageId: uuid("user_message_id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.threadId),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.principalId),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    unique("user_messages_message_thread_principal_unique").on(
      table.userMessageId,
      table.threadId,
      table.principalId,
    ),
    foreignKey({
      columns: [table.threadId, table.principalId],
      foreignColumns: [threads.threadId, threads.principalId],
    }),
    check("user_messages_content_check", sql`length(${table.content}) BETWEEN 1 AND 16384`),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    agentRunId: uuid("agent_run_id").primaryKey(),
    threadId: uuid("thread_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    userMessageId: uuid("user_message_id").notNull().unique(),
    state: text("state").notNull(),
    claimEpoch: bigint("claim_epoch", { mode: "bigint" }).notNull().default(0n),
    claimOwner: text("claim_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    executionProfileRef: text("execution_profile_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    unique("agent_runs_run_principal_unique").on(table.agentRunId, table.principalId),
    unique("agent_runs_run_thread_principal_unique").on(
      table.agentRunId,
      table.threadId,
      table.principalId,
    ),
    foreignKey({
      columns: [table.threadId, table.principalId],
      foreignColumns: [threads.threadId, threads.principalId],
    }),
    foreignKey({
      columns: [table.userMessageId, table.threadId, table.principalId],
      foreignColumns: [userMessages.userMessageId, userMessages.threadId, userMessages.principalId],
    }),
    check(
      "agent_runs_state_check",
      sql`${table.state} IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'canceled')`,
    ),
    check(
      "agent_runs_execution_profile_ref_check",
      sql`length(${table.executionProfileRef}) BETWEEN 1 AND 255`,
    ),
    check("agent_runs_claim_epoch_check", sql`${table.claimEpoch} >= 0`),
    check(
      "agent_runs_claim_check",
      sql`((
        (${table.state} = 'running'
          AND ${table.claimEpoch} > 0
          AND ${table.claimOwner} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.state} <> 'running'
          AND ${table.claimOwner} IS NULL
          AND ${table.leaseExpiresAt} IS NULL)
      )) IS TRUE`,
    ),
    index("agent_runs_expired_claim_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'running'`),
    index("agent_runs_principal_state_idx").on(table.principalId, table.state, table.agentRunId),
    index("agent_runs_nonterminal_capacity_idx")
      .on(table.principalId, table.agentRunId)
      .where(sql`${table.state} NOT IN ('succeeded', 'failed', 'canceled')`),
  ],
);

export const threadEvents = pgTable(
  "thread_events",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.threadId),
    position: bigint("position", { mode: "bigint" }).notNull(),
    eventId: uuid("event_id").notNull().unique(),
    principalId: uuid("principal_id").notNull(),
    userMessageId: uuid("user_message_id").notNull(),
    agentRunId: uuid("agent_run_id").notNull(),
    eventType: text("event_type").notNull(),
    eventVersion: smallint("event_version").notNull(),
    payload: jsonb("payload").$type<ThreadEvent["payload"]>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.position] }),
    unique("thread_events_authority_unique").on(
      table.threadId,
      table.position,
      table.userMessageId,
      table.agentRunId,
    ),
    foreignKey({
      columns: [table.threadId, table.principalId],
      foreignColumns: [threads.threadId, threads.principalId],
    }),
    foreignKey({
      columns: [table.userMessageId, table.threadId, table.principalId],
      foreignColumns: [userMessages.userMessageId, userMessages.threadId, userMessages.principalId],
    }),
    foreignKey({
      columns: [table.agentRunId, table.threadId, table.principalId],
      foreignColumns: [agentRuns.agentRunId, agentRuns.threadId, agentRuns.principalId],
    }),
    check("thread_events_position_check", sql`${table.position} > 0`),
    check(
      "thread_events_event_type_check",
      sql`${table.eventType} IN (
        'UserMessageAppended',
        'AssistantOutputAppended',
        'AssistantOutputCompleted',
        'AssistantOutputInterrupted',
        'AgentRunSucceeded',
        'AgentRunFailed'
      )`,
    ),
    check("thread_events_event_version_check", sql`${table.eventVersion} = 1`),
    check("thread_events_payload_object_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "thread_events_payload_run_check",
      sql`(${table.payload} ->> 'agentRunId')::uuid = ${table.agentRunId}`,
    ),
    check(
      "thread_events_payload_shape_check",
      sql`CASE ${table.eventType}
        WHEN 'UserMessageAppended' THEN
          ${table.payload} = jsonb_build_object(
            'userMessageId', ${table.payload} ->> 'userMessageId',
            'agentRunId', ${table.payload} ->> 'agentRunId',
            'content', ${table.payload} -> 'content'
          )
          AND (${table.payload} ->> 'userMessageId')::uuid = ${table.userMessageId}
        WHEN 'AssistantOutputAppended' THEN
          ${table.payload} = jsonb_build_object(
            'assistantOutputId', ${table.payload} ->> 'assistantOutputId',
            'agentRunId', ${table.payload} ->> 'agentRunId',
            'content', ${table.payload} -> 'content'
          )
        WHEN 'AssistantOutputCompleted' THEN
          ${table.payload} = jsonb_build_object(
            'assistantOutputId', ${table.payload} ->> 'assistantOutputId',
            'agentRunId', ${table.payload} ->> 'agentRunId'
          )
        WHEN 'AssistantOutputInterrupted' THEN
          ${table.payload} = jsonb_build_object(
            'assistantOutputId', ${table.payload} ->> 'assistantOutputId',
            'agentRunId', ${table.payload} ->> 'agentRunId',
            'cause', 'modelCallFailed'
          )
        WHEN 'AgentRunSucceeded' THEN
          ${table.payload} = jsonb_build_object('agentRunId', ${table.payload} ->> 'agentRunId')
        WHEN 'AgentRunFailed' THEN
          ${table.payload} = jsonb_build_object(
            'agentRunId', ${table.payload} ->> 'agentRunId',
            'cause', 'modelCallFailed'
          )
        ELSE false
      END`,
    ),
    check(
      "thread_events_payload_content_check",
      sql`${table.eventType} NOT IN ('UserMessageAppended', 'AssistantOutputAppended')
        OR (
          jsonb_typeof(${table.payload} -> 'content') = 'array'
          AND jsonb_array_length(${table.payload} -> 'content') = 1
          AND (${table.payload} -> 'content' -> 0) = jsonb_build_object(
            'type', 'text',
            'text', ${table.payload} -> 'content' -> 0 ->> 'text'
          )
          AND length(${table.payload} -> 'content' -> 0 ->> 'text') BETWEEN 1 AND 16384
        )`,
    ),
  ],
);

export const agentRunCapacityReservations = pgTable(
  "agent_run_capacity_reservations",
  {
    agentRunId: uuid("agent_run_id").primaryKey(),
    principalId: uuid("principal_id").notNull(),
    state: text("state").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true, mode: "string" }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    foreignKey({
      columns: [table.agentRunId, table.principalId],
      foreignColumns: [agentRuns.agentRunId, agentRuns.principalId],
    }),
    check(
      "agent_run_capacity_reservations_state_check",
      sql`${table.state} IN ('held', 'released')`,
    ),
    check(
      "agent_run_capacity_reservations_release_check",
      sql`((
        (${table.state} = 'held' AND ${table.releasedAt} IS NULL)
        OR (${table.state} = 'released' AND ${table.releasedAt} IS NOT NULL)
      )) IS TRUE`,
    ),
    index("agent_run_capacity_reservations_state_idx").on(
      table.state,
      table.principalId,
      table.agentRunId,
    ),
  ],
);

export const outboxObligations = pgTable(
  "outbox_obligations",
  {
    outboxId: uuid("outbox_id").primaryKey(),
    agentRunId: uuid("agent_run_id").notNull().unique(),
    threadId: uuid("thread_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    predecessorOutboxId: uuid("predecessor_outbox_id"),
    kind: text("kind").notNull(),
    version: smallint("version").notNull(),
    publicationEvidence: jsonb("publication_evidence").$type<PublicationEvidence>(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.agentRunId, table.threadId, table.principalId],
      foreignColumns: [agentRuns.agentRunId, agentRuns.threadId, agentRuns.principalId],
    }),
    foreignKey({
      columns: [table.predecessorOutboxId],
      foreignColumns: [table.outboxId],
    }),
    check("outbox_obligations_kind_check", sql`${table.kind} = 'AgentRunPending'`),
    check("outbox_obligations_version_check", sql`${table.version} = 1`),
    check(
      "outbox_obligations_publication_check",
      sql`((
        (${table.publicationEvidence} IS NULL AND ${table.publishedAt} IS NULL)
        OR (${table.publicationEvidence} IS NOT NULL AND ${table.publishedAt} IS NOT NULL)
      )) IS TRUE`,
    ),
    check(
      "outbox_obligations_publication_evidence_check",
      sql`((
        ${table.publicationEvidence} IS NULL
        OR ${table.publicationEvidence} = CASE ${table.publicationEvidence} ->> 'type'
            WHEN 'pubsub' THEN jsonb_build_object(
              'type', 'pubsub',
              'providerMessageId', ${table.publicationEvidence} ->> 'providerMessageId'
            )
            WHEN 'legacyUnavailable' THEN jsonb_build_object('type', 'legacyUnavailable')
            ELSE NULL
          END
      )) IS TRUE`,
    ),
    index("outbox_obligations_created_idx").on(table.createdAt, table.outboxId),
    index("outbox_obligations_unpublished_idx")
      .on(table.createdAt, table.outboxId)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);

export const relayPublicationTasks = pgTable(
  "relay_publication_tasks",
  {
    outboxId: uuid("outbox_id")
      .primaryKey()
      .references(() => outboxObligations.outboxId),
    publicationState: text("publication_state").notNull().default("pending"),
    publicationEpoch: bigint("publication_epoch", { mode: "bigint" }).notNull().default(0n),
    publicationOwner: text("publication_owner"),
    publicationLeaseExpiresAt: timestamp("publication_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    check(
      "relay_publication_tasks_state_check",
      sql`${table.publicationState} IN ('pending', 'publishing')`,
    ),
    check("relay_publication_tasks_epoch_check", sql`${table.publicationEpoch} >= 0`),
    check(
      "relay_publication_tasks_claim_check",
      sql`((
        (${table.publicationState} = 'pending'
          AND ${table.publicationOwner} IS NULL
          AND ${table.publicationLeaseExpiresAt} IS NULL)
        OR (${table.publicationState} = 'publishing'
          AND ${table.publicationEpoch} > 0
          AND ${table.publicationOwner} IS NOT NULL
          AND ${table.publicationLeaseExpiresAt} IS NOT NULL)
      )) IS TRUE`,
    ),
    index("relay_publication_tasks_claim_idx").on(
      table.publicationState,
      table.publicationLeaseExpiresAt,
      table.createdAt,
      table.outboxId,
    ),
  ],
);

export const relayPublicationAttempts = pgTable(
  "relay_publication_attempts",
  {
    outboxId: uuid("outbox_id")
      .notNull()
      .references(() => outboxObligations.outboxId),
    publicationEpoch: bigint("publication_epoch", { mode: "bigint" }).notNull(),
    publicationOwner: text("publication_owner").notNull(),
    state: text("state").notNull(),
    providerMessageId: text("provider_message_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    primaryKey({ columns: [table.outboxId, table.publicationEpoch] }),
    check("relay_publication_attempts_epoch_check", sql`${table.publicationEpoch} > 0`),
    check(
      "relay_publication_attempts_owner_check",
      sql`length(${table.publicationOwner}) BETWEEN 1 AND 255`,
    ),
    check(
      "relay_publication_attempts_state_check",
      sql`${table.state} IN ('started', 'expired', 'confirmed')`,
    ),
    check(
      "relay_publication_attempts_outcome_check",
      sql`((
        (${table.state} = 'started'
          AND ${table.providerMessageId} IS NULL
          AND ${table.finishedAt} IS NULL)
        OR (${table.state} = 'expired'
          AND ${table.providerMessageId} IS NULL
          AND ${table.finishedAt} IS NOT NULL)
        OR (${table.state} = 'confirmed'
          AND length(${table.providerMessageId}) BETWEEN 1 AND 255
          AND ${table.finishedAt} IS NOT NULL)
      )) IS TRUE`,
    ),
  ],
);

export const assistantOutputs = pgTable(
  "assistant_outputs",
  {
    assistantOutputId: uuid("assistant_output_id").primaryKey(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.agentRunId),
    state: text("state").notNull(),
    interruptionCause: text("interruption_cause"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    unique("assistant_outputs_output_run_unique").on(table.assistantOutputId, table.agentRunId),
    check(
      "assistant_outputs_state_check",
      sql`${table.state} IN ('open', 'completed', 'interrupted')`,
    ),
    check(
      "assistant_outputs_terminal_check",
      sql`((
        (${table.state} = 'open'
          AND ${table.interruptionCause} IS NULL
          AND ${table.terminatedAt} IS NULL)
        OR (${table.state} = 'completed'
          AND ${table.interruptionCause} IS NULL
          AND ${table.terminatedAt} IS NOT NULL)
        OR (${table.state} = 'interrupted'
          AND ${table.interruptionCause} = 'modelCallFailed'
          AND ${table.terminatedAt} IS NOT NULL)
      )) IS TRUE`,
    ),
  ],
);

export const modelCalls = pgTable(
  "model_calls",
  {
    modelCallId: uuid("model_call_id").primaryKey(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .unique()
      .references(() => agentRuns.agentRunId),
    modelBinding: text("model_binding").notNull(),
    prompt: text("prompt").notNull(),
    state: text("state").notNull(),
    failureCause: text("failure_cause"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    unique("model_calls_call_run_unique").on(table.modelCallId, table.agentRunId),
    check("model_calls_binding_check", sql`length(${table.modelBinding}) BETWEEN 1 AND 255`),
    check("model_calls_prompt_check", sql`length(${table.prompt}) BETWEEN 1 AND 16384`),
    check("model_calls_state_check", sql`${table.state} IN ('pending', 'succeeded', 'failed')`),
    check(
      "model_calls_outcome_check",
      sql`((
        (${table.state} = 'pending'
          AND ${table.failureCause} IS NULL
          AND ${table.completedAt} IS NULL)
        OR (${table.state} = 'succeeded'
          AND ${table.failureCause} IS NULL
          AND ${table.completedAt} IS NOT NULL)
        OR (${table.state} = 'failed'
          AND ${table.failureCause} = 'modelCallFailed'
          AND ${table.completedAt} IS NOT NULL)
      )) IS TRUE`,
    ),
  ],
);

export const modelCallAttempts = pgTable(
  "model_call_attempts",
  {
    modelCallAttemptId: uuid("model_call_attempt_id").primaryKey(),
    modelCallId: uuid("model_call_id").notNull(),
    agentRunId: uuid("agent_run_id").notNull(),
    assistantOutputId: uuid("assistant_output_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    claimEpoch: bigint("claim_epoch", { mode: "bigint" }).notNull(),
    state: text("state").notNull(),
    usageType: text("usage_type").notNull().default("unknown"),
    inputUnits: integer("input_units"),
    outputUnits: integer("output_units"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    foreignKey({
      columns: [table.modelCallId, table.agentRunId],
      foreignColumns: [modelCalls.modelCallId, modelCalls.agentRunId],
    }),
    foreignKey({
      columns: [table.assistantOutputId, table.agentRunId],
      foreignColumns: [assistantOutputs.assistantOutputId, assistantOutputs.agentRunId],
    }),
    unique("model_call_attempts_attempt_authority_unique").on(
      table.modelCallAttemptId,
      table.modelCallId,
      table.assistantOutputId,
      table.agentRunId,
    ),
    unique("model_call_attempts_call_number_unique").on(table.modelCallId, table.attemptNumber),
    check("model_call_attempts_number_check", sql`${table.attemptNumber} > 0`),
    check("model_call_attempts_epoch_check", sql`${table.claimEpoch} > 0`),
    check(
      "model_call_attempts_state_check",
      sql`${table.state} IN ('started', 'succeeded', 'failed')`,
    ),
    check(
      "model_call_attempts_usage_check",
      sql`((
        (${table.usageType} = 'unknown'
          AND ${table.inputUnits} IS NULL
          AND ${table.outputUnits} IS NULL)
        OR (${table.usageType} IN ('reported', 'estimated')
          AND ${table.inputUnits} >= 0
          AND ${table.outputUnits} >= 0)
      )) IS TRUE`,
    ),
    check(
      "model_call_attempts_finished_check",
      sql`((
        (${table.state} = 'started' AND ${table.finishedAt} IS NULL)
        OR (${table.state} <> 'started' AND ${table.finishedAt} IS NOT NULL)
      )) IS TRUE`,
    ),
  ],
);

export const modelCallFragments = pgTable(
  "model_call_fragments",
  {
    modelCallId: uuid("model_call_id").notNull(),
    fragmentIndex: integer("fragment_index").notNull(),
    modelCallAttemptId: uuid("model_call_attempt_id").notNull(),
    assistantOutputId: uuid("assistant_output_id").notNull(),
    agentRunId: uuid("agent_run_id").notNull(),
    text: text("text").notNull(),
    threadEventId: uuid("thread_event_id")
      .notNull()
      .unique()
      .references(() => threadEvents.eventId),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.modelCallAttemptId, table.fragmentIndex] }),
    foreignKey({
      columns: [
        table.modelCallAttemptId,
        table.modelCallId,
        table.assistantOutputId,
        table.agentRunId,
      ],
      foreignColumns: [
        modelCallAttempts.modelCallAttemptId,
        modelCallAttempts.modelCallId,
        modelCallAttempts.assistantOutputId,
        modelCallAttempts.agentRunId,
      ],
    }),
    check("model_call_fragments_index_check", sql`${table.fragmentIndex} >= 0`),
    check("model_call_fragments_text_check", sql`length(${table.text}) BETWEEN 1 AND 16384`),
  ],
);

export const acceptanceReceipts = pgTable(
  "acceptance_receipts",
  {
    receiptId: uuid("receipt_id").primaryKey(),
    protocolVersion: smallint("protocol_version").notNull(),
    principalId: uuid("principal_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    userMessageId: uuid("user_message_id").notNull().unique(),
    agentRunId: uuid("agent_run_id").notNull().unique(),
    threadPosition: bigint("thread_position", { mode: "bigint" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    unique("acceptance_receipts_principal_idempotency_unique").on(
      table.principalId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.threadId, table.principalId],
      foreignColumns: [threads.threadId, threads.principalId],
    }),
    foreignKey({
      columns: [table.userMessageId, table.threadId, table.principalId],
      foreignColumns: [userMessages.userMessageId, userMessages.threadId, userMessages.principalId],
    }),
    foreignKey({
      columns: [table.agentRunId, table.threadId, table.principalId],
      foreignColumns: [agentRuns.agentRunId, agentRuns.threadId, agentRuns.principalId],
    }),
    foreignKey({
      columns: [table.threadId, table.threadPosition, table.userMessageId, table.agentRunId],
      foreignColumns: [
        threadEvents.threadId,
        threadEvents.position,
        threadEvents.userMessageId,
        threadEvents.agentRunId,
      ],
    }),
    check("acceptance_receipts_protocol_version_check", sql`${table.protocolVersion} = 1`),
    check(
      "acceptance_receipts_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check("acceptance_receipts_thread_position_check", sql`${table.threadPosition} > 0`),
    index("acceptance_receipts_thread_position_idx").on(table.threadId, table.threadPosition),
  ],
);

export const admissionRejections = pgTable(
  "admission_rejections",
  {
    principalId: uuid("principal_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    threadId: uuid("thread_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.threadId, table.principalId],
      foreignColumns: [threads.threadId, threads.principalId],
    }),
    check(
      "admission_rejections_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const databaseSchema = {
  acceptanceReceipts,
  admissionRejections,
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  admissionPrincipalSetGeneration,
  agentRunCapacityReservations,
  agentRuns,
  assistantOutputs,
  authenticationSessions,
  modelCallAttempts,
  modelCallFragments,
  modelCalls,
  outboxObligations,
  principals,
  relayPrincipals,
  relayDispatchCapacity,
  relayPublicationAttempts,
  relayPublicationTasks,
  relayThreads,
  threadEvents,
  threads,
  userMessages,
};

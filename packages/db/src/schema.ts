import { sql } from "drizzle-orm";
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

export const admissionGlobalCapacity = pgTable(
  "admission_global_capacity",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    reservedCount: integer("reserved_count").notNull(),
  },
  (table) => [
    check("admission_global_capacity_singleton_check", sql`${table.singleton}`),
    check("admission_global_capacity_reserved_count_check", sql`${table.reservedCount} >= 0`),
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
    payload: jsonb("payload")
      .$type<{
        readonly userMessageId: string;
        readonly agentRunId: string;
        readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
      }>()
      .notNull(),
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
    check("thread_events_event_type_check", sql`${table.eventType} = 'UserMessageAppended'`),
    check("thread_events_event_version_check", sql`${table.eventVersion} = 1`),
    check("thread_events_payload_object_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "thread_events_payload_shape_check",
      sql`${table.payload} = jsonb_build_object(
        'userMessageId', ${table.payload} ->> 'userMessageId',
        'agentRunId', ${table.payload} ->> 'agentRunId',
        'content', ${table.payload} -> 'content'
      )`,
    ),
    check(
      "thread_events_payload_message_check",
      sql`(${table.payload} ->> 'userMessageId')::uuid = ${table.userMessageId}`,
    ),
    check(
      "thread_events_payload_run_check",
      sql`(${table.payload} ->> 'agentRunId')::uuid = ${table.agentRunId}`,
    ),
    check(
      "thread_events_payload_content_check",
      sql`jsonb_typeof(${table.payload} -> 'content') = 'array'
        AND jsonb_array_length(${table.payload} -> 'content') = 1
        AND (${table.payload} -> 'content' -> 0) = jsonb_build_object(
          'type', 'text',
          'text', ${table.payload} -> 'content' -> 0 ->> 'text'
        )
        AND length(${table.payload} -> 'content' -> 0 ->> 'text') BETWEEN 1 AND 16384`,
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
      sql`(
        (${table.state} = 'held' AND ${table.releasedAt} IS NULL)
        OR (${table.state} = 'released' AND ${table.releasedAt} IS NOT NULL)
      )`,
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
    kind: text("kind").notNull(),
    version: smallint("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.agentRunId, table.threadId, table.principalId],
      foreignColumns: [agentRuns.agentRunId, agentRuns.threadId, agentRuns.principalId],
    }),
    check("outbox_obligations_kind_check", sql`${table.kind} = 'AgentRunPending'`),
    check("outbox_obligations_version_check", sql`${table.version} = 1`),
    index("outbox_obligations_created_idx").on(table.createdAt, table.outboxId),
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
  ],
);

export const databaseSchema = {
  acceptanceReceipts,
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  agentRunCapacityReservations,
  agentRuns,
  authenticationSessions,
  outboxObligations,
  principals,
  threadEvents,
  threads,
  userMessages,
};

import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type {
  AgentId,
  AllowancePeriodId,
  DenialFactId,
  DenialKind,
  DeniedResourceId,
  DirectoryCommandId,
  DirectoryRequestDigest,
  DirectoryTimestamp,
  KnowledgeSpaceId,
  Plan,
  PlanPolicyVersion,
  SubscriptionId,
  ThreadId,
  UserId,
} from "./directory-model";

/** Idempotency records for atomic directory commands. */
export const directoryCommands = sqliteTable("directory_commands", {
  commandId: text("command_id").$type<DirectoryCommandId>().notNull().primaryKey(),
  completedAt: text("completed_at").$type<DirectoryTimestamp>().notNull(),
  operation: text("operation", {
    enum: ["create_identity", "record_denial_fact"],
  }).notNull(),
  requestDigest: text("request_digest").$type<DirectoryRequestDigest>().notNull(),
});

/** Content-free stable User identities. */
export const users = sqliteTable("users", {
  createdAt: text("created_at").$type<DirectoryTimestamp>().notNull(),
  userId: text("user_id").$type<UserId>().notNull().primaryKey(),
});

/** Stable routing from one User to one Agent, Thread, and Knowledge Space. */
export const agentDirectory = sqliteTable(
  "agent_directory",
  {
    agentId: text("agent_id").$type<AgentId>().notNull(),
    createdAt: text("created_at").$type<DirectoryTimestamp>().notNull(),
    knowledgeSpaceId: text("knowledge_space_id").$type<KnowledgeSpaceId>().notNull(),
    threadId: text("thread_id").$type<ThreadId>().notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .primaryKey()
      .references(() => users.userId, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("agent_directory_agent_id_unique").on(table.agentId),
    uniqueIndex("agent_directory_thread_id_unique").on(table.threadId),
    uniqueIndex("agent_directory_knowledge_space_id_unique").on(table.knowledgeSpaceId),
  ],
);

/** Current commercial facts without payment-provider data. */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    createdAt: text("created_at").$type<DirectoryTimestamp>().notNull(),
    plan: text("plan", { enum: ["free", "adventurer"] })
      .$type<Plan>()
      .notNull(),
    planPolicyVersion: text("plan_policy_version").$type<PlanPolicyVersion>().notNull(),
    subscriptionId: text("subscription_id").$type<SubscriptionId>().notNull().primaryKey(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("subscriptions_user_id_unique").on(table.userId)],
);

/** Stable identities and bounds for Plan-scoped Usage Allowance periods. */
export const allowancePeriods = sqliteTable(
  "allowance_periods",
  {
    allowancePeriodId: text("allowance_period_id")
      .$type<AllowancePeriodId>()
      .notNull()
      .primaryKey(),
    endsAt: text("ends_at").$type<DirectoryTimestamp>().notNull(),
    plan: text("plan", { enum: ["free", "adventurer"] })
      .$type<Plan>()
      .notNull(),
    planPolicyVersion: text("plan_policy_version").$type<PlanPolicyVersion>().notNull(),
    startsAt: text("starts_at").$type<DirectoryTimestamp>().notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("allowance_periods_user_start_unique").on(table.userId, table.startsAt),
    index("allowance_periods_user_end_index").on(table.userId, table.endsAt),
  ],
);

/** Content-free facts that explain security-sensitive directory changes. */
export const securityAuditFacts = sqliteTable("security_audit_facts", {
  action: text("action", { enum: ["denial_recorded", "identity_created"] }).notNull(),
  commandId: text("command_id").$type<DirectoryCommandId>().notNull().primaryKey(),
  occurredAt: text("occurred_at").$type<DirectoryTimestamp>().notNull(),
  outcome: text("outcome", { enum: ["applied"] }).notNull(),
  userId: text("user_id")
    .$type<UserId>()
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
});

/** Current named denial facts used by deterministic authorization. */
export const denialFacts = sqliteTable(
  "denial_facts",
  {
    denialFactId: text("denial_fact_id").$type<DenialFactId>().notNull().primaryKey(),
    kind: text("kind", {
      enum: [
        "auth_session_revocation",
        "channel_binding_revocation",
        "deletion_request",
        "user_suspension",
      ],
    })
      .$type<DenialKind>()
      .notNull(),
    occurredAt: text("occurred_at").$type<DirectoryTimestamp>().notNull(),
    resourceId: text("resource_id").$type<DeniedResourceId>().notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
  },
  (table) => [index("denial_facts_user_occurred_index").on(table.userId, table.occurredAt)],
);

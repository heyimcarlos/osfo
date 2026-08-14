import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type {
  AgentId,
  AllowancePeriodId,
  Plan,
  PlanPolicyVersion,
  RegistrationId,
  SubscriptionId,
  UserId,
} from "../domain";
import type { DbTimestamp } from "./index";

/** Content-free stable User identities. */
export const users = sqliteTable(
  "users",
  {
    createdAt: text("created_at").$type<DbTimestamp>().notNull(),
    registrationId: text("registration_id").$type<RegistrationId>().notNull(),
    userId: text("user_id").$type<UserId>().notNull().primaryKey(),
  },
  (table) => [uniqueIndex("users_registration_id_unique").on(table.registrationId)],
);

/** Stable routing from one User to one User-scoped Agent. */
export const agents = sqliteTable(
  "agents",
  {
    agentId: text("agent_id").$type<AgentId>().notNull(),
    createdAt: text("created_at").$type<DbTimestamp>().notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .primaryKey()
      .references(() => users.userId, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("agents_agent_id_unique").on(table.agentId)],
);

/** Current commercial facts without payment-provider data. */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    createdAt: text("created_at").$type<DbTimestamp>().notNull(),
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
    endsAt: text("ends_at").$type<DbTimestamp>().notNull(),
    plan: text("plan", { enum: ["free", "adventurer"] })
      .$type<Plan>()
      .notNull(),
    planPolicyVersion: text("plan_policy_version").$type<PlanPolicyVersion>().notNull(),
    startsAt: text("starts_at").$type<DbTimestamp>().notNull(),
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

/** Content-free facts that explain security-sensitive database changes. */
export const securityAuditFacts = sqliteTable("security_audit_facts", {
  action: text("action", { enum: ["registration_established"] }).notNull(),
  occurredAt: text("occurred_at").$type<DbTimestamp>().notNull(),
  operationId: text("operation_id").$type<RegistrationId>().notNull().primaryKey(),
  outcome: text("outcome", { enum: ["applied"] }).notNull(),
  userId: text("user_id")
    .$type<UserId>()
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
});

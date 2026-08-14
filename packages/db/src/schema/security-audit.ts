import { pgTable, text } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Content-free facts that explain security-sensitive database changes. */
export const securityAuditFacts = pgTable("security_audit_facts", {
  action: text("action", { enum: ["registration_established"] }).notNull(),
  occurredAt: text("occurred_at").notNull(),
  operationId: text("operation_id").notNull().primaryKey(),
  outcome: text("outcome", { enum: ["applied"] }).notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

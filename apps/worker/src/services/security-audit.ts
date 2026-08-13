import type { Database, DbCommandId, DbTimestamp } from "../db";
import { securityAuditFacts } from "../db/schema";
import type { UserId } from "../domain";

interface SecurityAuditInput {
  readonly commandId: DbCommandId;
  readonly occurredAt: DbTimestamp;
  readonly userId: UserId;
}

/** Build the Security Audit Fact that joins one atomic registration batch. */
export const registrationEstablished = (database: Database, input: SecurityAuditInput) =>
  database.insert(securityAuditFacts).values({
    action: "registration_established",
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    outcome: "applied",
    userId: input.userId,
  });

/** Build the Security Audit Fact that joins one atomic denial batch. */
export const denialRecorded = (database: Database, input: SecurityAuditInput) =>
  database.insert(securityAuditFacts).values({
    action: "denial_recorded",
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    outcome: "applied",
    userId: input.userId,
  });

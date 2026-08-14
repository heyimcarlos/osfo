import type { Database, DbTimestamp } from "../db";
import { securityAuditFacts } from "../db/schema";
import type { RegistrationId, UserId } from "../domain";

interface SecurityAuditInput {
  readonly occurredAt: DbTimestamp;
  readonly registrationId: RegistrationId;
  readonly userId: UserId;
}

/** Build the Security Audit Fact that joins one atomic registration batch. */
export const registrationEstablished = (database: Database, input: SecurityAuditInput) =>
  database.insert(securityAuditFacts).values({
    action: "registration_established",
    occurredAt: input.occurredAt,
    operationId: input.registrationId,
    outcome: "applied",
    userId: input.userId,
  });

import { allowanceUsage } from "@osfo/db/schema/allowances";
import { and, eq, or } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { AcceptanceReceiptId, AllowancePeriodId } from "../../domain";
import { AllowanceKind } from "../../domain/allowance";
import type { PostgresProductEvidence } from "../../qualification/semantic-evidence";
import type { BillingDatabase } from "./database";
import { runBillingTransaction } from "./transaction";

const QualificationAllowanceRow = Schema.Struct({
  allowanceKind: AllowanceKind,
  allowancePeriodId: AllowancePeriodId,
  recordedAt: Schema.Date,
  sourceId: AcceptanceReceiptId,
  sourceType: Schema.Literal("acceptanceReceipt"),
});

/** Read accepted-message semantic evidence from its committed PostgreSQL product rows. */
export const readQualificationAcceptanceEvidence = (
  database: BillingDatabase,
  identities: ReadonlyArray<{
    readonly acceptanceReceiptId: AcceptanceReceiptId;
    readonly allowancePeriodId: AllowancePeriodId;
  }>,
) => {
  if (identities.length === 0) return Effect.succeed([]);
  return runBillingTransaction("readQualificationAcceptanceEvidence", () =>
    // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
    database.transaction(async (transaction) => {
      const batchSize = 250;
      const batches = Array.from({ length: Math.ceil(identities.length / batchSize) }, (_, index) =>
        identities.slice(index * batchSize, (index + 1) * batchSize),
      );
      const rows: Array<unknown> = [];
      for (const batch of batches) {
        const predicates = batch.map((identity) =>
          and(
            eq(allowanceUsage.allowancePeriodId, identity.allowancePeriodId),
            eq(allowanceUsage.allowanceKind, "acceptedMessages"),
            eq(allowanceUsage.sourceType, "acceptanceReceipt"),
            eq(allowanceUsage.sourceId, identity.acceptanceReceiptId),
          ),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- The production seam deliberately bounds one indexed transaction to one 250-identity query at a time.
        const batchRows = await transaction
          .select({
            allowanceKind: allowanceUsage.allowanceKind,
            allowancePeriodId: allowanceUsage.allowancePeriodId,
            recordedAt: allowanceUsage.recordedAt,
            sourceId: allowanceUsage.sourceId,
            sourceType: allowanceUsage.sourceType,
          })
          .from(allowanceUsage)
          .where(or(...predicates));
        rows.push(...batchRows);
      }
      return rows.map((unknownRow): PostgresProductEvidence => {
        const row = Schema.decodeUnknownSync(QualificationAllowanceRow)(unknownRow);
        const allowanceConsumptionId = `${row.allowancePeriodId}:${row.allowanceKind}:${row.sourceType}:${row.sourceId}`;
        return {
          acceptanceReceiptId: row.sourceId,
          allowanceConsumptionId,
          authority: "allowance_usage",
          evidenceId: `postgres:${allowanceConsumptionId}`,
          occurredAt: row.recordedAt.toISOString(),
          productFactId: allowanceConsumptionId,
          store: "PostgreSQL",
        };
      });
    }),
  );
};

import { allowanceUsage, allowanceZeroUsageEvidence } from "@osfo/db/schema/allowances";
import { and, eq, or } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { AllowancePeriodId } from "../../domain";
import { AllowanceKind } from "../../domain/allowance";
import type { PostgresProductEvidence } from "../../qualification/semantic-evidence";
import type { BillingTransactionRetryExhausted, DatabaseUnavailable } from "../../domain/allowance";
import type { BillingDatabase } from "./database";
import { runBillingTransaction } from "./transaction";

const QualificationAllowanceRow = Schema.Struct({
  allowanceKind: AllowanceKind,
  allowancePeriodId: AllowancePeriodId,
  recordedAt: Schema.Date,
  sourceId: Schema.String,
  sourceType: Schema.Literal("acceptanceReceipt"),
});

/** Read accepted-message semantic evidence from committed PostgreSQL Allowance rows. */
export const readQualificationAcceptanceEvidence = (
  database: BillingDatabase,
  identities: ReadonlyArray<{
    readonly acceptanceReceiptId: string;
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
            eq(allowanceUsage.allowance_period_id, identity.allowancePeriodId),
            eq(allowanceUsage.allowance_kind, "acceptedMessages"),
            eq(allowanceUsage.source_type, "acceptanceReceipt"),
            eq(allowanceUsage.source_id, identity.acceptanceReceiptId),
          ),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each query deliberately bounds one indexed transaction to 250 identities.
        const batchRows = await transaction
          .select({
            allowanceKind: allowanceUsage.allowance_kind,
            allowancePeriodId: allowanceUsage.allowance_period_id,
            recordedAt: allowanceUsage.recorded_at,
            sourceId: allowanceUsage.source_id,
            sourceType: allowanceUsage.source_type,
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

export interface QualificationBillingRoot {
  readonly acceptanceReceiptId: string;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly modelCalls: ReadonlyArray<{
    readonly attemptId: string;
    readonly costReconciliationId: string;
    readonly items: ReadonlyArray<{
      readonly allowanceKind: AllowanceKind;
      readonly basis: "conservative" | "known_at_start" | "observed";
      readonly quantity: bigint;
    }>;
    readonly priceBookId: string;
  }>;
  readonly rootId: string;
  readonly userId: string;
}

export interface QualificationBillingRecord {
  readonly allowanceKind?: AllowanceKind;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly basis: "conservative" | "known_at_start" | "observed" | "provenNoUse";
  readonly costReconciliationId?: string;
  readonly occurredAt: string;
  readonly priceBookId?: string;
  readonly quantity: bigint;
  readonly rootId: string;
  readonly sourceId: string;
  readonly sourceType: "ModelCallAttempt" | "acceptanceReceipt";
  readonly userId: string;
}

export type QualificationBillingAuthority =
  | { readonly _tag: "Conflict" | "Missing"; readonly rootId: string }
  | {
      readonly _tag: "Ready";
      readonly localEvidence: ReadonlyArray<PostgresProductEvidence>;
      readonly records: ReadonlyArray<QualificationBillingRecord>;
    };

/** Exact retained billing facts for one bounded root page, including proven zero model use. */
export const readQualificationBillingAuthority = (
  database: BillingDatabase,
  roots: ReadonlyArray<QualificationBillingRoot>,
): Effect.Effect<
  QualificationBillingAuthority,
  BillingTransactionRetryExhausted | DatabaseUnavailable
> => {
  if (roots.length === 0) {
    return Effect.succeed({ _tag: "Ready" as const, localEvidence: [], records: [] });
  }
  return runBillingTransaction("readQualificationBillingAuthority", () =>
    // oxlint-disable-next-line effecttsgo/async-function -- Drizzle owns this Promise transaction boundary.
    database.transaction(async (transaction) => {
      const sources = roots.flatMap((root) => [
        {
          allowancePeriodId: root.allowancePeriodId,
          sourceId: root.acceptanceReceiptId,
          sourceType: "acceptanceReceipt",
        },
        ...root.modelCalls.map((model) => ({
          allowancePeriodId: root.allowancePeriodId,
          sourceId: model.attemptId,
          sourceType: "ModelCallAttempt",
        })),
      ]);
      const batches = Array.from({ length: Math.ceil(sources.length / 250) }, (_, index) =>
        sources.slice(index * 250, (index + 1) * 250),
      );
      const usageRows: Array<{
        readonly allowanceKind: string;
        readonly allowancePeriodId: string;
        readonly basis: string;
        readonly quantity: bigint;
        readonly recordedAt: Date;
        readonly resourcePriceVersion: string | null;
        readonly sourceId: string;
        readonly sourceType: string;
        readonly userId: string;
      }> = [];
      const zeroRows: Array<{
        readonly allowancePeriodId: string;
        readonly recordedAt: Date;
        readonly resourcePriceVersion: string;
        readonly sourceId: string;
        readonly sourceType: string;
        readonly userId: string;
      }> = [];
      for (const batch of batches) {
        const predicate = or(
          ...batch.map((source) =>
            and(
              eq(allowanceUsage.allowance_period_id, source.allowancePeriodId),
              eq(allowanceUsage.source_type, source.sourceType),
              eq(allowanceUsage.source_id, source.sourceId),
            ),
          ),
        );
        const zeroPredicate = or(
          ...batch.map((source) =>
            and(
              eq(allowanceZeroUsageEvidence.allowance_period_id, source.allowancePeriodId),
              eq(allowanceZeroUsageEvidence.source_type, source.sourceType),
              eq(allowanceZeroUsageEvidence.source_id, source.sourceId),
            ),
          ),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each query deliberately bounds one indexed transaction to 250 identities.
        const batchUsageRows = await transaction
          .select({
            allowanceKind: allowanceUsage.allowance_kind,
            allowancePeriodId: allowanceUsage.allowance_period_id,
            basis: allowanceUsage.basis,
            quantity: allowanceUsage.quantity,
            recordedAt: allowanceUsage.recorded_at,
            resourcePriceVersion: allowanceUsage.resource_price_version,
            sourceId: allowanceUsage.source_id,
            sourceType: allowanceUsage.source_type,
            userId: allowanceUsage.user_id,
          })
          .from(allowanceUsage)
          .where(predicate);
        usageRows.push(...batchUsageRows);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each query deliberately bounds one indexed transaction to 250 identities.
        const batchZeroRows = await transaction
          .select({
            allowancePeriodId: allowanceZeroUsageEvidence.allowance_period_id,
            recordedAt: allowanceZeroUsageEvidence.recorded_at,
            resourcePriceVersion: allowanceZeroUsageEvidence.resource_price_version,
            sourceId: allowanceZeroUsageEvidence.source_id,
            sourceType: allowanceZeroUsageEvidence.source_type,
            userId: allowanceZeroUsageEvidence.user_id,
          })
          .from(allowanceZeroUsageEvidence)
          .where(zeroPredicate);
        zeroRows.push(...batchZeroRows);
      }
      const localEvidence: Array<PostgresProductEvidence> = [];
      const records: Array<QualificationBillingRecord> = [];
      for (const root of roots) {
        const acceptance = usageRows.filter(
          (row) =>
            row.allowancePeriodId === root.allowancePeriodId &&
            row.sourceType === "acceptanceReceipt" &&
            row.sourceId === root.acceptanceReceiptId,
        );
        if (acceptance.length === 0) {
          return { _tag: "Missing" as const, rootId: root.rootId };
        }
        if (
          acceptance.length !== 1 ||
          acceptance[0]?.allowanceKind !== "acceptedMessages" ||
          acceptance[0].basis !== "known_at_start" ||
          acceptance[0].quantity !== 1n ||
          acceptance[0].resourcePriceVersion !== null ||
          acceptance[0].userId !== root.userId
        ) {
          return { _tag: "Conflict" as const, rootId: root.rootId };
        }
        const allowanceConsumptionId = `${root.allowancePeriodId}:acceptedMessages:acceptanceReceipt:${root.acceptanceReceiptId}`;
        localEvidence.push({
          acceptanceReceiptId: root.acceptanceReceiptId,
          allowanceConsumptionId,
          authority: "allowance_usage",
          evidenceId: `postgres:${allowanceConsumptionId}`,
          occurredAt: acceptance[0].recordedAt.toISOString(),
          productFactId: allowanceConsumptionId,
          store: "PostgreSQL",
        });
        records.push({
          allowanceKind: "acceptedMessages",
          allowancePeriodId: root.allowancePeriodId,
          basis: "known_at_start",
          occurredAt: acceptance[0].recordedAt.toISOString(),
          quantity: 1n,
          rootId: root.rootId,
          sourceId: root.acceptanceReceiptId,
          sourceType: "acceptanceReceipt",
          userId: root.userId,
        });
        for (const model of root.modelCalls) {
          if (
            model.costReconciliationId !== `allowance:${model.attemptId}` ||
            model.priceBookId.length === 0
          ) {
            return { _tag: "Conflict" as const, rootId: root.rootId };
          }
          const retained = usageRows.filter(
            (row) =>
              row.allowancePeriodId === root.allowancePeriodId &&
              row.sourceType === "ModelCallAttempt" &&
              row.sourceId === model.attemptId,
          );
          const zero = zeroRows.filter(
            (row) =>
              row.allowancePeriodId === root.allowancePeriodId &&
              row.sourceType === "ModelCallAttempt" &&
              row.sourceId === model.attemptId,
          );
          if (model.items.length === 0) {
            if (retained.length === 0 && zero.length === 0) {
              return { _tag: "Missing" as const, rootId: root.rootId };
            }
            if (
              retained.length !== 0 ||
              zero.length !== 1 ||
              zero[0]?.resourcePriceVersion !== model.priceBookId ||
              zero[0].userId !== root.userId
            ) {
              return { _tag: "Conflict" as const, rootId: root.rootId };
            }
            records.push({
              allowancePeriodId: root.allowancePeriodId,
              basis: "provenNoUse",
              costReconciliationId: model.costReconciliationId,
              occurredAt: zero[0].recordedAt.toISOString(),
              priceBookId: model.priceBookId,
              quantity: 0n,
              rootId: root.rootId,
              sourceId: model.attemptId,
              sourceType: "ModelCallAttempt",
              userId: root.userId,
            });
            continue;
          }
          const exact =
            retained.length === model.items.length &&
            zero.length === 0 &&
            model.items.every((item) =>
              retained.some(
                (row) =>
                  row.allowanceKind === item.allowanceKind &&
                  row.basis === item.basis &&
                  row.quantity === item.quantity &&
                  row.resourcePriceVersion === model.priceBookId &&
                  row.userId === root.userId,
              ),
            );
          if (retained.length === 0 && zero.length === 0) {
            return { _tag: "Missing" as const, rootId: root.rootId };
          }
          if (!exact) return { _tag: "Conflict" as const, rootId: root.rootId };
          records.push(
            ...retained.map((row): QualificationBillingRecord => ({
              allowanceKind: Schema.decodeUnknownSync(AllowanceKind)(row.allowanceKind),
              allowancePeriodId: root.allowancePeriodId,
              basis: Schema.decodeUnknownSync(
                Schema.Literals(["conservative", "known_at_start", "observed"]),
              )(row.basis),
              costReconciliationId: model.costReconciliationId,
              occurredAt: row.recordedAt.toISOString(),
              priceBookId: model.priceBookId,
              quantity: row.quantity,
              rootId: root.rootId,
              sourceId: model.attemptId,
              sourceType: "ModelCallAttempt",
              userId: root.userId,
            })),
          );
        }
      }
      return { _tag: "Ready" as const, localEvidence, records };
    }),
  );
};

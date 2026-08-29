import { eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { DbTimestamp } from "../../../db";
import { AllowancePeriodId } from "../../../domain";
import { AllowanceItem } from "../../../domain/allowance";
import {
  ModelCallAttemptId,
  ModelCallUsageConflict,
  ModelCallUsageStoreUnavailable,
  type PendingModelCallUsage,
  type QualificationModelCallIdentity,
} from "../../../domain/model-call-attempt";
import type { AgentDb } from "./client";
import { modelCallUsageEvidence } from "./schema";

const PersistedItems = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      allowanceKind: AllowanceItem.fields.allowanceKind,
      basis: AllowanceItem.fields.basis,
      quantity: Schema.BigIntFromString,
    }),
  ),
);
const encodeItems = Schema.encodeSync(PersistedItems);

const StoredPendingUsage = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  attemptId: ModelCallAttemptId,
  itemsJson: PersistedItems,
  qualification: Schema.optionalKey(
    Schema.Struct({
      costReconciliationId: Schema.String,
      executionId: Schema.String,
      gatewayRequestId: Schema.NullOr(Schema.String),
      modelRequestId: Schema.String,
      outcomeId: Schema.String,
      priceBookId: Schema.String,
      rootId: Schema.String,
    }),
  ),
});

const qualificationColumns = (qualification: QualificationModelCallIdentity | undefined) => ({
  qualification_cost_reconciliation_id: qualification?.costReconciliationId ?? null,
  qualification_execution_id: qualification?.executionId ?? null,
  qualification_gateway_request_id: qualification?.gatewayRequestId ?? null,
  qualification_model_request_id: qualification?.modelRequestId ?? null,
  qualification_outcome_id: qualification?.outcomeId ?? null,
  qualification_price_book_id: qualification?.priceBookId ?? null,
  qualification_root_id: qualification?.rootId ?? null,
});

/** Construct Agent SQLite operations for durable model-call usage evidence. */
export const makeModelCallUsageStore = (db: AgentDb) => {
  const commit = (usage: PendingModelCallUsage, recordedAt: Date) =>
    Effect.gen(function* () {
      const outcome = yield* execute("commitModelCallUsage", () =>
        db.transaction((transaction) => {
          const itemsJson = encodeItems(usage.items);
          const existing = transaction
            .select({
              allowancePeriodId: modelCallUsageEvidence.allowance_period_id,
              itemsJson: modelCallUsageEvidence.items_json,
              qualificationCostReconciliationId:
                modelCallUsageEvidence.qualification_cost_reconciliation_id,
              qualificationExecutionId: modelCallUsageEvidence.qualification_execution_id,
              qualificationGatewayRequestId:
                modelCallUsageEvidence.qualification_gateway_request_id,
              qualificationModelRequestId: modelCallUsageEvidence.qualification_model_request_id,
              qualificationOutcomeId: modelCallUsageEvidence.qualification_outcome_id,
              qualificationPriceBookId: modelCallUsageEvidence.qualification_price_book_id,
              qualificationRootId: modelCallUsageEvidence.qualification_root_id,
            })
            .from(modelCallUsageEvidence)
            .where(eq(modelCallUsageEvidence.attempt_id, usage.attemptId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            return existing.allowancePeriodId === usage.allowancePeriodId &&
              existing.itemsJson === itemsJson &&
              existing.qualificationCostReconciliationId ===
                (usage.qualification?.costReconciliationId ?? null) &&
              existing.qualificationExecutionId === (usage.qualification?.executionId ?? null) &&
              existing.qualificationGatewayRequestId ===
                (usage.qualification?.gatewayRequestId ?? null) &&
              existing.qualificationModelRequestId ===
                (usage.qualification?.modelRequestId ?? null) &&
              existing.qualificationOutcomeId === (usage.qualification?.outcomeId ?? null) &&
              existing.qualificationPriceBookId === (usage.qualification?.priceBookId ?? null) &&
              existing.qualificationRootId === (usage.qualification?.rootId ?? null)
              ? "existing"
              : "conflict";
          }
          transaction
            .insert(modelCallUsageEvidence)
            .values({
              allowance_period_id: usage.allowancePeriodId,
              attempt_id: usage.attemptId,
              dispatched_at: null,
              items_json: itemsJson,
              ...qualificationColumns(usage.qualification),
              recorded_at: timestamp(recordedAt),
            })
            .run();
          return "inserted";
        }),
      );
      if (outcome === "conflict") {
        return yield* new ModelCallUsageConflict({
          attemptId: usage.attemptId,
          message: "The ModelCallAttempt already has different normalized evidence",
        });
      }
      return undefined;
    });

  const readPending = execute("readPendingModelCallUsage", () =>
    db
      .select({
        allowancePeriodId: modelCallUsageEvidence.allowance_period_id,
        attemptId: modelCallUsageEvidence.attempt_id,
        itemsJson: modelCallUsageEvidence.items_json,
        qualificationCostReconciliationId:
          modelCallUsageEvidence.qualification_cost_reconciliation_id,
        qualificationExecutionId: modelCallUsageEvidence.qualification_execution_id,
        qualificationGatewayRequestId: modelCallUsageEvidence.qualification_gateway_request_id,
        qualificationModelRequestId: modelCallUsageEvidence.qualification_model_request_id,
        qualificationOutcomeId: modelCallUsageEvidence.qualification_outcome_id,
        qualificationPriceBookId: modelCallUsageEvidence.qualification_price_book_id,
        qualificationRootId: modelCallUsageEvidence.qualification_root_id,
      })
      .from(modelCallUsageEvidence)
      .where(isNull(modelCallUsageEvidence.dispatched_at))
      .orderBy(modelCallUsageEvidence.recorded_at)
      .all(),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const qualificationFields =
          row.qualificationExecutionId === null
            ? {}
            : {
                qualification: {
                  costReconciliationId: row.qualificationCostReconciliationId ?? "",
                  executionId: row.qualificationExecutionId,
                  gatewayRequestId: row.qualificationGatewayRequestId,
                  modelRequestId: row.qualificationModelRequestId ?? "",
                  outcomeId: row.qualificationOutcomeId ?? "",
                  priceBookId: row.qualificationPriceBookId ?? "",
                  rootId: row.qualificationRootId ?? "",
                },
              };
        return {
          allowancePeriodId: row.allowancePeriodId,
          attemptId: row.attemptId,
          itemsJson: row.itemsJson,
          ...qualificationFields,
        };
      }),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredPendingUsage))),
    Effect.map((rows) =>
      rows.map((row): PendingModelCallUsage => {
        const qualificationFields =
          row.qualification === undefined ? {} : { qualification: row.qualification };
        return {
          allowancePeriodId: row.allowancePeriodId,
          attemptId: row.attemptId,
          items: row.itemsJson,
          ...qualificationFields,
        };
      }),
    ),
    Effect.mapError((failure) =>
      Schema.is(ModelCallUsageStoreUnavailable)(failure)
        ? failure
        : unavailable("readPendingModelCallUsage", failure),
    ),
  );

  const markDispatched = (attemptId: ModelCallAttemptId, dispatchedAt: Date) =>
    execute("markModelCallUsageDispatched", () =>
      db
        .update(modelCallUsageEvidence)
        .set({ dispatched_at: timestamp(dispatchedAt) })
        .where(eq(modelCallUsageEvidence.attempt_id, attemptId))
        .run(),
    );

  return { commit, markDispatched, readPending };
};

/** Read qualification model facts only after their Allowance dispatch is durable. */
export const readQualificationModelAccess = (db: AgentDb, executionId: string) =>
  execute("readQualificationModelAccess", () =>
    db
      .select({
        allowancePeriodId: modelCallUsageEvidence.allowance_period_id,
        attemptId: modelCallUsageEvidence.attempt_id,
        costReconciliationId: modelCallUsageEvidence.qualification_cost_reconciliation_id,
        dispatchedAt: modelCallUsageEvidence.dispatched_at,
        executionId: modelCallUsageEvidence.qualification_execution_id,
        gatewayRequestId: modelCallUsageEvidence.qualification_gateway_request_id,
        itemsJson: modelCallUsageEvidence.items_json,
        modelRequestId: modelCallUsageEvidence.qualification_model_request_id,
        outcomeId: modelCallUsageEvidence.qualification_outcome_id,
        priceBookId: modelCallUsageEvidence.qualification_price_book_id,
        recordedAt: modelCallUsageEvidence.recorded_at,
        rootId: modelCallUsageEvidence.qualification_root_id,
      })
      .from(modelCallUsageEvidence)
      .where(eq(modelCallUsageEvidence.qualification_execution_id, executionId))
      .orderBy(modelCallUsageEvidence.recorded_at, modelCallUsageEvidence.attempt_id)
      .all(),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Schema.decodeEffect(PersistedItems)(row.itemsJson).pipe(
          Effect.map((items) => ({ row, items })),
        ),
      ),
    ),
    Effect.map((rows) =>
      rows.flatMap(({ items, row }) =>
        row.costReconciliationId === null ||
        row.executionId === null ||
        row.modelRequestId === null ||
        row.outcomeId === null ||
        row.priceBookId === null ||
        row.rootId === null
          ? []
          : [
              {
                allowancePeriodId: row.allowancePeriodId,
                attemptId: row.attemptId,
                costReconciliationId: row.costReconciliationId,
                dispatchedAt: row.dispatchedAt,
                executionId: row.executionId,
                gatewayRequestId: row.gatewayRequestId,
                items,
                modelRequestId: row.modelRequestId,
                outcomeId: row.outcomeId,
                priceBookId: row.priceBookId,
                recordedAt: row.recordedAt,
                rootId: row.rootId,
              },
            ],
      ),
    ),
    Effect.mapError((failure) =>
      Schema.is(ModelCallUsageStoreUnavailable)(failure)
        ? failure
        : unavailable("readQualificationModelAccess", failure),
    ),
  );

const execute = <A>(operation: string, effect: () => A) =>
  Effect.try({
    try: effect,
    catch: (cause) => unavailable(operation, cause),
  });

const unavailable = (operation: string, cause: unknown) =>
  new ModelCallUsageStoreUnavailable({
    cause,
    message: "Agent SQLite could not persist normalized model-call usage",
    operation,
  });

const timestamp = (date: Date) => DbTimestamp.make(date.toISOString());

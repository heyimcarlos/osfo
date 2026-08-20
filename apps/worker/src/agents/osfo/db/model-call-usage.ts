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
            })
            .from(modelCallUsageEvidence)
            .where(eq(modelCallUsageEvidence.attempt_id, usage.attemptId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            return existing.allowancePeriodId === usage.allowancePeriodId &&
              existing.itemsJson === itemsJson
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
      })
      .from(modelCallUsageEvidence)
      .where(isNull(modelCallUsageEvidence.dispatched_at))
      .orderBy(modelCallUsageEvidence.recorded_at)
      .all(),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredPendingUsage))),
    Effect.map((rows) =>
      rows.map((row): PendingModelCallUsage => ({
        allowancePeriodId: row.allowancePeriodId,
        attemptId: row.attemptId,
        items: row.itemsJson,
      })),
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

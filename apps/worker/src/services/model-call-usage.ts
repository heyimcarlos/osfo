import { Effect, Schema } from "effect";

import type { AllowancePeriodId } from "../domain";
import type {
  ModelCallAttemptId,
  ModelCallEvidence,
  ModelCallUsageConflict,
  ModelCallUsageStoreUnavailable,
  PendingModelCallUsage,
} from "../domain/model-call-attempt";
import { normalizeModelCallUsage } from "../domain/model-call-attempt";
import type { ExistingUsage, Recorded } from "../domain/allowance";
import type { Interface as Allowances } from "./allowances";

/** Proven no-use outcome that creates no Allowance Consumption record. */
export const NoModelCallUsage = Schema.TaggedStruct("NoModelCallUsage", {});

/** Proven no-use outcome that creates no Allowance Consumption record. */
export type NoModelCallUsage = typeof NoModelCallUsage.Type;

/** Record normalized model-provider evidence against the admitted period and attempt identity. */
export const recordModelCallUsage = (
  allowances: Allowances,
  allowancePeriodId: AllowancePeriodId,
  attemptId: ModelCallAttemptId,
  evidence: ModelCallEvidence,
) => {
  const normalized = normalizeModelCallUsage(attemptId, evidence);
  return normalized.items.length === 0
    ? Effect.succeed<NoModelCallUsage | ExistingUsage | Recorded>(NoModelCallUsage.make({}))
    : allowances.record(allowancePeriodId, normalized.source, normalized.items);
};

/** Agent SQLite evidence operations required for lossless cross-store recording. */
export interface ModelCallUsagePersistence {
  readonly commit: (
    usage: PendingModelCallUsage,
    recordedAt: Date,
  ) => Effect.Effect<void, ModelCallUsageConflict | ModelCallUsageStoreUnavailable>;
  readonly markDispatched: (
    attemptId: ModelCallAttemptId,
    dispatchedAt: Date,
  ) => Effect.Effect<void, ModelCallUsageStoreUnavailable>;
  readonly readPending: Effect.Effect<
    ReadonlyArray<PendingModelCallUsage>,
    ModelCallUsageStoreUnavailable
  >;
}

/** PostgreSQL Allowance recorder required by durable model-call evidence. */
export interface ModelCallUsageDispatch<E> {
  readonly record: (usage: PendingModelCallUsage) => Effect.Effect<void, E>;
}

/** Persist model evidence before PostgreSQL dispatch and reconcile safe retries after activation. */
export const makeDurableModelCallUsage = <E>(options: {
  readonly dispatch: ModelCallUsageDispatch<E>;
  readonly now: Effect.Effect<Date>;
  readonly persistence: ModelCallUsagePersistence;
}) => {
  const dispatch = (usage: PendingModelCallUsage) =>
    options.dispatch.record(usage).pipe(
      Effect.andThen(options.now),
      Effect.flatMap((dispatchedAt) =>
        options.persistence.markDispatched(usage.attemptId, dispatchedAt),
      ),
    );

  const record = (
    allowancePeriodId: AllowancePeriodId,
    attemptId: ModelCallAttemptId,
    evidence: ModelCallEvidence,
  ) => {
    const normalized = normalizeModelCallUsage(attemptId, evidence);
    if (normalized.items.length === 0) return Effect.succeed(NoModelCallUsage.make({}));
    const pending = { allowancePeriodId, attemptId, items: normalized.items };
    return options.now.pipe(
      Effect.flatMap((recordedAt) => options.persistence.commit(pending, recordedAt)),
      Effect.andThen(dispatch(pending)),
    );
  };

  const reconcile = options.persistence.readPending.pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(pending, dispatch, { concurrency: 1, discard: true }),
    ),
    Effect.catch(() =>
      Effect.logError("Model-call usage reconciliation remains pending").pipe(
        Effect.annotateLogs({ failureTag: "ModelCallUsageReconciliationFailure" }),
      ),
    ),
  );

  return { reconcile, record };
};

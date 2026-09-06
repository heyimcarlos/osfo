import { and, desc, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { UserId } from "../../../domain";
import {
  CompletedOperationSchema,
  PaidSearchAttempt,
  RankedResultSchema,
  WebUnavailable,
  type CompletedOperation,
  type TurnCounts,
  type WebState,
} from "../../../services/web";
import type { AgentDb } from "./client";
import { webOperations, webResults } from "./schema";

/* oxlint-disable eslint/no-underscore-dangle -- Durable web outcomes use the canonical _tag discriminator. */

const maximumRetainedResultsPerUser = 30;
const maximumRetainedOperationsPerUser = 30;
const pendingOperationLeaseMilliseconds = 30_000;
const PersistedOperation = Schema.fromJsonString(CompletedOperationSchema);
const ExpiredSearchResult = Schema.TaggedStruct("SearchResultExpired", {});
const RetainedOperation = Schema.fromJsonString(
  Schema.Union([CompletedOperationSchema, ExpiredSearchResult]),
);
const expiredSearchResultJson = Schema.encodeSync(Schema.fromJsonString(ExpiredSearchResult))({
  _tag: "SearchResultExpired",
});
const PersistedPaidSearchAttempt = Schema.fromJsonString(PaidSearchAttempt);
const encodePaidSearchAttempt = Schema.encodeSync(PersistedPaidSearchAttempt);
const PersistedResult = Schema.fromJsonString(RankedResultSchema);
const encodeOperation = Schema.encodeSync(PersistedOperation);
const encodeResult = Schema.encodeSync(PersistedResult);

export class WebStateUnavailable extends Schema.TaggedError<WebStateUnavailable>()(
  "WebStateUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals([
      "claim",
      "complete",
      "fail",
      "readResult",
      "replay",
      "retainSearchAttempt",
    ]),
  },
) {}

/** Durable Agent-local idempotency, turn limits, and User-scoped result identities. */
export const makeWebState = (
  db: AgentDb,
  nowEpochMillis: () => number = Date.now,
): WebState<WebStateUnavailable> => ({
  claim: (input) =>
    execute("claim", (): StoredClaim =>
      db.transaction<StoredClaim>((transaction) => {
        const existing = transaction
          .select({
            createdAtEpochMillis: webOperations.created_at_epoch_millis,
            fingerprint: webOperations.fingerprint,
            kind: webOperations.kind,
            ownerUserId: webOperations.owner_user_id,
            paidAttemptJson: webOperations.paid_attempt_json,
            resultJson: webOperations.result_json,
            status: webOperations.status,
          })
          .from(webOperations)
          .where(eq(webOperations.operation_id, input.operationId))
          .limit(1)
          .get();
        let lease = nowEpochMillis();
        if (existing !== undefined) {
          if (
            existing.ownerUserId !== input.userId ||
            existing.kind !== input.kind ||
            existing.fingerprint !== input.fingerprint
          ) {
            return { _tag: "Conflict" as const };
          }
          if (existing.status === "pending" && existing.paidAttemptJson !== null) {
            return { _tag: "PaidAttempt" as const, attemptJson: existing.paidAttemptJson };
          }
          if (existing.status === "pending" || existing.resultJson === null) {
            if (
              nowEpochMillis() - existing.createdAtEpochMillis <=
              pendingOperationLeaseMilliseconds
            ) {
              return { _tag: "Pending" as const };
            }
            lease = Math.max(lease, existing.createdAtEpochMillis + 1);
            transaction
              .update(webOperations)
              .set({
                created_at_epoch_millis: lease,
                reserved_pages: input.kind === "search" ? 3 : 1,
                result_json: null,
                status: "pending",
                turn_id: input.turnId,
              })
              .where(
                and(
                  eq(webOperations.operation_id, input.operationId),
                  eq(webOperations.created_at_epoch_millis, existing.createdAtEpochMillis),
                  eq(webOperations.status, "pending"),
                ),
              )
              .run();
          } else {
            return { _tag: "Existing" as const, resultJson: existing.resultJson };
          }
        } else {
          transaction
            .insert(webOperations)
            .values({
              created_at_epoch_millis: lease,
              fingerprint: input.fingerprint,
              kind: input.kind,
              operation_id: input.operationId,
              owner_user_id: input.userId,
              reserved_pages: input.kind === "search" ? 3 : 1,
              result_json: null,
              status: "pending",
              turn_id: input.turnId,
            })
            .run();
        }
        const counts = transaction
          .select({
            pages: sql<number>`coalesce(sum(${webOperations.reserved_pages}), 0)`,
            searches: sql<number>`coalesce(sum(case when ${webOperations.kind} = 'search' then 1 else 0 end), 0)`,
          })
          .from(webOperations)
          .where(
            and(
              eq(webOperations.owner_user_id, input.userId),
              eq(webOperations.turn_id, input.turnId),
            ),
          )
          .get();
        return {
          _tag: "Claimed" as const,
          counts: { pages: counts?.pages ?? 0, searches: counts?.searches ?? 0 },
          lease,
        };
      }),
    ).pipe(Effect.flatMap(decodeClaim)),
  retainSearchAttempt: (userId, operationId, lease, attempt) =>
    execute("retainSearchAttempt", () => {
      const updated = db
        .update(webOperations)
        .set({ paid_attempt_json: encodePaidSearchAttempt(attempt) })
        .where(
          and(
            eq(webOperations.operation_id, operationId),
            eq(webOperations.owner_user_id, userId),
            eq(webOperations.created_at_epoch_millis, lease),
            eq(webOperations.kind, "search"),
            eq(webOperations.status, "pending"),
          ),
        )
        .returning({ operationId: webOperations.operation_id })
        .all();
      if (updated.length !== 1) throw new Error("The paid search claim is no longer current");
    }),
  complete: (userId, operationId, lease, result) =>
    execute("complete", () => {
      db.transaction((transaction) => {
        const encoded = encodeOperation(result);
        const existing = transaction
          .select({
            createdAtEpochMillis: webOperations.created_at_epoch_millis,
            ownerUserId: webOperations.owner_user_id,
            resultJson: webOperations.result_json,
            status: webOperations.status,
          })
          .from(webOperations)
          .where(eq(webOperations.operation_id, operationId))
          .limit(1)
          .get();
        if (existing?.ownerUserId !== userId) {
          throw new Error("The claimed web operation is unavailable to this User");
        }
        if (existing.createdAtEpochMillis !== lease) {
          throw new Error("The web operation lease is no longer current");
        }
        if (existing.status === "completed") {
          if (existing.resultJson !== encoded) {
            throw new Error("The completed web operation has different evidence");
          }
          return;
        }
        if (result._tag === "SearchCompleted") {
          const retainedAt = nowEpochMillis();
          for (const ranked of result.results) {
            transaction
              .insert(webResults)
              .values({
                owner_user_id: userId,
                rank: ranked.rank,
                result_id: ranked.resultId,
                result_json: encodeResult(ranked),
                result_set_id: result.resultSetId,
                retained_at_epoch_millis: retainedAt,
              })
              .run();
          }
        }
        transaction
          .update(webOperations)
          .set({
            reserved_pages: completedPageCount(result),
            result_json: encoded,
            status: "completed",
          })
          .where(
            and(
              eq(webOperations.operation_id, operationId),
              eq(webOperations.owner_user_id, userId),
              eq(webOperations.status, "pending"),
              eq(webOperations.created_at_epoch_millis, lease),
            ),
          )
          .run();
      });
      pruneResults(db, userId);
      pruneOperations(db, userId);
    }),
  fail: (userId, operationId, lease) =>
    execute("fail", () =>
      db
        .delete(webOperations)
        .where(
          and(
            eq(webOperations.operation_id, operationId),
            eq(webOperations.owner_user_id, userId),
            eq(webOperations.status, "pending"),
            isNull(webOperations.paid_attempt_json),
            eq(webOperations.created_at_epoch_millis, lease),
          ),
        )
        .run(),
    ).pipe(Effect.asVoid),
  readResult: (ownerUserId, resultId) =>
    execute("readResult", () =>
      db
        .select({ resultJson: webResults.result_json })
        .from(webResults)
        .where(and(eq(webResults.result_id, resultId), eq(webResults.owner_user_id, ownerUserId)))
        .limit(1)
        .get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined
          ? Effect.succeed(null)
          : Schema.decodeEffect(PersistedResult)(row.resultJson).pipe(
              Effect.mapError((cause) => unavailable("readResult", cause)),
            ),
      ),
    ),
  replay: (input) =>
    execute("replay", (): StoredReplay =>
      db.transaction<StoredReplay>((transaction) => {
        const existing = transaction
          .select({
            createdAtEpochMillis: webOperations.created_at_epoch_millis,
            fingerprint: webOperations.fingerprint,
            kind: webOperations.kind,
            ownerUserId: webOperations.owner_user_id,
            paidAttemptJson: webOperations.paid_attempt_json,
            resultJson: webOperations.result_json,
            status: webOperations.status,
          })
          .from(webOperations)
          .where(eq(webOperations.operation_id, input.operationId))
          .limit(1)
          .get();
        if (existing === undefined) return { _tag: "Missing" as const };
        if (
          existing.ownerUserId !== input.userId ||
          existing.kind !== input.kind ||
          existing.fingerprint !== input.fingerprint
        ) {
          return { _tag: "Conflict" as const };
        }
        if (existing.status === "completed" && existing.resultJson !== null) {
          return { _tag: "Existing" as const, resultJson: existing.resultJson };
        }
        if (existing.paidAttemptJson !== null) {
          return { _tag: "PaidAttempt" as const, attemptJson: existing.paidAttemptJson };
        }
        if (nowEpochMillis() - existing.createdAtEpochMillis <= pendingOperationLeaseMilliseconds) {
          return { _tag: "Pending" as const };
        }
        transaction
          .delete(webOperations)
          .where(eq(webOperations.operation_id, input.operationId))
          .run();
        return { _tag: "Missing" as const };
      }),
    ).pipe(Effect.flatMap(decodeReplay)),
});

const completedPageCount = (result: CompletedOperation) =>
  result._tag === "PageReadCompleted"
    ? 1
    : result.results.filter(({ page }) => page._tag !== "NotRead").length;

const pruneOperations = (db: AgentDb, ownerUserId: UserId) => {
  const retained = db
    .select({ operationId: webOperations.operation_id })
    .from(webOperations)
    .where(and(eq(webOperations.owner_user_id, ownerUserId), eq(webOperations.status, "completed")))
    .orderBy(desc(webOperations.created_at_epoch_millis), desc(webOperations.operation_id))
    .limit(maximumRetainedOperationsPerUser)
    .all()
    .map(({ operationId }) => operationId);
  if (retained.length === 0) return;
  db.delete(webOperations)
    .where(
      and(
        eq(webOperations.owner_user_id, ownerUserId),
        eq(webOperations.status, "completed"),
        isNull(webOperations.paid_attempt_json),
        notInArray(webOperations.operation_id, retained),
      ),
    )
    .run();
  // Paid attempt identities outlive result bodies so an expired ToolCall cannot dispatch again.
  db.update(webOperations)
    .set({ result_json: expiredSearchResultJson })
    .where(
      and(
        eq(webOperations.owner_user_id, ownerUserId),
        eq(webOperations.status, "completed"),
        isNotNull(webOperations.paid_attempt_json),
        notInArray(webOperations.operation_id, retained),
      ),
    )
    .run();
};

const pruneResults = (db: AgentDb, ownerUserId: UserId) => {
  const retained = db
    .select({ resultId: webResults.result_id })
    .from(webResults)
    .where(eq(webResults.owner_user_id, ownerUserId))
    .orderBy(
      desc(webResults.retained_at_epoch_millis),
      desc(webResults.result_set_id),
      webResults.rank,
    )
    .limit(maximumRetainedResultsPerUser)
    .all()
    .map(({ resultId }) => resultId);
  if (retained.length === 0) return;
  db.delete(webResults)
    .where(
      and(eq(webResults.owner_user_id, ownerUserId), notInArray(webResults.result_id, retained)),
    )
    .run();
};

type StoredClaim =
  | {
      readonly _tag: "Claimed";
      readonly counts: { readonly pages: number; readonly searches: number };
      readonly lease: number;
    }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Existing"; readonly resultJson: string }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "PaidAttempt"; readonly attemptJson: string };

type StoredReplay =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Existing"; readonly resultJson: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "PaidAttempt"; readonly attemptJson: string };

type Claim =
  | { readonly _tag: "Claimed"; readonly counts: TurnCounts; readonly lease: number }
  | { readonly _tag: "Existing"; readonly result: CompletedOperation };

const decodeClaim = (
  outcome: StoredClaim,
): Effect.Effect<Claim, WebStateUnavailable | WebUnavailable> => {
  switch (outcome._tag) {
    case "Claimed":
      return Effect.succeed(outcome);
    case "Conflict":
      return Effect.fail(
        new WebUnavailable({
          message: "The ToolCall identity already names different public-web work.",
          reason: "operationConflict",
        }),
      );
    case "PaidAttempt":
      return failedPaidAttempt(outcome.attemptJson);
    case "Pending":
      return Effect.fail(
        new WebUnavailable({
          message: "The same public-web ToolCall is still in progress.",
          reason: "operationInProgress",
        }),
      );
    case "Existing":
      return decodeRetainedOperation(outcome.resultJson, "claim").pipe(
        Effect.map((result) => ({ _tag: "Existing" as const, result })),
      );
    default:
      return outcome satisfies never;
  }
};

const decodeReplay = (
  outcome: StoredReplay,
): Effect.Effect<CompletedOperation | null, WebStateUnavailable | WebUnavailable> => {
  switch (outcome._tag) {
    case "Missing":
      return Effect.succeed(null);
    case "Conflict":
      return Effect.fail(
        new WebUnavailable({
          message: "The ToolCall identity already names different public-web work.",
          reason: "operationConflict",
        }),
      );
    case "PaidAttempt":
      return failedPaidAttempt(outcome.attemptJson);
    case "Pending":
      return Effect.fail(
        new WebUnavailable({
          message: "The same public-web ToolCall is still in progress.",
          reason: "operationInProgress",
        }),
      );
    case "Existing":
      return decodeRetainedOperation(outcome.resultJson, "replay");
    default:
      return outcome satisfies never;
  }
};

const decodeRetainedOperation = (resultJson: string, operation: "claim" | "replay") =>
  Schema.decodeEffect(RetainedOperation)(resultJson).pipe(
    Effect.mapError((cause) => unavailable(operation, cause)),
    Effect.flatMap((result) =>
      result._tag === "SearchResultExpired"
        ? Effect.fail(
            new WebUnavailable({
              message:
                "This paid search completed, but its retained result expired. The same ToolCall cannot be sent again.",
              reason: "operationResultExpired",
            }),
          )
        : Effect.succeed(result),
    ),
  );

const failedPaidAttempt = (attemptJson: string) =>
  Schema.decodeEffect(PersistedPaidSearchAttempt)(attemptJson).pipe(
    Effect.mapError((cause) => unavailable("replay", cause)),
    Effect.flatMap((attempt) =>
      Effect.fail(
        new WebUnavailable({
          message:
            attempt.outcome === "unknown"
              ? "This paid search may have been accepted. The same ToolCall cannot be sent again."
              : "This paid search ended before its public-web result completed. The same ToolCall cannot be sent again.",
          reason: attempt.outcome === "unknown" ? "operationOutcomeUnknown" : "operationFailed",
        }),
      ),
    ),
  );

const execute = <A>(operation: WebStateUnavailable["operation"], run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => unavailable(operation, cause),
  });

const unavailable = (operation: WebStateUnavailable["operation"], cause: unknown) =>
  new WebStateUnavailable({
    cause,
    message: "Agent SQLite could not persist bounded public-web state.",
    operation,
  });

import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { UserId } from "../../../domain";
import {
  CompletedOperationSchema,
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
const PersistedResult = Schema.fromJsonString(RankedResultSchema);
const encodeOperation = Schema.encodeSync(PersistedOperation);
const encodeResult = Schema.encodeSync(PersistedResult);

export class WebStateUnavailable extends Schema.TaggedError<WebStateUnavailable>()(
  "WebStateUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["claim", "complete", "fail", "readResult", "replay"]),
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
            resultJson: webOperations.result_json,
            status: webOperations.status,
          })
          .from(webOperations)
          .where(eq(webOperations.operation_id, input.operationId))
          .limit(1)
          .get();
        if (existing !== undefined) {
          if (
            existing.ownerUserId !== input.userId ||
            existing.kind !== input.kind ||
            existing.fingerprint !== input.fingerprint
          ) {
            return { _tag: "Conflict" as const };
          }
          if (existing.status === "pending" || existing.resultJson === null) {
            if (
              nowEpochMillis() - existing.createdAtEpochMillis <=
              pendingOperationLeaseMilliseconds
            ) {
              return { _tag: "Pending" as const };
            }
            transaction
              .delete(webOperations)
              .where(eq(webOperations.operation_id, input.operationId))
              .run();
          } else {
            return { _tag: "Existing" as const, resultJson: existing.resultJson };
          }
        }
        transaction
          .insert(webOperations)
          .values({
            created_at_epoch_millis: nowEpochMillis(),
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
        };
      }),
    ).pipe(Effect.flatMap(decodeClaim)),
  complete: (userId, operationId, result) =>
    execute("complete", () => {
      db.transaction((transaction) => {
        const encoded = encodeOperation(result);
        const existing = transaction
          .select({
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
          .where(eq(webOperations.operation_id, operationId))
          .run();
      });
      pruneResults(db, userId);
      pruneOperations(db, userId);
    }),
  fail: (userId, operationId) =>
    execute("fail", () =>
      db
        .delete(webOperations)
        .where(
          and(
            eq(webOperations.operation_id, operationId),
            eq(webOperations.owner_user_id, userId),
            eq(webOperations.status, "pending"),
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
    }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Existing"; readonly resultJson: string }
  | { readonly _tag: "Pending" };

type StoredReplay =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Existing"; readonly resultJson: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Pending" };

type Claim =
  | { readonly _tag: "Claimed"; readonly counts: TurnCounts }
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
    case "Pending":
      return Effect.fail(
        new WebUnavailable({
          message: "The same public-web ToolCall is still in progress.",
          reason: "operationInProgress",
        }),
      );
    case "Existing":
      return Schema.decodeEffect(PersistedOperation)(outcome.resultJson).pipe(
        Effect.map((result) => ({ _tag: "Existing" as const, result })),
        Effect.mapError((cause) => unavailable("claim", cause)),
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
    case "Pending":
      return Effect.fail(
        new WebUnavailable({
          message: "The same public-web ToolCall is still in progress.",
          reason: "operationInProgress",
        }),
      );
    case "Existing":
      return Schema.decodeEffect(PersistedOperation)(outcome.resultJson).pipe(
        Effect.mapError((cause) => unavailable("replay", cause)),
      );
    default:
      return outcome satisfies never;
  }
};

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

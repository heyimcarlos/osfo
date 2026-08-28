import { researchReportSynthesisOperations } from "@osfo/db/schema/research-reports";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import type { Database } from "@osfo/db";
import { ModelAccessPolicyVersion, ResourcePriceVersion } from "../../domain";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { ResearchReport } from "../../services/research-report";
import { ResearchSynthesis } from "../../services/research-synthesis";

/* oxlint-disable effecttsgo/async-function -- Drizzle is the Promise persistence boundary. */
/* oxlint-disable eslint/no-underscore-dangle -- Persistence outcomes use the standard tagged discriminator. */

const rowSelection = {
  attemptCount: researchReportSynthesisOperations.attempt_count,
  companyCostJson: researchReportSynthesisOperations.company_cost_json,
  inputDigest: researchReportSynthesisOperations.input_digest,
  modelAccessPolicyVersion: researchReportSynthesisOperations.model_access_policy_version,
  modelRoute: researchReportSynthesisOperations.model_route,
  operationId: researchReportSynthesisOperations.operation_id,
  resourcePriceVersion: researchReportSynthesisOperations.resource_price_version,
  resultDigest: researchReportSynthesisOperations.result_digest,
  resultKey: researchReportSynthesisOperations.result_key,
  safeFailureCode: researchReportSynthesisOperations.safe_failure_code,
  startedAt: researchReportSynthesisOperations.started_at,
  state: researchReportSynthesisOperations.state,
  workflowId: researchReportSynthesisOperations.workflow_id,
};

type Row = {
  readonly attemptCount: number;
  readonly companyCostJson: string | null;
  readonly inputDigest: string;
  readonly modelAccessPolicyVersion: string;
  readonly modelRoute: string;
  readonly operationId: string;
  readonly resourcePriceVersion: string;
  readonly resultDigest: string | null;
  readonly resultKey: string | null;
  readonly safeFailureCode: string | null;
  readonly startedAt: Date | null;
  readonly state: string;
  readonly workflowId: string;
};

const EncodedCost = Schema.fromJsonString(
  Schema.Struct({
    basis: Schema.Literals(["conservative", "observed"]),
    inputTokens: Schema.BigIntFromString,
    outputTokens: Schema.BigIntFromString,
    providerOperationId: Schema.String,
    usdMicros: Schema.BigIntFromString,
  }),
);

const EncodedOperation = Schema.Struct({
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  companyCost: Schema.NullOr(ResearchSynthesis.CompanyCost),
  inputDigest: ResearchReport.InputDigest,
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  operationId: ResearchSynthesis.OperationId,
  resourcePriceVersion: ResourcePriceVersion,
  resultDigest: Schema.NullOr(ResearchReport.InputDigest),
  resultKey: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  safeFailureCode: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  startedAt: Schema.NullOr(Schema.Date),
  state: ResearchSynthesis.State,
  workflowId: ResearchReport.WorkflowId,
});

/** PostgreSQL exact model-operation persistence for report synthesis. */
export const make = (database: Database): ResearchSynthesis.PortInterface["persistence"] => ({
  claim: (operation) =>
    attempt("claim", async () => {
      const inserted = await database
        .insert(researchReportSynthesisOperations)
        .values({
          attempt_count: operation.attemptCount,
          company_cost_json: null,
          input_digest: operation.inputDigest,
          model_access_policy_version: operation.modelAccessPolicyVersion,
          model_route: operation.modelRoute,
          operation_id: operation.operationId,
          resource_price_version: operation.resourcePriceVersion,
          result_digest: null,
          result_key: null,
          safe_failure_code: null,
          started_at: null,
          state: operation.state,
          workflow_id: operation.workflowId,
        })
        .onConflictDoNothing({ target: researchReportSynthesisOperations.operation_id })
        .returning(rowSelection);
      if (inserted[0] !== undefined) return { _tag: "Created" as const, row: inserted[0] };
      const [existing] = await database
        .select(rowSelection)
        .from(researchReportSynthesisOperations)
        .where(eq(researchReportSynthesisOperations.operation_id, operation.operationId))
        .limit(1);
      return existing === undefined
        ? { _tag: "Missing" as const }
        : { _tag: "Existing" as const, row: existing };
    }).pipe(
      Effect.flatMap((outcome) => {
        if (outcome._tag === "Missing") {
          return Effect.fail(unavailable("claim", "The synthesis operation vanished after claim"));
        }
        return decodeRow(outcome.row).pipe(
          Effect.flatMap((retained) =>
            retained.workflowId === operation.workflowId &&
            retained.inputDigest === operation.inputDigest &&
            retained.modelRoute === operation.modelRoute &&
            retained.modelAccessPolicyVersion === operation.modelAccessPolicyVersion &&
            retained.resourcePriceVersion === operation.resourcePriceVersion
              ? Effect.succeed({ _tag: outcome._tag, operation: retained } as const)
              : Effect.fail(
                  new ResearchSynthesis.Conflict({
                    message: "The synthesis operation identity owns different pinned facts",
                    operationId: operation.operationId,
                  }),
                ),
          ),
        );
      }),
    ),
  recordAttempt: (operationId, expectedAttemptCount) =>
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      const [started] = yield* attempt("recordAttempt", () =>
        database
          .update(researchReportSynthesisOperations)
          .set({
            attempt_count: expectedAttemptCount + 1,
            started_at: startedAt,
            updated_at: startedAt,
          })
          .where(
            and(
              eq(researchReportSynthesisOperations.operation_id, operationId),
              eq(researchReportSynthesisOperations.state, "pending"),
              eq(researchReportSynthesisOperations.attempt_count, expectedAttemptCount),
            ),
          )
          .returning(rowSelection),
      );
      if (started !== undefined) {
        const operation = yield* decodeRow(started);
        return { _tag: "Started" as const, operation };
      }
      const operation = yield* inspect(database, operationId);
      if (operation === null) {
        return yield* unavailable("recordAttempt", "The synthesis operation is missing");
      }
      return { _tag: "InFlight" as const, operation };
    }),
  complete: (operation, retained, companyCost) =>
    DateTime.now.pipe(
      Effect.map(DateTime.toDateUtc),
      Effect.flatMap((completedAt) =>
        attempt("complete", () =>
          database
            .update(researchReportSynthesisOperations)
            .set({
              company_cost_json: encodeCost(companyCost),
              completed_at: completedAt,
              result_digest: retained.resultDigest,
              result_key: retained.resultKey,
              state: "completed",
              updated_at: completedAt,
            })
            .where(
              and(
                eq(researchReportSynthesisOperations.operation_id, operation.operationId),
                eq(researchReportSynthesisOperations.input_digest, operation.inputDigest),
                inArray(researchReportSynthesisOperations.state, ["pending", "unknown"]),
              ),
            )
            .returning(rowSelection),
        ),
      ),
      Effect.flatMap(([completed]) => {
        if (completed !== undefined) return decodeRow(completed);
        return inspect(database, operation.operationId).pipe(
          Effect.flatMap((existing) => {
            if (
              existing !== null &&
              existing.state === "completed" &&
              existing.resultKey === retained.resultKey &&
              existing.resultDigest === retained.resultDigest &&
              sameCost(existing.companyCost, companyCost)
            ) {
              return Effect.succeed(existing);
            }
            return Effect.fail(
              new ResearchSynthesis.Conflict({
                message: "Synthesis completion lost to a changed or terminal operation",
                operationId: operation.operationId,
              }),
            );
          }),
        );
      }),
    ),
  finish: (operation, state, safeFailureCode, companyCost) =>
    DateTime.now.pipe(
      Effect.map(DateTime.toDateUtc),
      Effect.flatMap((completedAt) =>
        attempt("finish", () =>
          database
            .update(researchReportSynthesisOperations)
            .set({
              company_cost_json: encodeCost(companyCost),
              completed_at: completedAt,
              safe_failure_code: safeFailureCode,
              state,
              updated_at: completedAt,
            })
            .where(
              and(
                eq(researchReportSynthesisOperations.operation_id, operation.operationId),
                eq(researchReportSynthesisOperations.input_digest, operation.inputDigest),
                inArray(researchReportSynthesisOperations.state, ["pending", "unknown"]),
              ),
            )
            .returning(rowSelection),
        ),
      ),
      Effect.flatMap(([finished]) => {
        if (finished !== undefined) return decodeRow(finished);
        return inspect(database, operation.operationId).pipe(
          Effect.flatMap((existing) => {
            if (
              existing !== null &&
              existing.state === state &&
              existing.safeFailureCode === safeFailureCode &&
              sameCost(existing.companyCost, companyCost)
            ) {
              return Effect.succeed(existing);
            }
            return Effect.fail(
              new ResearchSynthesis.Conflict({
                message: "Synthesis terminal outcome lost to changed durable facts",
                operationId: operation.operationId,
              }),
            );
          }),
        );
      }),
    ),
  expireAmbiguous: (operation, expiredBefore) => {
    if (operation.startedAt === null) return Effect.succeed(false);
    return attempt("expireAmbiguous", () =>
      database
        .update(researchReportSynthesisOperations)
        .set({
          safe_failure_code: "expired-ambiguous-synthesis-attempt",
          state: "unknown",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(researchReportSynthesisOperations.operation_id, operation.operationId),
            eq(researchReportSynthesisOperations.input_digest, operation.inputDigest),
            eq(researchReportSynthesisOperations.state, "pending"),
            eq(researchReportSynthesisOperations.attempt_count, operation.attemptCount),
            lte(researchReportSynthesisOperations.started_at, expiredBefore),
          ),
        )
        .returning({ operationId: researchReportSynthesisOperations.operation_id }),
    ).pipe(Effect.map(([updated]) => updated !== undefined));
  },
});

const inspect = (database: Database, operationId: ResearchSynthesis.OperationId) =>
  attempt("inspect", () =>
    database
      .select(rowSelection)
      .from(researchReportSynthesisOperations)
      .where(eq(researchReportSynthesisOperations.operation_id, operationId))
      .limit(1),
  ).pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeRow(row))));

const decodeRow = (row: Row) =>
  Effect.gen(function* () {
    const companyCost =
      row.companyCostJson === null
        ? null
        : yield* Schema.decodeEffect(EncodedCost)(row.companyCostJson).pipe(
            Effect.mapError((cause) =>
              unavailable("decode", "Stored synthesis Company Cost is invalid", cause),
            ),
          );
    return yield* Schema.decodeUnknownEffect(EncodedOperation)({
      ...row,
      companyCost,
    }).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored synthesis operation facts are invalid", cause),
      ),
    );
  });

const encodeCost = (cost: ResearchSynthesis.CompanyCost) => Schema.encodeSync(EncodedCost)(cost);

const sameCost = (
  left: ResearchSynthesis.CompanyCost | null,
  right: ResearchSynthesis.CompanyCost,
) =>
  left !== null &&
  left.basis === right.basis &&
  left.inputTokens === right.inputTokens &&
  left.outputTokens === right.outputTokens &&
  left.providerOperationId === right.providerOperationId &&
  left.usdMicros === right.usdMicros;

const attempt = <Value>(operation: string, query: () => Promise<Value>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      unavailable(operation, "PostgreSQL could not persist synthesis operation state", cause),
  });

const unavailable = (operation: string, message: string, cause: unknown = operation) =>
  new ResearchSynthesis.Unavailable({ cause, message, reason: "storageUnavailable" });

export * as ResearchSynthesisPostgres from "./research-synthesis";

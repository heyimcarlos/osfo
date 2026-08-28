import { researchReportProviderOperations } from "@osfo/db/schema/research-reports";
import { and, eq, ne, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "@osfo/db";
import { ResearchCollector } from "../../services/research-collector";
import { ResearchReport } from "../../services/research-report";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions serialize provider-operation identities. */
/* oxlint-disable eslint/no-underscore-dangle -- Persistence outcomes use the standard Effect _tag discriminator. */

const selection = {
  attemptCount: researchReportProviderOperations.attempt_count,
  inputDigest: researchReportProviderOperations.input_digest,
  inputJson: researchReportProviderOperations.input_json,
  operationId: researchReportProviderOperations.operation_id,
  resultJson: researchReportProviderOperations.result_json,
  sequence: researchReportProviderOperations.sequence,
  state: researchReportProviderOperations.state,
  workflowId: researchReportProviderOperations.workflow_id,
};

type Row = {
  readonly attemptCount: number;
  readonly inputDigest: string;
  readonly inputJson: string;
  readonly operationId: string;
  readonly resultJson: string | null;
  readonly sequence: number;
  readonly state: ResearchCollector.OperationState;
  readonly workflowId: string;
};

const OperationFacts = Schema.Struct({
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inputDigest: ResearchReport.InputDigest,
  operationId: ResearchCollector.OperationId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: ResearchCollector.OperationState,
  workflowId: ResearchReport.WorkflowId,
});

/** PostgreSQL exact-replay adapter for Workflow-owned public-web operations. */
export const make = (database: Database): ResearchCollector.PortInterface["persistence"] => ({
  claim: (operation) =>
    attempt("claim", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operation.operationId}, 0))`,
        );
        const [existing] = await transaction
          .select(selection)
          .from(researchReportProviderOperations)
          .where(eq(researchReportProviderOperations.operation_id, operation.operationId))
          .limit(1)
          .for("update");
        if (existing !== undefined) return { _tag: "Existing" as const, row: existing };
        await transaction.insert(researchReportProviderOperations).values({
          input_digest: operation.inputDigest,
          input_json: encodeInput(operation.input),
          kind: operation.input._tag === "Search" ? "search" : "page",
          operation_id: operation.operationId,
          sequence: operation.sequence,
          state: "pending",
          workflow_id: operation.workflowId,
        });
        const [created] = await transaction
          .select(selection)
          .from(researchReportProviderOperations)
          .where(eq(researchReportProviderOperations.operation_id, operation.operationId))
          .limit(1);
        return created === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "Created" as const, row: created };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Missing") {
            return yield* unavailable("claim", "PostgreSQL did not return the claimed operation");
          }
          const decoded = yield* decodeRow(outcome.row);
          if (
            decoded.inputDigest !== operation.inputDigest ||
            decoded.workflowId !== operation.workflowId ||
            decoded.sequence !== operation.sequence
          ) {
            return yield* new ResearchCollector.Conflict({
              message: "The provider operation identity already owns different immutable facts",
              operationId: operation.operationId,
            });
          }
          return { _tag: outcome._tag, operation: decoded } as const;
        }),
      ),
    ),
  complete: (operation, result) =>
    attempt("complete", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operation.operationId}, 0))`,
        );
        const [row] = await transaction
          .select(selection)
          .from(researchReportProviderOperations)
          .where(eq(researchReportProviderOperations.operation_id, operation.operationId))
          .limit(1)
          .for("update");
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== operation.inputDigest) return { _tag: "Conflict" as const };
        if (row.state === "completed") return { _tag: "Found" as const, row };
        if (row.state !== "pending") return { _tag: "Conflict" as const };
        const [updated] = await transaction
          .update(researchReportProviderOperations)
          .set({
            completed_at: sql`clock_timestamp()`,
            result_json: encodeResult(result),
            state: "completed",
            updated_at: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(researchReportProviderOperations.operation_id, operation.operationId),
              eq(researchReportProviderOperations.input_digest, operation.inputDigest),
              eq(researchReportProviderOperations.state, "pending"),
            ),
          )
          .returning(selection);
        return updated === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "Found" as const, row: updated };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Found") return yield* decodeRow(outcome.row);
          return yield* new ResearchCollector.Conflict({
            message: "The provider operation cannot commit a changed or late result",
            operationId: operation.operationId,
          });
        }),
      ),
    ),
  finish: (operation, state, safeFailureCode) =>
    attempt("finish", () =>
      database
        .update(researchReportProviderOperations)
        .set({
          safe_failure_code: safeFailureCode,
          state,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(researchReportProviderOperations.operation_id, operation.operationId),
            eq(researchReportProviderOperations.input_digest, operation.inputDigest),
            ne(researchReportProviderOperations.state, "completed"),
          ),
        ),
    ).pipe(Effect.asVoid),
  recordAttempt: (operationId, expectedAttemptCount) =>
    attempt("recordAttempt", () =>
      database.transaction(async (transaction) => {
        const [started] = await transaction
          .update(researchReportProviderOperations)
          .set({
            attempt_count: sql`${researchReportProviderOperations.attempt_count} + 1`,
            started_at: sql`coalesce(${researchReportProviderOperations.started_at}, clock_timestamp())`,
            updated_at: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(researchReportProviderOperations.operation_id, operationId),
              eq(researchReportProviderOperations.state, "pending"),
              eq(researchReportProviderOperations.attempt_count, expectedAttemptCount),
            ),
          )
          .returning(selection);
        if (started !== undefined) return { _tag: "Started" as const, row: started };
        const [existing] = await transaction
          .select(selection)
          .from(researchReportProviderOperations)
          .where(eq(researchReportProviderOperations.operation_id, operationId))
          .limit(1);
        return existing === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "InFlight" as const, row: existing };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Missing") {
            return yield* unavailable(
              "recordAttempt",
              "The claimed provider operation vanished before attempt start",
            );
          }
          const operation = yield* decodeRow(outcome.row);
          return { _tag: outcome._tag, operation } as const;
        }),
      ),
    ),
});

const decodeRow = (
  row: Row,
): Effect.Effect<ResearchCollector.Operation, ResearchCollector.Unavailable> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeEffect(
      Schema.fromJsonString(ResearchCollector.OperationInput),
    )(row.inputJson).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored provider-operation input is invalid", cause),
      ),
    );
    const result = yield* row.resultJson === null
      ? Effect.succeed(null)
      : Schema.decodeEffect(Schema.fromJsonString(ResearchCollector.OperationResult))(
          row.resultJson,
        ).pipe(
          Effect.mapError((cause) =>
            unavailable("decode", "Stored provider-operation result is invalid", cause),
          ),
        );
    const facts = yield* Schema.decodeEffect(OperationFacts)(row).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored provider-operation facts are invalid", cause),
      ),
    );
    return { ...facts, input, result };
  });

const encodeInput = (input: ResearchCollector.OperationInput) =>
  Schema.encodeSync(Schema.fromJsonString(ResearchCollector.OperationInput))(input);

const encodeResult = (result: ResearchCollector.OperationResult) =>
  Schema.encodeSync(Schema.fromJsonString(ResearchCollector.OperationResult))(result);

const attempt = <Value>(operation: string, query: () => Promise<Value>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      unavailable(operation, "PostgreSQL could not persist provider-operation state", cause),
  });

const unavailable = (operation: string, message: string, cause: unknown = operation) =>
  new ResearchCollector.Unavailable({
    cause,
    message,
    reason: "storageUnavailable",
  });

export * as ResearchCollectorPostgres from "./research-collector";

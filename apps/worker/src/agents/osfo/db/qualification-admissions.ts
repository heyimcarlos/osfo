import { asc, eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import { ThinkSubmissionId } from "../../../domain";
import { DbTimestamp } from "../../../db";
import { QualificationAdmissionReceipt } from "../../../qualification/qualification-attempt";
import { qualificationChecksum } from "../../../qualification/qualification-checksum";
import type { AgentDb } from "./client";
import { qualificationAdmissions } from "./schema";

export class QualificationAdmissionStoreUnavailable extends Data.TaggedError(
  "QualificationAdmissionStoreUnavailable",
)<{ readonly cause: unknown; readonly message: string }> {}

export class QualificationAdmissionConflict extends Data.TaggedError(
  "QualificationAdmissionConflict",
)<{ readonly attemptId: string; readonly message: string }> {}

const storedFields = {
  acceptanceReceiptId: qualificationAdmissions.acceptance_receipt_id,
  admissionDecision: qualificationAdmissions.admission_decision,
  agentId: qualificationAdmissions.agent_id,
  artifactChecksum: qualificationAdmissions.artifact_checksum,
  attemptId: qualificationAdmissions.attempt_id,
  executionId: qualificationAdmissions.execution_id,
  occurredAt: qualificationAdmissions.occurred_at,
  planChecksum: qualificationAdmissions.plan_checksum,
  productFactId: qualificationAdmissions.product_fact_id,
  rootId: qualificationAdmissions.root_id,
  runId: qualificationAdmissions.run_id,
  thinkSubmissionId: qualificationAdmissions.think_submission_id,
  userMessageId: qualificationAdmissions.user_message_id,
  userUpdateId: qualificationAdmissions.user_update_id,
};

const decodeStored = (value: typeof QualificationAdmissionReceipt.Encoded) =>
  Schema.decodeEffect(QualificationAdmissionReceipt)(value).pipe(
    Effect.mapError(
      (cause) =>
        new QualificationAdmissionStoreUnavailable({
          cause,
          message: "The retained qualification admission receipt is invalid",
        }),
    ),
    Effect.filterOrFail(
      (receipt) => {
        const { artifactChecksum, ...content } = receipt;
        return artifactChecksum === qualificationChecksum(content);
      },
      () =>
        new QualificationAdmissionStoreUnavailable({
          cause: "checksum",
          message: "The retained qualification admission checksum is invalid",
        }),
    ),
  );

/** Commit one idempotent qualification decision in the owning Agent SQLite authority. */
export const retainQualificationAdmissionReceipt = (
  db: AgentDb,
  receipt: QualificationAdmissionReceipt,
) =>
  Effect.gen(function* () {
    const inserted = yield* Effect.try({
      try: () =>
        db
          .insert(qualificationAdmissions)
          .values({
            acceptance_receipt_id: receipt.acceptanceReceiptId,
            admission_decision: receipt.admissionDecision,
            agent_id: receipt.agentId,
            artifact_checksum: receipt.artifactChecksum,
            attempt_id: receipt.attemptId,
            execution_id: receipt.executionId,
            occurred_at: DbTimestamp.make(receipt.occurredAt),
            plan_checksum: receipt.planChecksum,
            product_fact_id: receipt.productFactId,
            root_id: receipt.rootId,
            run_id: receipt.runId,
            think_submission_id:
              receipt.thinkSubmissionId === null
                ? null
                : ThinkSubmissionId.make(receipt.thinkSubmissionId),
            user_message_id: receipt.userMessageId,
            user_update_id: receipt.userUpdateId,
          })
          .onConflictDoNothing()
          .returning(storedFields)
          .get(),
      catch: (cause) =>
        new QualificationAdmissionStoreUnavailable({
          cause,
          message: "The qualification admission receipt could not be committed",
        }),
    });
    const retained =
      inserted ??
      (yield* Effect.try({
        try: () =>
          db
            .select(storedFields)
            .from(qualificationAdmissions)
            .where(eq(qualificationAdmissions.attempt_id, receipt.attemptId))
            .limit(1)
            .get(),
        catch: (cause) =>
          new QualificationAdmissionStoreUnavailable({
            cause,
            message: "The qualification admission retry could not be inspected",
          }),
      }));
    if (retained === undefined) {
      return yield* new QualificationAdmissionConflict({
        attemptId: receipt.attemptId,
        message: "The qualification admission identity was retained by another root",
      });
    }
    const decoded = yield* decodeStored(retained);
    if (decoded.artifactChecksum !== receipt.artifactChecksum) {
      return yield* new QualificationAdmissionConflict({
        attemptId: receipt.attemptId,
        message: "The qualification admission retry conflicts with retained authority",
      });
    }
    return decoded;
  });

/** Read one execution's append-only Agent admission authority in stable order. */
export const readQualificationAdmissionReceipts = (db: AgentDb, executionId: string) =>
  Effect.try({
    try: () =>
      db
        .select(storedFields)
        .from(qualificationAdmissions)
        .where(eq(qualificationAdmissions.execution_id, executionId))
        .orderBy(
          asc(qualificationAdmissions.run_id),
          asc(qualificationAdmissions.occurred_at),
          asc(qualificationAdmissions.root_id),
        )
        .all(),
    catch: (cause) =>
      new QualificationAdmissionStoreUnavailable({
        cause,
        message: "Qualification admission receipts could not be read",
      }),
  }).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeStored)));

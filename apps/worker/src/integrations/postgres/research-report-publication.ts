import { researchReports } from "@osfo/db/schema/research-reports";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { Database } from "@osfo/db";
import { BillingDb } from "../../db/billing";
import { ResearchReport } from "../../services/research-report";
import type { ResearchReportAccounting } from "../../services/research-report-accounting";
import { ResearchReportPostgres } from "./research-report";
import { lockWorkflowUser } from "./workflow-serialization";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns the serialized PostgreSQL boundary. */
/* oxlint-disable eslint/no-await-in-loop -- Launch facts must be retained sequentially inside one transaction. */
/* oxlint-disable eslint/no-underscore-dangle -- Accounting outcomes use the canonical tagged discriminator. */

export interface CompleteInput {
  readonly accounting: ResearchReportAccounting.UsefulReportAccounting;
  readonly completedAt: Date;
  readonly contentId: string;
  readonly report: ResearchReport.Record;
}

class PublicationDeadlineCrossed extends Data.TaggedError("PublicationDeadlineCrossed")<{
  readonly deadlineAt: Date;
}> {}

/** Atomically retain useful User Usage and terminal Success against deadline and deletion. */
export const complete = (database: Database, input: CompleteInput) =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        await lockWorkflowUser(transaction, input.report.userId);
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.report.workflowId}, 0))`,
        );
        const [row] = await transaction
          .select({
            deadlineAt: researchReports.deadline_at,
            deadlineExpired: sql<boolean>`clock_timestamp() >= ${researchReports.deadline_at}`,
            inputDigest: researchReports.input_digest,
            state: researchReports.state,
            userId: researchReports.user_id,
            artifactContentId: researchReports.artifact_content_id,
          })
          .from(researchReports)
          .where(eq(researchReports.workflow_id, input.report.workflowId))
          .for("update")
          .limit(1);
        if (row === undefined) return { _tag: "Missing" as const };
        if (
          row.inputDigest !== input.report.inputDigest ||
          row.userId !== input.report.userId ||
          row.artifactContentId !== input.contentId
        ) {
          return { _tag: "Conflict" as const };
        }
        if (row.state === "success") return { _tag: "Success" as const };
        if (row.state !== "publication_committed") return { _tag: "Canceled" as const };

        const [deletion] = await transaction
          .select({ deletionCaseId: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(
              eq(deletionCases.user_id, input.report.userId),
              isNotNull(deletionCases.access_fenced_at),
            ),
          )
          .limit(1);
        const deadlineExpired =
          row.deadlineExpired || input.completedAt.getTime() >= row.deadlineAt.getTime();
        if (deletion !== undefined || deadlineExpired) {
          await transaction
            .update(researchReports)
            .set({
              safe_failure_code: deletion === undefined ? "deadline-exceeded" : "account-deletion",
              state: "canceled",
              terminal_at: deletion === undefined ? row.deadlineAt : input.completedAt,
              updated_at: input.completedAt,
            })
            .where(
              and(
                eq(researchReports.workflow_id, input.report.workflowId),
                eq(researchReports.state, "publication_committed"),
              ),
            );
          return { _tag: "Canceled" as const };
        }

        const billing = BillingDb.make(transaction);
        if (input.accounting._tag === "Launch") {
          for (const fact of input.accounting.facts) {
            await Effect.runPromise(
              billing.recordUsageForUser(
                input.report.userId,
                input.report.allowancePeriodId,
                fact.source,
                fact.items,
              ),
            );
          }
        } else {
          await Effect.runPromise(billing.recordUsageEvent(input.accounting.event));
        }
        const [completed] = await transaction
          .update(researchReports)
          .set({
            state: "success",
            terminal_at: input.completedAt,
            updated_at: input.completedAt,
          })
          .where(
            and(
              eq(researchReports.workflow_id, input.report.workflowId),
              eq(researchReports.input_digest, input.report.inputDigest),
              eq(researchReports.artifact_content_id, input.contentId),
              eq(researchReports.state, "publication_committed"),
              sql`clock_timestamp() < ${researchReports.deadline_at}`,
            ),
          )
          .returning({ workflowId: researchReports.workflow_id });
        if (completed === undefined) {
          throw new PublicationDeadlineCrossed({ deadlineAt: row.deadlineAt });
        }
        return { _tag: "Success" as const };
      }),
    catch: (cause) =>
      cause instanceof PublicationDeadlineCrossed
        ? cause
        : new ResearchReport.Unavailable({
            cause,
            message: "Useful Research Report accounting and Success could not be committed",
            operation: "publication.complete",
          }),
  }).pipe(
    Effect.catchIf(
      (cause): cause is PublicationDeadlineCrossed => cause instanceof PublicationDeadlineCrossed,
      (cause) =>
        ResearchReportPostgres.make(database)
          .enforceDeadline(input.report.workflowId, input.report.inputDigest, cause.deadlineAt)
          .pipe(Effect.map((report) => ({ _tag: "Retained" as const, report }))),
    ),
    Effect.flatMap((outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Retained") return outcome.report;
        if (outcome._tag === "Missing") {
          return yield* new ResearchReport.NotFound({ workflowId: input.report.workflowId });
        }
        if (outcome._tag === "Conflict") {
          return yield* new ResearchReport.Conflict({
            message: "Useful publication named changed immutable Research Report facts",
            workflowId: input.report.workflowId,
          });
        }
        const retained = yield* ResearchReportPostgres.make(database).inspect(
          input.report.workflowId,
        );
        if (retained === null) {
          return yield* new ResearchReport.NotFound({ workflowId: input.report.workflowId });
        }
        return retained;
      }),
    ),
  );

export * as ResearchReportPublicationPostgres from "./research-report-publication";

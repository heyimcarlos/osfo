/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Drizzle owns this Promise boundary and adapts retained timestamps to Date. */
import { qualificationRootAttempts } from "@osfo/db/schema/qualification-cohorts";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { Database } from "@osfo/db";
import type { QualificationAdmissionReceipt } from "../../qualification/qualification-attempt";

export class QualificationAttemptIndexUnavailable extends Data.TaggedError(
  "QualificationAttemptIndexUnavailable",
)<{ readonly cause: unknown; readonly message: string; readonly operation: string }> {}

interface QualificationAttemptIdentity {
  readonly agentId: string;
  readonly allocationId: string;
  readonly allowancePeriodId: string;
  readonly attemptId: string;
  readonly authSessionExpiresAt: Date;
  readonly authSessionId: string;
  readonly executionId: string;
  readonly journey: string;
  readonly offeredAt: Date;
  readonly planChecksum: string;
  readonly rootId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly submissionId: string;
  readonly userId: string;
}

const selected = {
  admissionDecision: qualificationRootAttempts.admission_decision,
  admissionFactId: qualificationRootAttempts.admission_fact_id,
  admissionObservedAt: qualificationRootAttempts.admission_observed_at,
  agentId: qualificationRootAttempts.agent_id,
  allocationId: qualificationRootAttempts.allocation_id,
  allowancePeriodId: qualificationRootAttempts.allowance_period_id,
  attemptId: qualificationRootAttempts.attempt_id,
  authSessionExpiresAt: qualificationRootAttempts.auth_session_expires_at,
  authSessionId: qualificationRootAttempts.auth_session_id,
  executionId: qualificationRootAttempts.execution_id,
  journey: qualificationRootAttempts.journey,
  offeredAt: qualificationRootAttempts.offered_at,
  planChecksum: qualificationRootAttempts.plan_checksum,
  rootId: qualificationRootAttempts.root_id,
  runId: qualificationRootAttempts.run_id,
  sessionId: qualificationRootAttempts.session_id,
  state: qualificationRootAttempts.state,
  submissionId: qualificationRootAttempts.submission_id,
  userId: qualificationRootAttempts.user_id,
};

const exactIdentity = (
  retained: Omit<QualificationAttemptIdentity, "offeredAt"> & { readonly offeredAt: Date },
  input: QualificationAttemptIdentity,
): boolean =>
  retained.agentId === input.agentId &&
  retained.allocationId === input.allocationId &&
  retained.allowancePeriodId === input.allowancePeriodId &&
  retained.attemptId === input.attemptId &&
  retained.authSessionExpiresAt.getTime() === input.authSessionExpiresAt.getTime() &&
  retained.authSessionId === input.authSessionId &&
  retained.executionId === input.executionId &&
  retained.journey === input.journey &&
  retained.offeredAt.getTime() === input.offeredAt.getTime() &&
  retained.planChecksum === input.planChecksum &&
  retained.rootId === input.rootId &&
  retained.runId === input.runId &&
  retained.sessionId === input.sessionId &&
  retained.submissionId === input.submissionId &&
  retained.userId === input.userId;

/** Durable correlation index written before effects and completed only from Agent authority. */
export const makeQualificationAttemptIndex = (database: Database) => {
  const claim = Effect.fn("QualificationAttemptIndex.claim")(
    (input: QualificationAttemptIdentity) =>
      attempt("claim", () =>
        database.transaction(async (transaction) => {
          const [inserted] = await transaction
            .insert(qualificationRootAttempts)
            .values({
              agent_id: input.agentId,
              allocation_id: input.allocationId,
              allowance_period_id: input.allowancePeriodId,
              attempt_id: input.attemptId,
              auth_session_expires_at: input.authSessionExpiresAt,
              auth_session_id: input.authSessionId,
              execution_id: input.executionId,
              journey: input.journey,
              offered_at: input.offeredAt,
              plan_checksum: input.planChecksum,
              root_id: input.rootId,
              run_id: input.runId,
              session_id: input.sessionId,
              state: "OFFERED",
              submission_id: input.submissionId,
              user_id: input.userId,
            })
            .onConflictDoNothing()
            .returning(selected);
          const retained =
            inserted ??
            (
              await transaction
                .select(selected)
                .from(qualificationRootAttempts)
                .where(eq(qualificationRootAttempts.attempt_id, input.attemptId))
                .limit(1)
            )[0];
          return retained !== undefined && exactIdentity(retained, input)
            ? ({
                row: retained,
                status: inserted === undefined ? ("EXISTING" as const) : ("CLAIMED" as const),
              } as const)
            : ({ status: "CONFLICT" as const } as const);
        }),
      ),
  );

  const recordDecision = Effect.fn("QualificationAttemptIndex.recordDecision")(
    (receipt: QualificationAdmissionReceipt) =>
      attempt("recordDecision", () =>
        database.transaction(async (transaction) => {
          const [retained] = await transaction
            .select(selected)
            .from(qualificationRootAttempts)
            .where(eq(qualificationRootAttempts.attempt_id, receipt.attemptId))
            .for("update")
            .limit(1);
          if (
            retained === undefined ||
            retained.executionId !== receipt.executionId ||
            retained.rootId !== receipt.rootId ||
            retained.runId !== receipt.runId ||
            retained.planChecksum !== receipt.planChecksum ||
            retained.agentId !== receipt.agentId
          ) {
            return "CONFLICT" as const;
          }
          if (retained.state === "DECIDED") {
            return retained.admissionDecision === receipt.admissionDecision &&
              retained.admissionFactId === receipt.productFactId &&
              retained.admissionObservedAt?.toISOString() === receipt.occurredAt
              ? ("EXISTING" as const)
              : ("CONFLICT" as const);
          }
          await transaction
            .update(qualificationRootAttempts)
            .set({
              admission_decision: receipt.admissionDecision,
              admission_fact_id: receipt.productFactId,
              admission_observed_at: new Date(receipt.occurredAt),
              state: "DECIDED",
            })
            .where(
              and(
                eq(qualificationRootAttempts.attempt_id, receipt.attemptId),
                eq(qualificationRootAttempts.state, "OFFERED"),
              ),
            );
          return "RECORDED" as const;
        }),
      ),
  );

  const readPage = Effect.fn("QualificationAttemptIndex.readPage")(
    (input: {
      readonly afterAttemptId: string;
      readonly executionId: string;
      readonly limit: number;
    }) =>
      attempt("readPage", () =>
        database
          .select(selected)
          .from(qualificationRootAttempts)
          .where(
            and(
              eq(qualificationRootAttempts.execution_id, input.executionId),
              gt(qualificationRootAttempts.attempt_id, input.afterAttemptId),
            ),
          )
          .orderBy(asc(qualificationRootAttempts.attempt_id))
          .limit(input.limit),
      ),
  );

  const readRoots = Effect.fn("QualificationAttemptIndex.readRoots")(
    (input: { readonly executionId: string; readonly rootIds: ReadonlyArray<string> }) =>
      input.rootIds.length === 0
        ? Effect.succeed([])
        : attempt("readRoots", () =>
            database
              .select(selected)
              .from(qualificationRootAttempts)
              .where(
                and(
                  eq(qualificationRootAttempts.execution_id, input.executionId),
                  inArray(qualificationRootAttempts.root_id, [...input.rootIds]),
                ),
              )
              .orderBy(asc(qualificationRootAttempts.root_id)),
          ),
  );

  return { claim, readPage, readRoots, recordDecision } as const;
};

const attempt = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new QualificationAttemptIndexUnavailable({
        cause,
        message: "Qualification root correlation authority is unavailable",
        operation,
      }),
  });

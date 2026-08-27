import { Effect } from "effect";

import type { AssistantMessageId, ThinkSubmissionId, UserId } from "../../domain";
import {
  type GoodRootOutcomeEvaluationId,
  GoodRootOutcomeReceipt,
  retainedGoodRootAssertionReceiptIds,
  retainedGoodRootTraceVersion,
} from "../../domain/personal-skill";
import type {
  Interface as PersonalSkillAuthority,
  PersonalSkillInvalid,
  PersonalSkillStoreUnavailable,
  SkillLearningConflict,
} from "./personal-skill-authority";

export interface RetainedGoodRootEvaluationInput {
  readonly assistantMessageId: AssistantMessageId;
  readonly evaluatedAtEpochMillis: number;
  readonly evaluationDeadlineEpochMillis: number;
  readonly submissionId: ThinkSubmissionId;
  readonly userId: UserId;
}

export interface GoodRootOutcomeEvaluatorDependencies {
  readonly authority: Pick<PersonalSkillAuthority, "retainGoodRootEvaluation">;
  readonly nextEvaluationId: () => GoodRootOutcomeEvaluationId;
}

/** Retain a PASS from the closed Reference Workload Trace evaluator authority. */
export const makeGoodRootOutcomeEvaluator = ({
  authority,
  nextEvaluationId,
}: GoodRootOutcomeEvaluatorDependencies) => ({
  retainPass: Effect.fn("GoodRootOutcomeEvaluator.retainPass")(function* (
    input: RetainedGoodRootEvaluationInput,
  ): Effect.fn.Return<
    {
      readonly evaluationId: GoodRootOutcomeEvaluationId;
      readonly userId: UserId;
    },
    PersonalSkillInvalid | PersonalSkillStoreUnavailable | SkillLearningConflict
  > {
    const evaluationId = nextEvaluationId();
    const receipt = GoodRootOutcomeReceipt.make({
      assertionReceiptIds: retainedGoodRootAssertionReceiptIds,
      assistantMessageId: input.assistantMessageId,
      evaluatedAtEpochMillis: input.evaluatedAtEpochMillis,
      evaluationDeadlineEpochMillis: input.evaluationDeadlineEpochMillis,
      referenceTraceVersion: retainedGoodRootTraceVersion,
      submissionId: input.submissionId,
      userId: input.userId,
    });
    yield* authority.retainGoodRootEvaluation({
      evaluationId,
      receipt,
      retainedAtEpochMillis: input.evaluatedAtEpochMillis,
    });
    return { evaluationId, userId: input.userId };
  }),
});

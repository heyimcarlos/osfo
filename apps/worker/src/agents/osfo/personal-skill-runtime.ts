import type { UIMessage } from "ai";
import { Effect, Option, Result, Schema } from "effect";

/* oxlint-disable eslint/no-underscore-dangle -- Runtime outcomes and authority failures are tagged unions. */

import type { UserId } from "../../domain";
import type { ManagedTurnAuthorityIdentity } from "../../domain/managed-conversation";
import {
  GoodRootOutcomeEvaluationReference,
  PersonalSkillId,
  PersonalSkillVersionId,
  type SkillLearningCandidate,
  type SkillTurnOrigin,
} from "../../domain/personal-skill";
import type { CommittedTurnReceipt } from "./db/store";
import { readCommittedTurnTerminal } from "./committed-turn-terminal";
import { ManagedCapabilityState } from "./managed-capability-turn-state";
import type { Interface as PersonalSkillAuthority } from "./personal-skill-authority";
import { finalizeSkillLearningCandidate } from "./post-turn-skill-learning";

export type GoodRootLearningIngestion =
  | { readonly _tag: "GoodRootOutcomeRejected"; readonly reason: string }
  | { readonly _tag: "NoReusableLearning"; readonly submissionId: string }
  | { readonly _tag: "SkillLearningDeferred"; readonly reason: "backpressure" }
  | {
      readonly _tag: "SkillLearningQueued";
      readonly candidate: SkillLearningCandidate;
      readonly candidateId: string;
    };

export interface IngestGoodRootEvaluationInput {
  readonly authority: Pick<PersonalSkillAuthority, "enqueueLearning" | "resolveGoodRootEvaluation">;
  readonly committedTurns: ReadonlyArray<CommittedTurnReceipt>;
  readonly messages: ReadonlyArray<UIMessage>;
  readonly nowEpochMillis: number;
  readonly reference: typeof GoodRootOutcomeEvaluationReference.Encoded;
}

/** Bind a retained evaluator PASS to its exact successful committed root turn and enqueue learning. */
export const ingestGoodRootEvaluation = Effect.fn("PersonalSkillRuntime.ingestGoodRootEvaluation")(
  function* ({
    authority,
    committedTurns,
    messages,
    nowEpochMillis,
    reference,
  }: IngestGoodRootEvaluationInput) {
    const evaluation = yield* Schema.decodeEffect(GoodRootOutcomeEvaluationReference)(reference);
    const receipt = yield* authority.resolveGoodRootEvaluation(evaluation);
    const turn = messages
      .map(ManagedCapabilityState.readManagedTurn)
      .find(
        (metadata) =>
          metadata?.submissionId === receipt.submissionId &&
          metadata.authorityIdentity.userId === receipt.userId,
      );
    if (turn === undefined) {
      return { _tag: "GoodRootOutcomeRejected", reason: "turnIdentity" } as const;
    }
    const assistant = messages.find(
      (message) => message.role === "assistant" && message.id === receipt.assistantMessageId,
    );
    const terminal = readCommittedTurnTerminal(assistant?.metadata);
    if (
      Option.isNone(terminal) ||
      terminal.value.status !== "completed" ||
      terminal.value.submissionId !== receipt.submissionId ||
      terminal.value.attribution?.userId !== receipt.userId ||
      terminal.value.attribution.sessionId !== turn.sessionId
    ) {
      return { _tag: "GoodRootOutcomeRejected", reason: "rootTerminal" } as const;
    }
    const committed = committedTurns.some(
      ({ assistantMessageId, sessionId, thinkRequestId }) =>
        assistantMessageId === receipt.assistantMessageId &&
        sessionId === turn.sessionId &&
        thinkRequestId === terminal.value.requestId,
    );
    if (!committed) {
      return { _tag: "GoodRootOutcomeRejected", reason: "rootNotCommitted" } as const;
    }
    const retainedDraft = turn.capabilityTurnState.skillLearningDraft;
    if (retainedDraft === null) {
      return { _tag: "NoReusableLearning", submissionId: receipt.submissionId } as const;
    }
    const prior = turn.capabilityTurnState.loadedSkillReceipts.find(
      ({ source }) => source === "personal",
    );
    const candidate = finalizeSkillLearningCandidate(
      {
        ...retainedDraft,
        origin: capabilityTurnOrigin(turn.authorityIdentity),
        ownerUserId: receipt.userId,
        priorSkillId: prior === undefined ? null : PersonalSkillId.make(prior.skillId),
        priorSkillVersion:
          prior === undefined ? null : PersonalSkillVersionId.make(prior.skillVersion),
        submissionId: receipt.submissionId,
      },
      receipt,
      nowEpochMillis,
    );
    if (Result.isFailure(candidate)) {
      return { _tag: "GoodRootOutcomeRejected", reason: "candidate" } as const;
    }
    const queued = yield* authority.enqueueLearning(candidate.success);
    if (queued._tag === "Backpressured") {
      return { _tag: "SkillLearningDeferred", reason: "backpressure" } as const;
    }
    return {
      _tag: "SkillLearningQueued",
      candidate: candidate.success,
      candidateId: queued.candidateId,
    } as const;
  },
);

export interface SelectPersonalSkillsInput {
  readonly authority: Pick<PersonalSkillAuthority, "active" | "pin">;
  readonly eligible: ReadonlyArray<{ readonly skillId: string; readonly skillVersion: string }>;
  readonly firstInitialization: boolean;
  readonly userId: UserId;
}

/** Load the initial active set or exact retained pins; storage failure safely selects no Skills. */
export const selectPersonalSkillsForTurn = ({
  authority,
  eligible,
  firstInitialization,
  userId,
}: SelectPersonalSkillsInput) =>
  (firstInitialization
    ? authority.active(userId)
    : Effect.forEach(eligible, ({ skillId, skillVersion }) =>
        authority.pin({
          skillId: PersonalSkillId.make(skillId),
          skillVersion: PersonalSkillVersionId.make(skillVersion),
          userId,
        }),
      )
  ).pipe(
    Effect.catch((failure) =>
      Effect.logWarning("Personal Skill selection is unavailable for this turn").pipe(
        Effect.annotateLogs({ failure: failure._tag }),
        Effect.as([]),
      ),
    ),
  );

/** Recover bounded unsettled learning after an Agent activation; failure cannot fail the Agent. */
export const recoverPersonalSkillLearning = (
  authority: Pick<PersonalSkillAuthority, "recoverableLearning">,
  nowEpochMillis: number,
) =>
  authority
    .recoverableLearning(nowEpochMillis)
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning("Recoverable personal Skill Learning could not be read").pipe(
          Effect.annotateLogs({ failure: failure._tag }),
          Effect.as([]),
        ),
      ),
    );

const capabilityTurnOrigin = (identity: ManagedTurnAuthorityIdentity): SkillTurnOrigin => {
  if (identity._tag === "AuthSession") return "authSession";
  if (identity._tag === "ChannelLink") return "channelLink";
  return identity.triggerType;
};

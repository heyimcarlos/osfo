import type { UIMessage } from "ai";
import { Effect, Option, Schema } from "effect";

import type { AssistantMessageId } from "../../domain";
import { currentCapabilityCatalog } from "../../domain/capability-catalog";
import {
  GoodRootOutcomeEvaluationId,
  GoodRootOutcomeReceipt,
  retainedGoodRootAssertionReceiptIds,
  retainedGoodRootTraceVersion,
} from "../../domain/personal-skill";
import { readCommittedTurnTerminal } from "./committed-turn-terminal";
import type { CommittedTurnReceipt } from "./db/store";
import { ManagedCapabilityState } from "./managed-capability-turn-state";
import type { GoodRootOutcomeEvaluatorAuthority } from "./personal-skill-authority";

export interface EvaluateGoodRootOutcomeInput {
  readonly assistantMessageId: AssistantMessageId;
  readonly evaluatedAtEpochMillis: number;
}

export interface GoodRootOutcomeEvaluatorFacts<E> {
  readonly readCommittedTurns: Effect.Effect<ReadonlyArray<CommittedTurnReceipt>, E>;
  readonly readMessages: () => ReadonlyArray<UIMessage>;
}

/** Evaluate the closed retained trace and mint a PASS only when every assertion is present. */
export const makeGoodRootOutcomeEvaluator = <E>({
  authority,
  facts,
}: {
  readonly authority: GoodRootOutcomeEvaluatorAuthority;
  readonly facts: GoodRootOutcomeEvaluatorFacts<E>;
}) => ({
  evaluate: Effect.fn("GoodRootOutcomeEvaluator.evaluate")(function* (
    input: EvaluateGoodRootOutcomeInput,
  ) {
    const messages = facts.readMessages();
    const committedTurns = yield* facts.readCommittedTurns;
    const assistant = messages.find(
      (message) => message.role === "assistant" && message.id === input.assistantMessageId,
    );
    const terminal = readCommittedTurnTerminal(assistant?.metadata);
    if (
      Option.isNone(terminal) ||
      terminal.value.status !== "completed" ||
      terminal.value.submissionId === undefined ||
      terminal.value.attribution === undefined
    ) {
      return Option.none();
    }
    const turn = messages
      .map(ManagedCapabilityState.readManagedTurn)
      .find(
        (metadata) =>
          metadata !== undefined &&
          metadata.submissionId === terminal.value.submissionId &&
          metadata.authorityIdentity.userId === terminal.value.attribution?.userId &&
          metadata.sessionId === terminal.value.attribution?.sessionId,
      );
    if (turn === undefined || turn.capabilityTurnState.skillLearningDraft === null) {
      return Option.none();
    }
    const committed = committedTurns.some(
      ({ assistantMessageId, sessionId, thinkRequestId }) =>
        assistantMessageId === input.assistantMessageId &&
        sessionId === turn.sessionId &&
        thinkRequestId === terminal.value.requestId,
    );
    if (!committed) return Option.none();

    const evaluationId = GoodRootOutcomeEvaluationId.make(input.assistantMessageId);
    const receipt = GoodRootOutcomeReceipt.make({
      assertionReceiptIds: retainedGoodRootAssertionReceiptIds,
      assistantMessageId: input.assistantMessageId,
      evaluatedAtEpochMillis: input.evaluatedAtEpochMillis,
      evaluationDeadlineEpochMillis:
        input.evaluatedAtEpochMillis +
        currentCapabilityCatalog.skillLearning.candidateLifetimeMilliseconds,
      ownedArtifactContentIds: ownedPresentationContentIds(assistant),
      referenceTraceVersion: retainedGoodRootTraceVersion,
      submissionId: turn.submissionId,
      userId: turn.authorityIdentity.userId,
    });
    yield* authority.retainVerified({
      evaluationId,
      receipt,
      retainedAtEpochMillis: input.evaluatedAtEpochMillis,
    });
    return Option.some({ evaluationId, userId: receipt.userId });
  }),
});

/** Retain only trusted immutable presentation identities, never Tool payloads or slide content. */
const ownedPresentationContentIds = (assistant: UIMessage | undefined): ReadonlyArray<string> => {
  if (assistant === undefined) return [];
  return assistant.parts
    .flatMap((part) =>
      Schema.decodeUnknownOption(OwnedPresentationToolPart)(part).pipe(
        Option.match({
          onNone: () => [],
          onSome: ({ output }) => [output.content.contentId],
        }),
      ),
    )
    .slice(0, 4);
};

const OwnedPresentationToolPart = Schema.Struct({
  output: Schema.Struct({
    artifactRole: Schema.TaggedStruct("GeneratedPresentationV1", {}),
    content: Schema.Struct({
      contentId: Schema.String.check(Schema.isPattern(/^artifact:/u)),
    }),
  }),
  type: Schema.Literals(["tool-generatePresentation", "tool-revisePresentation"]),
});

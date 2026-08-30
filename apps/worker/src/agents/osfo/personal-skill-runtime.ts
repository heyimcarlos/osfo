import { DateTime, Effect, Option, Result, Schema } from "effect";

/* oxlint-disable eslint/no-underscore-dangle -- Runtime outcomes and authority failures are tagged unions. */

import type { AssistantMessageId, UserId } from "../../domain";
import { currentCapabilityCatalog } from "../../domain/capability-catalog";
import {
  PersonalSkillId,
  PersonalSkillVersionId,
  SkillLearningCandidate,
  SkillLearningCandidateId,
  completedSkillLearningTurnReferenceId,
} from "../../domain/personal-skill";
import type { CommittedTurnReceipt, CommittedTurnWindow } from "./db/store";
import { readCommittedTurnTerminal } from "./committed-turn-terminal";
import { ManagedCapabilityState } from "./managed-capability-turn-state";
import type { Interface as PersonalSkillAuthority } from "./personal-skill-authority";

/** Maximum recent committed turns whose owning histories may be inspected per activation. */
export const maximumSkillLearningReplayTurns = 20;

interface SkillLearningHistoryMessage {
  readonly id: string;
  readonly metadata?: unknown;
  readonly parts: ReadonlyArray<unknown>;
  readonly role: string;
}

/** Select the inclusive durable-time window whose newest turns may need enqueue replay. */
export const skillLearningReplayWindow = (nowEpochMillis: number): CommittedTurnWindow => ({
  limit: maximumSkillLearningReplayTurns,
  observedAfter: sqliteTimestamp(
    nowEpochMillis - currentCapabilityCatalog.skillLearning.candidateLifetimeMilliseconds,
  ),
  observedAtOrBefore: sqliteTimestamp(nowEpochMillis),
});

export type SkillLearningIngestion =
  | { readonly _tag: "SkillLearningRejected"; readonly reason: string }
  | { readonly _tag: "NoReusableLearning"; readonly submissionId: string }
  | { readonly _tag: "SkillLearningDeferred"; readonly reason: "backpressure" }
  | { readonly _tag: "SkillLearningAlreadyQueued"; readonly candidateId: string }
  | {
      readonly _tag: "SkillLearningQueued";
      readonly candidate: SkillLearningCandidate;
      readonly candidateId: string;
    };

export interface IngestCompletedSkillLearningTurnInput {
  readonly assistantMessageId: AssistantMessageId;
  readonly authority: Pick<PersonalSkillAuthority, "enqueueLearning">;
  readonly committedTurns: ReadonlyArray<CommittedTurnReceipt>;
  readonly messages: ReadonlyArray<SkillLearningHistoryMessage>;
}

/** Enqueue direct User Skill Learning from its exact completed committed turn. */
export const ingestCompletedSkillLearningTurn = Effect.fn(
  "PersonalSkillRuntime.ingestCompletedSkillLearningTurn",
)(function* ({
  assistantMessageId,
  authority,
  committedTurns,
  messages,
}: IngestCompletedSkillLearningTurnInput) {
  const assistant = messages.find(
    (message) => message.role === "assistant" && message.id === assistantMessageId,
  );
  const terminal = readCommittedTurnTerminal(assistant?.metadata);
  if (
    Option.isNone(terminal) ||
    terminal.value.status !== "completed" ||
    terminal.value.submissionId === undefined ||
    terminal.value.attribution === undefined
  ) {
    return { _tag: "SkillLearningRejected", reason: "rootTerminal" } as const;
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
  if (turn === undefined) {
    return { _tag: "SkillLearningRejected", reason: "turnIdentity" } as const;
  }
  if (
    turn.authorityIdentity._tag !== "AuthSession" &&
    turn.authorityIdentity._tag !== "ChannelLink"
  ) {
    return { _tag: "SkillLearningRejected", reason: "turnOrigin" } as const;
  }
  const committed = committedTurns.find(
    ({ assistantMessageId: committedAssistantMessageId, sessionId, thinkRequestId }) =>
      committedAssistantMessageId === assistantMessageId &&
      sessionId === turn.sessionId &&
      thinkRequestId === terminal.value.requestId,
  );
  if (committed === undefined) {
    return { _tag: "SkillLearningRejected", reason: "rootNotCommitted" } as const;
  }
  const retainedDraft = turn.capabilityTurnState.skillLearningDraft;
  if (retainedDraft === null) {
    return { _tag: "NoReusableLearning", submissionId: turn.submissionId } as const;
  }
  const prior = turn.capabilityTurnState.loadedSkillReceipts.find(
    ({ source }) => source === "personal",
  );
  const createdAtEpochMillis = DateTime.toEpochMillis(
    DateTime.makeUnsafe(`${committed.observedAt.replace(" ", "T")}Z`),
  );
  const rootOutcomeReferenceId = completedSkillLearningTurnReferenceId(
    turn.submissionId,
    assistantMessageId,
  );
  const unencodedCandidate = {
    availableCapabilityIds: retainedDraft.availableCapabilityIds,
    availableRequirements: retainedDraft.availableRequirements,
    candidateBytes: "1",
    candidateId: SkillLearningCandidateId.make(`turn-${turn.submissionId}`),
    corrections: [retainedDraft.taskDescription],
    createdAtEpochMillis,
    decisions: [],
    evidence: [
      { _tag: "UserDecision" as const, referenceId: turn.submissionId },
      { _tag: "CompletedDirectUserTurn" as const, referenceId: rootOutcomeReferenceId },
      ...ownedPresentationContentIds(assistant).map((referenceId) => ({
        _tag: "OwnedArtifact" as const,
        referenceId,
      })),
    ],
    ownerUserId: turn.authorityIdentity.userId,
    priorSkillId: prior === undefined ? null : PersonalSkillId.make(prior.skillId),
    priorSkillVersion: prior === undefined ? null : PersonalSkillVersionId.make(prior.skillVersion),
    rootAssistantMessageId: assistantMessageId,
    rootOutcomeReferenceId,
    taskDescription: retainedDraft.taskDescription,
  };
  const candidate = Schema.decodeResult(SkillLearningCandidate, { onExcessProperty: "error" })({
    ...unencodedCandidate,
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This measures a bounded trusted envelope and does not parse untrusted JSON.
    candidateBytes: String(new TextEncoder().encode(JSON.stringify(unencodedCandidate)).byteLength),
  });
  if (Result.isFailure(candidate)) {
    return { _tag: "SkillLearningRejected", reason: "candidate" } as const;
  }
  const queued = yield* authority.enqueueLearning(candidate.success);
  if (queued._tag === "Backpressured") {
    return { _tag: "SkillLearningDeferred", reason: "backpressure" } as const;
  }
  if (queued._tag === "AlreadyQueued") {
    return { _tag: "SkillLearningAlreadyQueued", candidateId: queued.candidateId } as const;
  }
  return {
    _tag: "SkillLearningQueued",
    candidate: candidate.success,
    candidateId: queued.candidateId,
  } as const;
});

export interface ReplayCommittedSkillLearningTurnsInput<E> {
  readonly authority: Pick<PersonalSkillAuthority, "enqueueLearning">;
  readonly committedTurns: ReadonlyArray<CommittedTurnReceipt>;
  readonly nowEpochMillis: number;
  readonly readSessionHistory: (
    sessionId: CommittedTurnReceipt["sessionId"],
  ) => Effect.Effect<ReadonlyArray<SkillLearningHistoryMessage>, E>;
}

/** Replay the bounded committed-turn crash window before recovering retained candidates. */
export const replayCommittedSkillLearningTurns = Effect.fn(
  "PersonalSkillRuntime.replayCommittedSkillLearningTurns",
)(function* <E>({
  authority,
  committedTurns,
  nowEpochMillis,
  readSessionHistory,
}: ReplayCommittedSkillLearningTurnsInput<E>) {
  const oldestReplayEpochMillis =
    nowEpochMillis - currentCapabilityCatalog.skillLearning.candidateLifetimeMilliseconds;
  const replayable = committedTurns
    .filter(({ observedAt }) => {
      const observedAtEpochMillis = committedTurnEpochMillis(observedAt);
      return (
        observedAtEpochMillis >= oldestReplayEpochMillis && observedAtEpochMillis <= nowEpochMillis
      );
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; filter returns a fresh array.
    .sort(
      (left, right) =>
        left.observationSequence - right.observationSequence ||
        left.assistantMessageId.localeCompare(right.assistantMessageId),
    )
    .slice(-maximumSkillLearningReplayTurns);
  const sessionIds = [...new Set(replayable.map(({ sessionId }) => sessionId))];
  const histories = yield* Effect.forEach(sessionIds, (sessionId) =>
    readSessionHistory(sessionId).pipe(Effect.map((messages) => ({ messages, sessionId }))),
  );
  return yield* Effect.forEach(replayable, (committed) => {
    const history = histories.find(({ sessionId }) => sessionId === committed.sessionId);
    if (history === undefined) return Effect.die(new Error("Replay Session history was not read"));
    return ingestCompletedSkillLearningTurn({
      assistantMessageId: committed.assistantMessageId,
      authority,
      committedTurns: [committed],
      messages: history.messages,
    });
  });
});

/** Retain only trusted presentation identities, never Tool payloads or slide content. */
const ownedPresentationContentIds = (
  assistant: SkillLearningHistoryMessage | undefined,
): ReadonlyArray<string> => {
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

const committedTurnEpochMillis = (observedAt: string): number =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`${observedAt.replace(" ", "T")}Z`));

const sqliteTimestamp = (epochMillis: number): string =>
  DateTime.toDateUtc(DateTime.makeUnsafe(epochMillis)).toISOString().slice(0, 19).replace("T", " ");

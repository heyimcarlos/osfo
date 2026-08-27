/* oxlint-disable effecttsgo/crypto-random-uuid -- UUIDs are opaque durable identities, not deterministic test inputs. */
/* oxlint-disable eslint/no-underscore-dangle -- Domain tagged unions use _tag. */

import { Option, Result, Schema } from "effect";

import type { UserId } from "../../domain";
import { CapabilityId } from "../../domain/capability-catalog";
import {
  PersonalSkillId,
  PersonalSkillVersion,
  PersonalSkillVersionId,
  SkillDescriptionText,
  SkillKeywordText,
  SkillLearningCandidate,
  SkillLearningCandidateId,
  SkillTaskDescriptionText,
  TrustedSkillLearningText,
  GoodRootOutcomeReceipt,
  goodRootOutcomeReferenceId,
  type SkillTaskKind,
  type SkillTurnOrigin,
} from "../../domain/personal-skill";
import type { SkillLearningModelInput, SkillLearningProposal } from "./skill-learning-coordinator";

export interface SkillLearningDraft {
  readonly availableCapabilityIds: ReadonlyArray<CapabilityId>;
  readonly availableRequirements: ReadonlyArray<PersonalSkillVersion["requirements"][number]>;
  readonly origin: SkillTurnOrigin;
  readonly ownerUserId: UserId;
  readonly priorSkillId: PersonalSkillId | null;
  readonly priorSkillVersion: PersonalSkillVersionId | null;
  readonly submissionId: string;
  readonly taskDescription: string;
}

/** Narrow semantic decision returned by the isolated learning model. Identity stays deterministic. */
export const SkillLearningModelDecision = Schema.TaggedUnion({
  Change: {
    description: SkillDescriptionText,
    instructions: TrustedSkillLearningText,
    keywords: Schema.Array(SkillKeywordText).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    materiality: Schema.Literals(["material", "minor"]),
  },
  NoChange: {},
});

/** Narrow semantic decision returned by the isolated learning model. Identity stays deterministic. */
export type SkillLearningModelDecision = typeof SkillLearningModelDecision.Type;

const lastingInstruction =
  /\b(?:always|from now on|for future|going forward|make this (?:a )?skill|remember this as (?:a )?skill)\b/iu;

/** Admit only an explicit lasting instruction from the current direct User request. */
export const projectSkillLearningDraft = (
  input: SkillLearningDraft,
): Option.Option<SkillLearningDraft> =>
  lastingInstruction.test(input.taskDescription) &&
  Result.isSuccess(Schema.decodeResult(SkillTaskDescriptionText)(input.taskDescription))
    ? Option.some(input)
    : Option.none();

/** Finalize a bounded candidate only after the root assistant outcome has committed. */
export const finalizeSkillLearningCandidate = (
  draft: SkillLearningDraft,
  input: typeof GoodRootOutcomeReceipt.Encoded,
  nowEpochMillis: number,
): Result.Result<SkillLearningCandidate, Schema.SchemaError> => {
  const decodedOutcome = Schema.decodeResult(GoodRootOutcomeReceipt, {
    onExcessProperty: "error",
  })(input);
  if (Result.isFailure(decodedOutcome)) return Result.fail(decodedOutcome.failure);
  const goodRootOutcome = decodedOutcome.success;
  if (
    draft.submissionId !== goodRootOutcome.submissionId ||
    draft.ownerUserId !== goodRootOutcome.userId
  ) {
    return Schema.decodeUnknownResult(SkillLearningCandidate)({});
  }
  const rootOutcomeReferenceId = goodRootOutcomeReferenceId(goodRootOutcome);
  const unencoded = {
    availableCapabilityIds: draft.availableCapabilityIds,
    availableRequirements: draft.availableRequirements,
    candidateBytes: "1",
    candidateId: SkillLearningCandidateId.make(`turn-${draft.submissionId}`),
    corrections: [draft.taskDescription],
    createdAtEpochMillis: nowEpochMillis,
    decisions: [],
    evidence: [
      { _tag: "UserDecision" as const, referenceId: draft.submissionId },
      { _tag: "ConfirmedRootOutcome" as const, referenceId: rootOutcomeReferenceId },
    ],
    ownerUserId: draft.ownerUserId,
    priorSkillId: draft.priorSkillId,
    priorSkillVersion: draft.priorSkillVersion,
    rootAssistantMessageId: goodRootOutcome.assistantMessageId,
    rootOutcomeReferenceId,
    taskDescription: draft.taskDescription,
  };
  return Schema.decodeResult(SkillLearningCandidate, { onExcessProperty: "error" })({
    ...unencoded,
    candidateBytes: String(new TextEncoder().encode(JSON.stringify(unencoded)).byteLength),
  });
};

/** Conservative closed proposal used for explicit User-confirmed learning. */
export const proposeConfirmedSkillChange = ({
  candidate,
  priorVersion,
}: Omit<SkillLearningModelInput, "attemptId">): SkillLearningProposal => {
  const correction = candidate.corrections.join("\n");
  if (priorVersion !== null && priorVersion.instructions.includes(correction)) {
    return {
      _tag: "NoChange",
    };
  }
  const taskKind = inferTaskKind(candidate.taskDescription);
  const evidence = candidate.evidence;
  const revision = priorVersion === null ? 1 : priorVersion.revision + 1;
  const version = PersonalSkillVersion.make({
    allowedOrigins: priorVersion?.allowedOrigins ?? ["authSession", "channelLink"],
    capabilityIds: priorVersion?.capabilityIds ?? [capabilityFor(taskKind)],
    createdAtEpochMillis: priorVersion?.createdAtEpochMillis ?? candidate.createdAtEpochMillis,
    createdBy: "learning",
    creationEvidence: priorVersion?.creationEvidence ?? evidence,
    description:
      priorVersion?.description ??
      `Reusable preference for ${candidate.taskDescription.slice(0, 180)}`,
    instructions:
      priorVersion === null ? correction : `${priorVersion.instructions}\n\n${correction}`,
    keywords: priorVersion?.keywords ?? keywords(candidate.taskDescription),
    lastUsedAtEpochMillis: priorVersion?.lastUsedAtEpochMillis ?? null,
    origin: "learned",
    outcomeFacts: {
      confirmedFailures: priorVersion?.outcomeFacts.confirmedFailures ?? 0,
      confirmedSuccesses: (priorVersion?.outcomeFacts.confirmedSuccesses ?? 0) + 1,
    },
    ownerUserId: candidate.ownerUserId,
    parentSkillVersion: priorVersion?.skillVersion ?? null,
    requirements: priorVersion?.requirements ?? ["personal-agent"],
    revision,
    skillId: priorVersion?.skillId ?? PersonalSkillId.make(`skill-${crypto.randomUUID()}`),
    skillVersion: PersonalSkillVersionId.make(`v${revision}-${crypto.randomUUID()}`),
    status: "active",
    taskDescription: priorVersion?.taskDescription ?? candidate.taskDescription,
    taskKinds: priorVersion?.taskKinds ?? [taskKind],
    updatedAtEpochMillis: candidate.createdAtEpochMillis,
    updateEvidence: priorVersion === null ? [] : evidence,
  });
  return {
    _tag: "Change",
    evidence: "explicitConfirmation",
    materiality: "material",
    skillsChanged: 1,
    version,
  };
};

/** Bind a decoded model decision to deterministic identity, evidence, and measured provider usage. */
export const bindSkillLearningModelDecision = (
  input: SkillLearningModelInput,
  decision: SkillLearningModelDecision,
): SkillLearningProposal => {
  if (decision._tag === "NoChange") return { _tag: "NoChange" };
  const deterministic = proposeConfirmedSkillChange(input);
  if (deterministic._tag === "NoChange") return { _tag: "NoChange" };
  return {
    ...deterministic,
    materiality: decision.materiality,
    version: PersonalSkillVersion.make({
      ...deterministic.version,
      description: decision.description,
      instructions: decision.instructions,
      keywords: decision.keywords,
    }),
  };
};

const inferTaskKind = (description: string): SkillTaskKind => {
  if (/\b(?:pdf|document|report|docx|slides?|presentation|deck)\b/iu.test(description)) {
    return "document";
  }
  if (/\b(?:research|investigate|sources?)\b/iu.test(description)) return "research";
  if (/\b(?:file|upload|attachment)\b/iu.test(description)) return "file";
  if (/\b(?:memory|remember|forget)\b/iu.test(description)) return "memory";
  return "conversation";
};

const capabilityFor = (taskKind: SkillTaskKind): CapabilityId => {
  if (taskKind === "document") return CapabilityId.make("document-generation");
  if (taskKind === "research") return CapabilityId.make("research-report");
  if (taskKind === "file") return CapabilityId.make("file-read");
  if (taskKind === "memory") return CapabilityId.make("core-memory");
  return CapabilityId.make("conversation");
};

const keywords = (description: string): ReadonlyArray<string> => {
  const selected = description
    .toLocaleLowerCase("en-US")
    .match(/[a-z0-9]{4,}/gu)
    ?.filter((word) => !lastingInstruction.test(word))
    .slice(0, 12);
  return selected === undefined || selected.length === 0 ? ["preference"] : [...new Set(selected)];
};

export * as PostTurnSkillLearning from "./post-turn-skill-learning";

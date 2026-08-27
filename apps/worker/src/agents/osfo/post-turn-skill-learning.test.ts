/* oxlint-disable eslint/no-underscore-dangle -- Effect Result and proposal unions use _tag. */
/* oxlint-disable typescript/no-misused-spread -- Test fixtures copy decoded immutable schema values intentionally. */

import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { AssistantMessageId, ThinkSubmissionId, UserId } from "../../domain";
import { PersonalSkillId, PersonalSkillVersionId } from "../../domain/personal-skill";
import {
  finalizeSkillLearningCandidate,
  projectSkillLearningDraft,
  proposeConfirmedSkillChange,
} from "./post-turn-skill-learning";

const draft = {
  availableCapabilityIds: ["document-generation" as const],
  availableRequirements: ["personal-agent" as const],
  origin: "channelLink" as const,
  ownerUserId: UserId.make("user-1"),
  priorSkillId: null,
  priorSkillVersion: null,
  submissionId: "submission-1",
  taskDescription: "Going forward, put the summary first in every weekly report.",
};
const goodRootOutcome = {
  assertionReceiptIds: ["assertion-1"],
  assistantMessageId: AssistantMessageId.make("assistant-1"),
  evaluatedAtEpochMillis: 1_788_000_000_000,
  evaluationDeadlineEpochMillis: 1_788_000_001_000,
  referenceTraceVersion: "skill-learning-v1",
  submissionId: ThinkSubmissionId.make("submission-1"),
  userId: UserId.make("user-1"),
} as const;

describe("post-turn Skill Learning", () => {
  it("admits only explicit lasting safe direct User guidance", () => {
    expect(Option.isSome(projectSkillLearningDraft(draft))).toBe(true);
    expect(
      Option.isNone(
        projectSkillLearningDraft({
          ...draft,
          taskDescription: "Create this week's report.",
        }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        projectSkillLearningDraft({
          ...draft,
          taskDescription: "Going forward, use Authorization: Bearer malicious-secret.",
        }),
      ),
    ).toBe(true);
  });

  it("finalizes after root commit and proposes a safe immutable revision", () => {
    const candidate = finalizeSkillLearningCandidate(draft, goodRootOutcome, 1_788_000_000_000);
    expect(Result.isSuccess(candidate)).toBe(true);
    if (Result.isFailure(candidate)) return;
    expect(candidate.success.rootOutcomeReferenceId).toContain("good-root:skill-learning-v1");

    const created = proposeConfirmedSkillChange({
      candidate: candidate.success,
      priorVersion: null,
    });
    expect(created._tag).toBe("Change");
    if (created._tag !== "Change") return;
    expect(created.version.taskKinds).toEqual(["document"]);
    expect(created.version.capabilityIds).toEqual(["document-generation"]);

    const revisionCandidate = {
      ...candidate.success,
      candidateId: candidate.success.candidateId,
      priorSkillId: created.version.skillId,
      priorSkillVersion: created.version.skillVersion,
    };
    const revised = proposeConfirmedSkillChange({
      candidate: revisionCandidate,
      priorVersion: created.version,
    });
    expect(revised._tag).toBe("NoChange");

    expect(PersonalSkillId.make(created.version.skillId)).toBe(created.version.skillId);
    expect(PersonalSkillVersionId.make(created.version.skillVersion)).toBe(
      created.version.skillVersion,
    );
  });

  it("rejects expired or mismatched Good Root Outcome receipts", () => {
    expect(
      Result.isFailure(
        finalizeSkillLearningCandidate(
          draft,
          {
            ...goodRootOutcome,
            evaluatedAtEpochMillis: goodRootOutcome.evaluationDeadlineEpochMillis + 1,
          },
          1_788_000_000_000,
        ),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        finalizeSkillLearningCandidate(
          draft,
          { ...goodRootOutcome, submissionId: ThinkSubmissionId.make("submission-other") },
          1_788_000_000_000,
        ),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        finalizeSkillLearningCandidate(
          draft,
          { ...goodRootOutcome, userId: UserId.make("user-other") },
          1_788_000_000_000,
        ),
      ),
    ).toBe(true);
  });
});

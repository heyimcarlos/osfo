/* oxlint-disable eslint/no-underscore-dangle -- Effect Result and proposal unions use _tag. */
/* oxlint-disable typescript/no-misused-spread -- Test fixtures copy decoded immutable schema values intentionally. */

import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { UserId } from "../../domain";
import { PersonalSkillId, PersonalSkillVersionId } from "../../domain/personal-skill";
import {
  finalizeSkillLearningCandidate,
  projectSkillLearningDraft,
  proposeConfirmedSkillChange,
} from "./post-turn-skill-learning";

const draft = {
  origin: "channelLink" as const,
  ownerUserId: UserId.make("user-1"),
  priorSkillId: null,
  priorSkillVersion: null,
  submissionId: "submission-1",
  taskDescription: "Going forward, put the summary first in every weekly report.",
};

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
    const candidate = finalizeSkillLearningCandidate(draft, "assistant-1", 1_788_000_000_000);
    expect(Result.isSuccess(candidate)).toBe(true);
    if (Result.isFailure(candidate)) return;
    expect(candidate.success.rootOutcomeReferenceId).toBe("assistant-1");

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
});

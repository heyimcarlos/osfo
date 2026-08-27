/* oxlint-disable eslint/no-underscore-dangle -- Effect errors use the standard _tag discriminator. */

import {
  type SkillChangeRequest,
  type SkillChangeResponse,
  type SkillDeletionPresentation,
  type SkillDeletionRequest,
  type SkillSummary,
  type SkillsSummary,
  skillDeletionConfirmation,
  skillDeletionPresentationVersion,
} from "@osfo/api";
import { DateTime, Effect, Schema } from "effect";

import type { UserId } from "../../domain";
import {
  PersonalSkillId,
  type PersonalSkillVersion,
  PersonalSkillVersionId,
} from "../../domain/personal-skill";
import { catalogSnapshotsFor } from "../../services/capability-catalog-snapshot";
import type {
  Interface as PersonalSkillAuthority,
  PersonalSkillAvailability,
} from "./personal-skill-authority";

/** Rejected destructive decision that does not reproduce the current server presentation. */
export class PersonalSkillApprovalInvalid extends Schema.TaggedError<PersonalSkillApprovalInvalid>()(
  "PersonalSkillApprovalInvalid",
  { message: Schema.String },
) {}

/** User-scoped web controls backed by the same immutable Skill authority as conversation Tools. */
export const makePersonalSkillControl = (dependencies: {
  readonly authority: PersonalSkillAuthority;
  readonly availability: () => PersonalSkillAvailability;
  readonly decisionReference: () => string;
  readonly nowEpochMillis: () => number;
}) => {
  const inspect = Effect.fn("PersonalSkillControl.inspect")(function* (userId: UserId) {
    const versions = yield* dependencies.authority.all(userId);
    return {
      skills: versions.map((version) => projectSkill(version, dependencies.availability())),
    } satisfies SkillsSummary;
  });

  const change = Effect.fn("PersonalSkillControl.change")(function* (
    userId: UserId,
    input: SkillChangeRequest,
  ) {
    const skillId = PersonalSkillId.make(input.reference);
    const expectedSkillVersion = PersonalSkillVersionId.make(input.expectedRevision);
    const evidence = [
      { _tag: "UserDecision" as const, referenceId: dependencies.decisionReference() },
    ];
    const nowEpochMillis = dependencies.nowEpochMillis();
    const availability = dependencies.availability();
    const changed =
      input.change === "archive"
        ? yield* dependencies.authority.archive({
            evidence,
            expectedSkillVersion,
            nowEpochMillis,
            skillId,
            userId,
          })
        : input.change === "restore"
          ? yield* dependencies.authority.restore({
              availability,
              evidence,
              expectedSkillVersion,
              nowEpochMillis,
              skillId,
              userId,
            })
          : yield* dependencies.authority.undoLatest({
              availability,
              evidence,
              expectedSkillVersion,
              nowEpochMillis,
              skillId,
              userId,
            });
    const version = "version" in changed ? changed.version : changed;
    return {
      notice:
        input.change === "archive"
          ? "Skill archived."
          : input.change === "restore"
            ? "Skill restored."
            : "Latest Skill change undone.",
      skill: projectSkill(version, availability),
    } satisfies SkillChangeResponse;
  });

  const presentDeletion = Effect.fn("PersonalSkillControl.presentDeletion")(function* (
    userId: UserId,
    reference: string,
  ) {
    const inspection = yield* dependencies.authority.inspect({
      skillId: PersonalSkillId.make(reference),
      userId,
    });
    return deletionPresentation(projectSkill(inspection.current, dependencies.availability()));
  });

  const deleteSkill = Effect.fn("PersonalSkillControl.delete")(function* (
    userId: UserId,
    reference: string,
    request: SkillDeletionRequest,
  ) {
    const current = yield* presentDeletion(userId, reference);
    if (!sameDeletionPresentation(current, request.approval.presentation)) {
      return yield* new PersonalSkillApprovalInvalid({
        message: "The Skill deletion Approval does not match the current Skill.",
      });
    }
    yield* dependencies.authority.delete({
      expectedSkillVersion: PersonalSkillVersionId.make(current.expectedRevision),
      skillId: PersonalSkillId.make(current.reference),
      userId,
    });
    return { status: "deleted" as const };
  });

  return { change, delete: deleteSkill, inspect, presentDeletion };
};

const projectSkill = (
  version: PersonalSkillVersion,
  availability: PersonalSkillAvailability,
): SkillSummary => {
  const catalog = catalogSnapshotsFor()[0]?.entries ?? [];
  const capabilities = version.capabilityIds.map(
    (capabilityId) =>
      catalog.find(({ id }) => id === capabilityId)?.description ?? "A supported Osfo capability.",
  );
  const availableCapabilities = new Set(availability.capabilityIds);
  const availableRequirements = new Set(availability.requirements);
  const missingCapability = version.capabilityIds.some((id) => !availableCapabilities.has(id));
  const missingRequirements = version.requirements.filter(
    (requirement) => !availableRequirements.has(requirement),
  );
  const unavailable = missingCapability || missingRequirements.length > 0;
  return {
    availability: unavailable
      ? {
          explanation: availabilityExplanation(missingCapability, missingRequirements),
          state: "unavailable",
        }
      : { state: "available" },
    behavior: version.taskDescription,
    canUndo: version.parentSkillVersion !== null || version.status === "active",
    capabilities,
    lastUsedAt:
      version.lastUsedAtEpochMillis === null
        ? null
        : DateTime.toDateUtc(DateTime.makeUnsafe(version.lastUsedAtEpochMillis)),
    purpose: version.description,
    reference: version.skillId,
    revisionReference: version.skillVersion,
    status: version.status,
  };
};

const availabilityExplanation = (
  missingCapability: boolean,
  missingRequirements: ReadonlyArray<string>,
): string => {
  if (missingRequirements.includes("composio")) {
    return "This Skill needs an Integration Connection that is not connected right now.";
  }
  if (missingCapability) {
    return "A capability this Skill needs is not currently available. The Skill will not run by itself.";
  }
  return "A required Osfo feature is not currently available. The Skill will not run by itself.";
};

const deletionPresentation = (skill: SkillSummary): SkillDeletionPresentation => ({
  actionId: `skill-delete:${skill.reference}:${skill.revisionReference}`,
  confirmation: skillDeletionConfirmation,
  consequence: "Permanently delete this Skill, its previous revisions, and its learning history.",
  expectedRevision: skill.revisionReference,
  reference: skill.reference,
  title: `Delete ${skill.purpose}`,
  version: skillDeletionPresentationVersion,
});

const sameDeletionPresentation = (
  expected: SkillDeletionPresentation,
  received: SkillDeletionPresentation,
): boolean =>
  expected.actionId === received.actionId &&
  expected.confirmation === received.confirmation &&
  expected.consequence === received.consequence &&
  expected.expectedRevision === received.expectedRevision &&
  expected.reference === received.reference &&
  expected.title === received.title &&
  expected.version === received.version;

export * as PersonalSkillControl from "./personal-skill-control";

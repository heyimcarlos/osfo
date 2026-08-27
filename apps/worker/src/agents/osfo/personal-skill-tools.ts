/* oxlint-disable eslint/no-underscore-dangle -- Domain tagged unions use _tag. */
/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- UUIDs are opaque durable identities, not deterministic test inputs. */

import { Effect, Schema } from "effect";

import type { UserId } from "../../domain";
import { CapabilityId } from "../../domain/capability-catalog";
import {
  PersonalSkillId,
  PersonalSkillVersion,
  PersonalSkillVersionId,
  SkillAvailabilityRequirement,
  SkillTaskKind,
  SkillTurnOrigin,
  personalSkillVersionValues,
} from "../../domain/personal-skill";
import type {
  Interface as PersonalSkillAuthority,
  PersonalSkillAvailability,
} from "./personal-skill-authority";

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

/** Small read surface for listing active Skills or inspecting one immutable lineage. */
export const SkillInspectInput = Schema.TaggedUnion({
  List: {},
  One: { skillId: PersonalSkillId },
});

const EditableSkill = {
  allowedOrigins: Schema.Array(SkillTurnOrigin).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  capabilityIds: Schema.Array(CapabilityId).check(Schema.isMinLength(1), Schema.isMaxLength(22)),
  description: boundedText(500),
  instructions: boundedText(8_000),
  keywords: Schema.Array(boundedText(100)).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  requirements: Schema.Array(SkillAvailabilityRequirement).check(Schema.isMaxLength(10)),
  taskDescription: boundedText(500),
  taskKinds: Schema.Array(SkillTaskKind).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
};

/** Exact personal Skill lineage target retained through durable deletion Approval. */
export const SkillDeleteInput = Schema.Struct({
  expectedSkillVersion: PersonalSkillVersionId,
  skillId: PersonalSkillId,
});

/** Exact personal Skill lineage target retained through durable deletion Approval. */
export type SkillDeleteInput = typeof SkillDeleteInput.Type;

/** Name registered with Think for approval-gated personal Skill deletion. */
export const personalSkillDeleteActionName = "osfoDeletePersonalSkill";

/** Explicit User lifecycle changes. Delete is presented for approval, never executed as a Tool. */
export const SkillManageInput = Schema.TaggedUnion({
  Archive: { expectedSkillVersion: PersonalSkillVersionId, skillId: PersonalSkillId },
  Create: EditableSkill,
  Delete: SkillDeleteInput.fields,
  Restore: { expectedSkillVersion: PersonalSkillVersionId, skillId: PersonalSkillId },
  Revise: {
    ...EditableSkill,
    expectedSkillVersion: PersonalSkillVersionId,
    skillId: PersonalSkillId,
  },
  Rollback: {
    expectedSkillVersion: PersonalSkillVersionId,
    skillId: PersonalSkillId,
    targetSkillVersion: PersonalSkillVersionId,
  },
});

interface CurrentAuthority {
  readonly decisionReferenceId: string;
  readonly userId: UserId;
}

/** Bind conversation Tools to the authenticated User and the Agent's current availability. */
export const makePersonalSkillTools = (dependencies: {
  readonly authority: PersonalSkillAuthority;
  readonly availability: () => PersonalSkillAvailability;
  readonly current: () => CurrentAuthority | null;
  readonly nowEpochMillis: () => number;
}) => ({
  inspect: Effect.fn("PersonalSkillTools.inspect")(function* (
    input: typeof SkillInspectInput.Type,
  ) {
    const current = yield* requireCurrent(dependencies.current());
    if (input._tag === "One") {
      const inspection = yield* dependencies.authority.inspect({
        skillId: input.skillId,
        userId: current.userId,
      });
      return { _tag: "SkillInspection", ...inspection } as const;
    }
    const versions = yield* dependencies.authority.active(current.userId);
    return {
      _tag: "ActiveSkills",
      skills: versions.map(skillSummary),
    } as const;
  }),
  manage: Effect.fn("PersonalSkillTools.manage")(function* (input: typeof SkillManageInput.Type) {
    const current = yield* requireCurrent(dependencies.current());
    const evidence = [{ _tag: "UserDecision" as const, referenceId: current.decisionReferenceId }];
    const nowEpochMillis = dependencies.nowEpochMillis();
    const availability = dependencies.availability();
    if (input._tag === "Delete") {
      return {
        _tag: "ApprovalRequired",
        change: "delete",
        expectedSkillVersion: input.expectedSkillVersion,
        message: "Deleting a personal Skill requires a separately approved skill.manage action.",
        skillId: input.skillId,
      } as const;
    }
    if (input._tag === "Archive") {
      return yield* dependencies.authority.archive({
        evidence,
        expectedSkillVersion: input.expectedSkillVersion,
        nowEpochMillis,
        skillId: input.skillId,
        userId: current.userId,
      });
    }
    if (input._tag === "Restore") {
      return yield* dependencies.authority.restore({
        availability,
        evidence,
        expectedSkillVersion: input.expectedSkillVersion,
        nowEpochMillis,
        skillId: input.skillId,
        userId: current.userId,
      });
    }
    if (input._tag === "Rollback") {
      return yield* dependencies.authority.rollback({
        availability,
        evidence,
        expectedSkillVersion: input.expectedSkillVersion,
        nowEpochMillis,
        skillId: input.skillId,
        targetSkillVersion: input.targetSkillVersion,
        userId: current.userId,
      });
    }
    if (input._tag === "Create") {
      const skillId = PersonalSkillId.make(`skill-${crypto.randomUUID()}`);
      const skillVersion = PersonalSkillVersionId.make(`v1-${crypto.randomUUID()}`);
      return yield* dependencies.authority.create({
        availability,
        version: yield* PersonalSkillVersion.makeEffect({
          ...input,
          createdAtEpochMillis: nowEpochMillis,
          createdBy: "user",
          creationEvidence: evidence,
          lastUsedAtEpochMillis: null,
          origin: "userAuthored",
          outcomeFacts: { confirmedFailures: 0, confirmedSuccesses: 0 },
          ownerUserId: current.userId,
          parentSkillVersion: null,
          revision: 1,
          skillId,
          skillVersion,
          status: "active",
          updatedAtEpochMillis: nowEpochMillis,
          updateEvidence: [],
        }),
      });
    }
    const prior = yield* dependencies.authority.pin({
      skillId: input.skillId,
      userId: current.userId,
    });
    return yield* dependencies.authority.revise({
      availability,
      expectedSkillVersion: input.expectedSkillVersion,
      version: yield* PersonalSkillVersion.makeEffect({
        ...personalSkillVersionValues(prior),
        ...input,
        createdBy: "user",
        parentSkillVersion: input.expectedSkillVersion,
        revision: prior.revision + 1,
        skillVersion: PersonalSkillVersionId.make(`v${prior.revision + 1}-${crypto.randomUUID()}`),
        status: "active",
        updatedAtEpochMillis: nowEpochMillis,
        updateEvidence: evidence,
      }),
    });
  }),
});

const requireCurrent = (current: CurrentAuthority | null) =>
  current === null
    ? Effect.die(new Error("Personal Skill Tools require an active managed turn"))
    : Effect.succeed(current);

const skillSummary = (version: PersonalSkillVersion) => ({
  description: version.description,
  lastUsedAtEpochMillis: version.lastUsedAtEpochMillis,
  skillId: version.skillId,
  skillVersion: version.skillVersion,
  status: version.status,
});

export * as PersonalSkillTools from "./personal-skill-tools";

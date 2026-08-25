import { Effect } from "effect";

import type { UserId } from "../../domain";
import { maximumLoadedSkillsPerTurn } from "../../domain/managed-conversation";
import { Capabilities } from "../../services/capabilities";

/** Inputs pinned for every model step in one active Think turn. */
export interface Input extends Omit<
  Capabilities.AssembleToolBundleInput,
  "loadedSkills" | "toolSchemas"
> {
  readonly baseInstructions: string;
  readonly capabilities: Capabilities.Interface;
  readonly loadedSkills: ReadonlyArray<Capabilities.LoadedSkill>;
  readonly personalSkills: ReadonlyArray<unknown>;
  readonly toolSchemas: NonNullable<Capabilities.AssembleToolBundleInput["toolSchemas"]>;
  readonly userId: UserId;
}

/** Progressive model-step projection assembled from the latest loaded Skill set. */
export interface Step {
  readonly activeToolNames: ReadonlyArray<string>;
  readonly bundle: Capabilities.ToolBundle;
  readonly index: Capabilities.EligibleIndex;
  readonly instructions: string;
}

/** Active turn controller that merges concurrent Skill loads before the next model step. */
export interface Interface {
  readonly commitLoadedSkill: (loaded: Capabilities.LoadedSkill) => boolean;
  readonly loadSkill: (
    pin: Capabilities.SkillPin,
  ) => Effect.Effect<Capabilities.LoadedSkill, Capabilities.SkillNotEligible>;
  readonly step: () => Step;
}

/** Pin one turn and progressively project its loaded Skills onto each model step. */
export const make = (input: Input): Interface => {
  let loadedSkills = [...input.loadedSkills];

  return {
    commitLoadedSkill: (loaded) => {
      if (
        loadedSkills.some(
          ({ skillId, skillVersion }) =>
            skillId === loaded.skillId && skillVersion === loaded.skillVersion,
        )
      ) {
        return true;
      }
      if (loadedSkills.length >= maximumLoadedSkillsPerTurn) return false;
      loadedSkills = [...loadedSkills, loaded];
      return true;
    },
    loadSkill: Effect.fn("CapabilityTurn.loadSkill")(function* (pin: Capabilities.SkillPin) {
      const retained = loadedSkills.find(
        ({ skillId, skillVersion }) => skillId === pin.skillId && skillVersion === pin.skillVersion,
      );
      if (retained !== undefined) return retained;
      if (loadedSkills.length >= maximumLoadedSkillsPerTurn) {
        return yield* new Capabilities.SkillNotEligible({
          message: "The active turn already loaded its maximum number of Skills",
          skillId: pin.skillId,
          skillVersion: pin.skillVersion,
        });
      }
      return yield* input.capabilities.loadSkill({
        index: input.index,
        personalSkills: input.personalSkills,
        skillId: pin.skillId,
        skillVersion: pin.skillVersion,
        userId: input.userId,
      });
    }),
    step: () => {
      const bundle = input.capabilities.assembleToolBundle({
        availableToolNames: input.availableToolNames,
        index: input.index,
        loadedSkills,
        toolSchemas: input.toolSchemas,
      });
      return {
        activeToolNames: bundle.activeToolNames,
        bundle,
        index: input.index,
        instructions: [input.baseInstructions, bundle.instructions].join("\n\n"),
      };
    },
  };
};

export * as CapabilityTurn from "./capability-turn";

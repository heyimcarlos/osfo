import { Effect, Option } from "effect";

/** Worker-wide company-funded Skill Learning permit shared by User Agent instances. */
export interface SkillLearningAdmission {
  readonly acquire: Effect.Effect<Option.Option<Effect.Effect<void>>>;
}

/** Build one atomic in-isolate permit authority; callers always release through Effect finalizers. */
export const makeSkillLearningAdmission = (limit: number): SkillLearningAdmission => {
  let active = 0;
  return {
    acquire: Effect.sync(() => {
      if (active >= limit) return Option.none();
      active += 1;
      let released = false;
      return Option.some(
        Effect.sync(() => {
          if (released) return;
          released = true;
          active -= 1;
        }),
      );
    }),
  };
};

export * as SkillLearningAdmission from "./skill-learning-admission";

import { Effect, Result } from "effect";

import type { CoreMemoryReplacement } from "./deletion-actions";

/** Apply the exact Core Memory replacements without touching the source Session transcript. */
export const correctForgottenKnowledge = Effect.fn("KnowledgeDeletion.correctForgottenKnowledge")(
  function* <A, E, E2, R>(
    replacements: ReadonlyArray<CoreMemoryReplacement>,
    authorizeReplacement: Effect.Effect<void, E2, R>,
    replace: (
      replacements: ReadonlyArray<CoreMemoryReplacement>,
      authorize: Effect.Effect<void, E2, R>,
    ) => Effect.Effect<A, E | E2, R>,
  ) {
    return yield* replace(replacements, authorizeReplacement);
  },
);

export type KnowledgeDeletionPreparationOutcome<A> =
  | { readonly _tag: "CorrectionPending" }
  | { readonly _tag: "Prepared"; readonly corrected: A; readonly released: boolean };

/** Keep provider work leased until local correction commits or its untouched intent is cancelled. */
export const completeKnowledgeDeletionPreparation = Effect.fn(
  "KnowledgeDeletion.completeKnowledgeDeletionPreparation",
)(function* <A, E, E2>(input: {
  readonly correct: Effect.Effect<A, E>;
  readonly release: Effect.Effect<boolean, E2>;
}) {
  const correction = yield* input.correct.pipe(Effect.result);
  // The correction boundary is atomic, so failure retains provider ownership with no local write.
  if (Result.isFailure(correction)) return { _tag: "CorrectionPending" } as const;
  const release = yield* input.release.pipe(Effect.result);
  return {
    _tag: "Prepared",
    corrected: correction.success,
    released: Result.isSuccess(release) && release.success,
  } as const;
});

export * as KnowledgeDeletion from "./knowledge-deletion";

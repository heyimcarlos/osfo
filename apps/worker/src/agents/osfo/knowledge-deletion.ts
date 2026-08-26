import { Effect, Result } from "effect";

import type { CoreMemoryReplacement } from "./deletion-actions";

/** Apply the exact Core Memory replacements without touching the source Session transcript. */
export const correctForgottenKnowledge = Effect.fn("KnowledgeDeletion.correctForgottenKnowledge")(
  function* <A, E, E2, R>(
    replacements: ReadonlyArray<CoreMemoryReplacement>,
    authorizeReplacement: Effect.Effect<void, E2, R>,
    replace: (replacement: CoreMemoryReplacement) => Effect.Effect<A, E>,
  ) {
    return yield* Effect.forEach(
      replacements,
      (replacement) => authorizeReplacement.pipe(Effect.andThen(replace(replacement))),
      { concurrency: 1 },
    );
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
  // A failed later replacement may follow an already committed earlier block. Retaining the
  // preparation makes both local correction and provider forgetting retryable as one obligation.
  if (Result.isFailure(correction)) return { _tag: "CorrectionPending" } as const;
  const release = yield* input.release.pipe(Effect.result);
  return {
    _tag: "Prepared",
    corrected: correction.success,
    released: Result.isSuccess(release) && release.success,
  } as const;
});

export * as KnowledgeDeletion from "./knowledge-deletion";

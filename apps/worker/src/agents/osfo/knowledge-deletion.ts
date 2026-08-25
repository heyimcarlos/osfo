import { Effect } from "effect";

import type { CoreMemoryReplacement } from "./deletion-actions";

/** Apply the exact Core Memory replacements without touching the source Session transcript. */
export const correctForgottenKnowledge = <A, E, E2, R>(
  replacements: ReadonlyArray<CoreMemoryReplacement>,
  authorizeReplacement: Effect.Effect<void, E2, R>,
  replace: (replacement: CoreMemoryReplacement) => Effect.Effect<A, E>,
) =>
  Effect.forEach(
    replacements,
    (replacement) => authorizeReplacement.pipe(Effect.andThen(replace(replacement))),
    { concurrency: 1 },
  );

export * as KnowledgeDeletion from "./knowledge-deletion";

import { Effect } from "effect";

import type { CoreMemoryReplacement } from "./deletion-actions";

/** Apply the exact Core Memory replacements without touching the source Session transcript. */
export const correctForgottenKnowledge = <A, E>(
  replacements: ReadonlyArray<CoreMemoryReplacement>,
  replace: (replacement: CoreMemoryReplacement) => Effect.Effect<A, E>,
) => Effect.forEach(replacements, replace, { concurrency: 1 });

export * as KnowledgeDeletion from "./knowledge-deletion";

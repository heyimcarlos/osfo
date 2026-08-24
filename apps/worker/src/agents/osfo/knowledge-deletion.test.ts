/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { correctForgottenKnowledge } from "./knowledge-deletion";

it.effect("corrects Core Memory while preserving the source Session transcript", () => {
  const transcript = ["User: My old preference", "Osfo: I will remember that"];
  const coreMemory = {
    agentNotes: "Old note",
    userContext: "Old preference",
  };

  return correctForgottenKnowledge(
    [
      { block: "userContext", content: "Corrected preference" },
      { block: "agentNotes", content: "" },
    ],
    (replacement) =>
      Effect.sync(() => {
        coreMemory[replacement.block] = replacement.content;
        return replacement;
      }),
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(coreMemory).toEqual({
          agentNotes: "",
          userContext: "Corrected preference",
        });
        expect(transcript).toEqual(["User: My old preference", "Osfo: I will remember that"]);
      }),
    ),
  );
});

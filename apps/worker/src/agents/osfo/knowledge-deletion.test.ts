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
    Effect.void,
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

it.effect("rechecks authority immediately before every Core Memory replacement", () => {
  const coreMemory = {
    agentNotes: "Old note",
    userContext: "Old preference",
  };
  let checks = 0;

  return correctForgottenKnowledge(
    [
      { block: "userContext", content: "Corrected preference" },
      { block: "agentNotes", content: "" },
    ],
    Effect.suspend(() => {
      checks += 1;
      return checks === 1 ? Effect.void : Effect.fail("authority changed" as const);
    }),
    (replacement) =>
      Effect.sync(() => {
        coreMemory[replacement.block] = replacement.content;
      }),
  ).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(failure).toBe("authority changed");
        expect(checks).toBe(2);
        expect(coreMemory).toEqual({
          agentNotes: "Old note",
          userContext: "Corrected preference",
        });
      }),
    ),
  );
});

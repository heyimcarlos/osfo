/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  completeKnowledgeDeletionPreparation,
  correctForgottenKnowledge,
} from "./knowledge-deletion";

it.effect("corrects Core Memory while preserving the source Session transcript", () => {
  const transcript = ["User: My old preference", "Osfo: I will remember that"];
  const coreMemory = {
    agentNotes: "Old note",
    userContext: "Old preference",
  };

  return correctForgottenKnowledge(
    [
      { block: "userContext", content: "Corrected preference", expectedContent: "Old preference" },
      { block: "agentNotes", content: "", expectedContent: "Old note" },
    ],
    Effect.void,
    (replacements, authorize) =>
      authorize.pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const replacement of replacements) {
              coreMemory[replacement.block] = replacement.content;
            }
            return replacements;
          }),
        ),
      ),
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

it.effect("rechecks authority immediately before the atomic Core Memory replacement", () => {
  const coreMemory = {
    agentNotes: "Old note",
    userContext: "Old preference",
  };
  let checks = 0;

  return correctForgottenKnowledge(
    [
      { block: "userContext", content: "Corrected preference", expectedContent: "Old preference" },
      { block: "agentNotes", content: "", expectedContent: "Old note" },
    ],
    Effect.suspend(() => {
      checks += 1;
      return Effect.fail("authority changed" as const);
    }),
    (replacements, authorize) =>
      authorize.pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const replacement of replacements) {
              coreMemory[replacement.block] = replacement.content;
            }
          }),
        ),
      ),
  ).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(failure).toBe("authority changed");
        expect(checks).toBe(1);
        expect(coreMemory).toEqual({
          agentNotes: "Old note",
          userContext: "Old preference",
        });
      }),
    ),
  );
});

it.effect("retains provider work when an immediate correction fails", () => {
  const events: Array<string> = [];
  return completeKnowledgeDeletionPreparation({
    correct: Effect.sync(() => events.push("correct")).pipe(
      Effect.andThen(Effect.fail("correction failed" as const)),
    ),
    release: Effect.sync(() => {
      events.push("release");
      return true;
    }),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({ _tag: "CorrectionPending" });
        expect(events).toEqual(["correct"]);
      }),
    ),
  );
});

it.effect("leaves every Core Memory block unchanged when the atomic replacement fails", () => {
  const coreMemory = { agentNotes: "Old note", userContext: "Old preference" };
  const events: Array<string> = [];
  return completeKnowledgeDeletionPreparation({
    correct: correctForgottenKnowledge(
      [
        {
          block: "userContext",
          content: "Corrected preference",
          expectedContent: "Old preference",
        },
        { block: "agentNotes", content: "", expectedContent: "Old note" },
      ],
      Effect.void,
      (_replacements, authorize) =>
        authorize.pipe(Effect.andThen(Effect.fail("later replacement failed" as const))),
    ),
    release: Effect.sync(() => {
      events.push("release");
      return true;
    }),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({ _tag: "CorrectionPending" });
        expect(coreMemory).toEqual({
          agentNotes: "Old note",
          userContext: "Old preference",
        });
        expect(events).toEqual([]);
      }),
    ),
  );
});

it.effect("returns explicit pending state when correction remains unavailable", () =>
  completeKnowledgeDeletionPreparation({
    correct: Effect.fail("correction failed" as const),
    release: Effect.die(new Error("Failed correction released provider work")),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({ _tag: "CorrectionPending" });
      }),
    ),
  ),
);

it.effect("releases durable provider retry only after correction commits", () => {
  const events: Array<string> = [];
  return completeKnowledgeDeletionPreparation({
    correct: Effect.sync(() => {
      events.push("correct");
      return ["corrected"];
    }),
    release: Effect.sync(() => {
      events.push("release");
      return true;
    }),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({ _tag: "Prepared", corrected: ["corrected"], released: true });
        expect(events).toEqual(["correct", "release"]);
      }),
    ),
  );
});

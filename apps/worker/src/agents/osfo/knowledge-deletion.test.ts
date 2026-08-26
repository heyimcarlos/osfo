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

it.effect("retains provider ownership after a later Core Memory replacement fails", () => {
  const coreMemory = { agentNotes: "Old note", userContext: "Old preference" };
  const events: Array<string> = [];
  return completeKnowledgeDeletionPreparation({
    correct: correctForgottenKnowledge(
      [
        { block: "userContext", content: "Corrected preference" },
        { block: "agentNotes", content: "" },
      ],
      Effect.void,
      (replacement) =>
        replacement.block === "agentNotes"
          ? Effect.fail("later replacement failed" as const)
          : Effect.sync(() => {
              coreMemory[replacement.block] = replacement.content;
              events.push(`replace:${replacement.block}`);
            }),
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
          userContext: "Corrected preference",
        });
        expect(events).toEqual(["replace:userContext"]);
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

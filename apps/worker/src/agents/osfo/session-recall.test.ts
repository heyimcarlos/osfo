import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeSessionRecallTools } from "./session-recall";

it("keeps FTS5 Session Recall dormant until the model invokes its tool", () => {
  let recalls = 0;
  const tools = makeSessionRecallTools({
    authorize: () => Effect.die(new Error("unexpected authorization")),
    readActiveTurn: () => undefined,
    recall: () => {
      recalls += 1;
      return Effect.die(new Error("unexpected Session Recall"));
    },
  });

  expect(tools).toHaveProperty("sessionRecall");
  expect(recalls).toBe(0);
});

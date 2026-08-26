/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { replaceCoreMemoryBlocks } from "./core-memory";

it.effect("commits every exact Core Memory replacement in one storage transaction", () => {
  const fixture = batchFixture();
  return replaceCoreMemoryBlocks(
    fixture.session,
    fixture.storage,
    [
      { block: "userContext", content: "New User Context" },
      { block: "agentNotes", content: "New Agent Notes" },
    ],
    Effect.void,
  ).pipe(
    Effect.tap((corrected) =>
      Effect.sync(() => {
        expect(corrected.map(({ block, content }) => ({ block, content }))).toEqual([
          { block: "userContext", content: "New User Context" },
          { block: "agentNotes", content: "New Agent Notes" },
        ]);
        expect(fixture.rows).toEqual(
          new Map([
            ["osfo_core_memory_user_context", "New User Context"],
            ["osfo_core_memory_agent_notes", "New Agent Notes"],
          ]),
        );
      }),
    ),
  );
});

it.effect("rolls back every Core Memory replacement when a later write fails", () => {
  const fixture = batchFixture(2);
  return replaceCoreMemoryBlocks(
    fixture.session,
    fixture.storage,
    [
      { block: "userContext", content: "New User Context" },
      { block: "agentNotes", content: "New Agent Notes" },
    ],
    Effect.void,
  ).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(failure).toMatchObject({ _tag: "CoreMemoryUnavailable", operation: "correct" });
        expect(fixture.rows).toEqual(
          new Map([
            ["osfo_core_memory_user_context", "Old User Context"],
            ["osfo_core_memory_agent_notes", "Old Agent Notes"],
          ]),
        );
      }),
    ),
  );
});

const batchFixture = (failAtWrite?: number) => {
  const rows = new Map([
    ["osfo_core_memory_user_context", "Old User Context"],
    ["osfo_core_memory_agent_notes", "Old Agent Notes"],
  ]);
  let writes = 0;
  const storage = {
    sql: {
      exec: (_query: string, label: string, content: string) => {
        writes += 1;
        if (writes === failAtWrite) throw new Error("Injected later Core Memory write failure");
        rows.set(label, content);
        return [];
      },
    },
    transactionSync: <A>(transaction: () => A) => {
      const snapshot = new Map(rows);
      try {
        return transaction();
      } catch (cause) {
        rows.clear();
        for (const [label, content] of snapshot) rows.set(label, content);
        throw cause;
      }
    },
  };
  const session = {
    getContextBlock: (label: string) => ({
      content:
        label === "User Context"
          ? (rows.get("osfo_core_memory_user_context") ?? "")
          : (rows.get("osfo_core_memory_agent_notes") ?? ""),
      isSearchable: false,
      isSkill: false,
      label,
      maxTokens: 1_200,
      tokens: 4,
      writable: true,
    }),
    refreshSystemPrompt: () => Promise.resolve(""),
  };
  return { rows, session, storage };
};

import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { respondBrowserTask } from "./browser-task-model";

const tools = [
  "openBrowserTask",
  "executeBrowserEffect",
  "observeBrowserTask",
  "listBrowserTasks",
  "inspectBrowserOutcome",
  "closeBrowserTask",
].map((name) => ({ function: { name } }));
const user = {
  role: "user",
  content:
    "Open http://127.0.0.1:39271/book for a synthetic browser appointment. Prefer Tuesday morning; Friday afternoon is backup.",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const page = {
  taskId: "actual-task",
  observationId: "actual-observation",
  url: "http://127.0.0.1:39271/book",
  observedAt: 1,
  text: "7 button Choose Tuesday at 10:00 AM\n9 button Confirm synthetic appointment disabled",
};
const task = {
  taskId: page.taskId,
  requestText: user.content,
  closed: false,
  observation: page,
  lastOutcome: { _tag: "Observed", observation: page },
  uncertainOperationId: null,
};
const result = (value: Schema.Json) => ({
  role: "tool",
  name: "openBrowserTask",
  content: encode(value),
});

it("chooses actual page indices and emits confirmation only from a returned receipt", () => {
  expect(respondBrowserTask({ messages: [user], tools })).toMatchObject({
    tool_calls: [{ name: "openBrowserTask", arguments: { url: page.url } }],
  });
  expect(respondBrowserTask({ messages: [user, result(task)], tools })).toMatchObject({
    tool_calls: [
      {
        name: "executeBrowserEffect",
        arguments: {
          taskId: page.taskId,
          observationId: page.observationId,
          targetDescription: "7 button Choose Tuesday at 10:00 AM",
          interaction: { target: "7" },
        },
      },
    ],
  });
  const selected = {
    ...page,
    observationId: "selection-observation",
    text: "5 text Selected: Tuesday at 10:00 AM\n17 button Confirm synthetic appointment",
  };
  expect(
    respondBrowserTask({
      messages: [
        user,
        result({
          ...task,
          observation: selected,
          lastOutcome: { _tag: "Observed", observation: selected },
        }),
      ],
      tools,
    }),
  ).toMatchObject({
    tool_calls: [
      {
        name: "executeBrowserEffect",
        arguments: { observationId: "selection-observation", interaction: { target: "17" } },
      },
    ],
  });
  const confirmed = {
    ...page,
    observationId: "receipt-observation",
    text: "8 text Confirmed. Receipt SYNTHETIC-73. Tuesday at 10:00 AM",
  };
  expect(
    respondBrowserTask({
      messages: [
        user,
        result({
          ...task,
          observation: confirmed,
          lastOutcome: { _tag: "Observed", observation: confirmed },
        }),
      ],
      tools,
    }),
  ).toMatchObject({ finish_reason: "stop", response: expect.stringContaining("SYNTHETIC-73") });
});

it("rejects missing, stale, unknown, or foreign evidence instead of requesting an effect", () => {
  for (const value of [
    {},
    { ...task, uncertainOperationId: "unresolved" },
    { ...task, observation: { ...page, observationId: "stale" } },
    { ...task, observation: { ...page, taskId: "foreign" } },
    { ...task, observation: null },
  ]) {
    expect(respondBrowserTask({ messages: [user, result(value)], tools })).toMatchObject({
      finish_reason: "stop",
    });
  }
  expect(() => respondBrowserTask({ messages: [user, result(task)], tools: [] })).toThrowError(
    "admitted executeBrowserEffect",
  );
});

it("uses the current instruction after historical browser requests in provider context", () => {
  const current = {
    role: "user",
    content: `## Recent unindexed conversation source evidence\n\n${encode([user.content])}\n\nClose the synthetic browser task.`,
  };
  expect(respondBrowserTask({ messages: [current], tools })).toMatchObject({
    tool_calls: [{ name: "listBrowserTasks", arguments: {} }],
  });
});

it("refuses disabled or ambiguous targets in Chrome accessibility evidence", () => {
  for (const text of [
    "9 button (disabled) Choose Tuesday at 10:00 AM, ID: tuesday",
    "9 button Choose Tuesday at 10:00 AM, ID: first\n10 button Choose Tuesday at 10:00 AM, ID: second",
  ]) {
    const observation = { ...page, text };
    expect(
      respondBrowserTask({
        messages: [
          user,
          result({
            ...task,
            observation,
            lastOutcome: { _tag: "Observed", observation },
          }),
        ],
        tools,
      }),
    ).toMatchObject({ finish_reason: "stop" });
  }
});

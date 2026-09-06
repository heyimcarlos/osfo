/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed timestamps exercise the authenticated RPC boundary. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import type { BrowserTaskControls } from "../agents/osfo/browser-task-controls";
import { listTasks, openTask, resumeTask } from "./browser-tasks";

const user = {
  userId: "user-1",
  authSessionId: "session-1",
  authSessionExpiresAt: new Date("2026-09-06T12:00:00.000Z"),
};
const task = { taskId: "task-1", url: "https://portal.example.test", state: "human" as const };
const liveView = {
  taskId: task.taskId,
  url: "https://browser.example.test/view",
  expiresInMs: 60_000,
};
const stub = {
  listBrowserTasks: () => Promise.resolve({ items: [task] }),
  openBrowserTask: () => Promise.resolve(liveView),
  resumeBrowserTask: () => Promise.resolve({ taskId: task.taskId, state: "active" }),
};

describe("authenticated browser task controls", () => {
  it.effect("derives actor authority from the session and sends only the selected task", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly agentId: string;
        readonly input: BrowserTaskControls.Request;
      }> = [];
      const result = yield* openTask(
        {
          ...stub,
          openBrowserTask: (agentId, input) => {
            calls.push({ agentId, input });
            return Promise.resolve(liveView);
          },
        },
        "agent-1",
        user,
        { taskId: task.taskId },
      );
      expect(result).toEqual(liveView);
      expect(calls).toEqual([
        {
          agentId: "agent-1",
          input: {
            taskId: "task-1",
            actor: {
              _tag: "AuthSession",
              userId: "user-1",
              authSessionId: "session-1",
              expiresAt: "2026-09-06T12:00:00.000Z",
            },
          },
        },
      ]);
    }),
  );

  it.effect.each([
    { name: "revoked owner", response: null },
    { name: "different task", response: { ...liveView, taskId: "other-task" } },
    { name: "unsafe URL", response: { ...liveView, url: "javascript:alert(1)" } },
    { name: "expired link", response: { ...liveView, expiresInMs: 0 } },
    { name: "provider session ID", response: { sessionId: "provider-session" } },
  ])("does not expose a live view for $name", ({ response }) =>
    Effect.gen(function* () {
      const result = yield* openTask(
        { ...stub, openBrowserTask: () => Promise.resolve(response) },
        "agent-1",
        user,
        { taskId: task.taskId },
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("lists owned tasks and confirms resume only for the requested task", () =>
    Effect.gen(function* () {
      expect((yield* listTasks(stub, "agent-1", user)).items).toEqual([task]);
      expect(yield* resumeTask(stub, "agent-1", user, { taskId: task.taskId })).toEqual({
        taskId: "task-1",
        state: "active",
      });
      const result = yield* resumeTask(
        {
          ...stub,
          resumeBrowserTask: () => Promise.resolve({ taskId: "other-task", state: "active" }),
        },
        "agent-1",
        user,
        { taskId: task.taskId },
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});

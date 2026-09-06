// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */
import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserApprovalsUnavailable, BrowserTasksUnavailable } from "@osfo/api";
import { Deferred, Effect } from "effect";

import { SettingsBrowserPage, type SettingsBrowserDependencies } from "./settings-browser-page";

afterEach(cleanup);
const taskDependencies = {
  inspectTasks: Effect.succeed({ items: [] }),
  openTask: () => Effect.die(new Error("Unexpected open")),
  resumeTask: () => Effect.die(new Error("Unexpected resume")),
};
const approval = {
  actionId: "browser-action",
  presentationId: "exact-browser-presentation",
  title: "Choose appointment",
  description: "Click the exact appointment option on the observed page.",
  consequences: [
    "Select Tuesday morning without confirming the appointment.",
    "A separate confirmation needs another approval.",
  ],
  fields: [
    { label: "Destination", name: "url", value: "https://portal.example.test/book" },
    { label: "Visible target", name: "target", value: "9 button Choose Tuesday at 10:00 AM" },
    { label: "Exact interaction", name: "interaction", value: '{"_tag":"Click","target":"9"}' },
  ],
};

describe("browser interaction approvals", () => {
  it.each(["approve", "reject"] as const)(
    "shows exact facts and sends the selected %s once",
    async (decision) => {
      const user = userEvent.setup();
      const calls: Array<{
        readonly presentationId: string;
        readonly decision: "approve" | "reject";
      }> = [];
      const gate = Deferred.makeUnsafe<void>();
      const dependencies: SettingsBrowserDependencies = {
        ...taskDependencies,
        inspect: Effect.sync(() => ({ items: calls.length === 0 ? [approval] : [] })),
        decide: (payload) =>
          Effect.gen(function* () {
            calls.push(payload);
            yield* Deferred.await(gate);
            return {
              decision: decision === "approve" ? ("approved" as const) : ("rejected" as const),
              presentationId: payload.presentationId,
            };
          }),
      };
      render(<SettingsBrowserPage dependencies={dependencies} />);
      const button = await screen.findByRole("button", {
        name: decision === "approve" ? "Approve" : "Reject",
      });
      expect(screen.getByText("https://portal.example.test/book")).toBeDefined();
      expect(screen.getByText("9 button Choose Tuesday at 10:00 AM")).toBeDefined();
      expect(screen.getByText("Click the visible target shown above.")).toBeDefined();
      expect(screen.getByText(/Select Tuesday morning without confirming/)).toBeDefined();
      await user.dblClick(button);
      expect(calls).toEqual([{ decision, presentationId: approval.presentationId }]);
      expect(button.hasAttribute("disabled")).toBe(true);
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      expect(await screen.findByText(/No browser action needs approval/)).toBeDefined();
      expect((await screen.findByRole("status")).textContent).toContain(
        decision === "approve" ? "Approved." : "Rejected.",
      );
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      expect(calls).toHaveLength(1);
    },
  );

  it("removes a failed stale approval until the User refreshes", async () => {
    const user = userEvent.setup();
    render(
      <SettingsBrowserPage
        dependencies={{
          ...taskDependencies,
          inspect: Effect.succeed({ items: [approval] }),
          decide: () =>
            Effect.fail(new BrowserApprovalsUnavailable({ message: "Already resolved" })),
        }}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("browser human control", () => {
  it("opens only after pause succeeds, prevents duplicate requests, and removes the link on resume", async () => {
    const user = userEvent.setup();
    const gate = Deferred.makeUnsafe<void>();
    const opened: Array<string> = [];
    const resumed: Array<string> = [];
    let state: "active" | "human" = "active";
    render(
      <SettingsBrowserPage
        dependencies={{
          ...taskDependencies,
          inspect: Effect.sync(() => ({ items: opened.length === 0 ? [approval] : [] })),
          decide: () => Effect.die(new Error("Unexpected decision")),
          inspectTasks: Effect.sync(() => ({
            items: [{ taskId: "owned-task", url: "https://portal.example.test", state }],
          })),
          openTask: ({ taskId }) =>
            Effect.gen(function* () {
              opened.push(taskId);
              yield* Deferred.await(gate);
              state = "human";
              return { taskId, url: "https://browser.example.test/view", expiresInMs: 60_000 };
            }),
          resumeTask: ({ taskId }) =>
            Effect.sync(() => {
              resumed.push(taskId);
              state = "active";
              return { taskId, state: "active" as const };
            }),
        }}
      />,
    );
    expect(await screen.findByRole("button", { name: "Approve" })).toBeDefined();
    const open = await screen.findByRole("button", { name: "Open browser" });
    await user.dblClick(open);
    expect(opened).toEqual(["owned-task"]);
    expect(screen.queryByRole("link", { name: "Open live browser" })).toBeNull();
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    const link = await screen.findByRole("link", { name: "Open live browser" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expect(link.getAttribute("href")).toBe("https://browser.example.test/view");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText(/Osfo cannot interact with this browser/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Return to Osfo" }));
    expect(resumed).toEqual(["owned-task"]);
    expect(screen.queryByRole("link", { name: "Open live browser" })).toBeNull();
    expect(await screen.findByText(/continue from a fresh view/)).toBeDefined();
  });

  it("does not claim control or expose a link when the handoff fails", async () => {
    const user = userEvent.setup();
    render(
      <SettingsBrowserPage
        dependencies={{
          ...taskDependencies,
          inspect: Effect.succeed({ items: [] }),
          decide: () => Effect.die(new Error("Unexpected decision")),
          inspectTasks: Effect.succeed({
            items: [{ taskId: "owned-task", url: "https://portal.example.test", state: "active" }],
          }),
          openTask: () => Effect.fail(new BrowserTasksUnavailable({ message: "Unavailable" })),
        }}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Open browser" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Open live browser" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

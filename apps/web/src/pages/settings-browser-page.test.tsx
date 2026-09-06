// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */
import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserApprovalsUnavailable } from "@osfo/api";
import { Deferred, Effect } from "effect";

import { SettingsBrowserPage, type SettingsBrowserDependencies } from "./settings-browser-page";

afterEach(cleanup);
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

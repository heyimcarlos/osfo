// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */
import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RemindersUnavailable } from "@osfo/api";
import { Deferred, Effect } from "effect";

import {
  SettingsRemindersPage,
  type SettingsRemindersDependencies,
} from "./settings-reminders-page";

afterEach(cleanup);
const approval = {
  actionId: "reminder-action",
  presentationId: "exact-reminder-presentation",
  title: "Create Reminder",
  description: "Commit the exact private Reminder body and fixed schedule shown here.",
  consequences: [
    "Create and activate this exact Reminder.",
    "Ask the User to return through WhatsApp.",
  ],
  fields: [
    { label: "Body", name: "body", value: "Private body\nSecond line" },
    { label: "First due", name: "firstDueAt", value: "2026-09-06T12:00:00.000Z" },
    { label: "Resulting revision", name: "revision", value: "1" },
  ],
};

describe("Reminder approvals", () => {
  it.each(["approve", "reject"] as const)(
    "shows exact facts and sends the selected %s once",
    async (decision) => {
      const user = userEvent.setup();
      const calls: Array<{
        readonly presentationId: string;
        readonly decision: "approve" | "reject";
      }> = [];
      const gate = Deferred.makeUnsafe<void>();
      const dependencies: SettingsRemindersDependencies = {
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
      render(<SettingsRemindersPage dependencies={dependencies} />);
      const button = await screen.findByRole("button", {
        name: decision === "approve" ? "Approve exact Reminder" : "Reject",
      });
      expect(screen.getByText("Private body Second line")).toBeDefined();
      expect(screen.getByText("2026-09-06T12:00:00.000Z")).toBeDefined();
      expect(screen.getByText(/Create and activate this exact Reminder/)).toBeDefined();
      await user.dblClick(button);
      expect(calls).toEqual([{ decision, presentationId: approval.presentationId }]);
      expect(button.hasAttribute("disabled")).toBe(true);
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      expect(await screen.findByText(/No Reminder awaits approval/)).toBeDefined();
      expect((await screen.findByRole("status")).textContent).toContain(
        decision === "approve" ? "Reminder approved." : "Reminder rejected.",
      );
      await user.click(screen.getByRole("button", { name: "Refresh Reminders" }));
      expect(calls).toHaveLength(1);
    },
  );

  it("removes a failed stale approval until the User refreshes", async () => {
    const user = userEvent.setup();
    render(
      <SettingsRemindersPage
        dependencies={{
          inspect: Effect.succeed({ items: [approval] }),
          decide: () => Effect.fail(new RemindersUnavailable({ message: "Already resolved" })),
        }}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Approve exact Reminder" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Approve exact Reminder" })).toBeNull(),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// @vitest-environment happy-dom
import { afterEach, expect, it } from "@effect/vitest";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DateTime } from "effect";

import { AuthStateProvider } from "../auth-state";
import { createAppRouter } from "../router";

afterEach(() => {
  cleanup();
});

it("renders account deletion as an unpresented privacy action", () => {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/settings/privacy"] }),
  });
  render(
    <AuthStateProvider
      value={{
        data: {
          user: {
            name: "Osfo User",
            phoneNumber: "+14165550101",
            registrationCompletedAt: DateTime.toDateUtc(
              DateTime.makeUnsafe("2026-08-18T12:00:00.000Z"),
            ),
          },
        },
        isPending: false,
        refreshFromAuthority: () => Promise.resolve(),
      }}
    >
      <RouterProvider router={router} />
    </AuthStateProvider>,
  );

  return waitFor(() => {
    expect(screen.getByText("Account Deletion")).toBeDefined();
    expect(screen.getByText("Permanent account removal requires confirmation.")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Delete Account" })).toHaveLength(1);
    expect(screen.queryByText("Permanently delete this account and all of its data.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm account deletion" })).toBeNull();
  });
});

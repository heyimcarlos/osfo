// @vitest-environment happy-dom
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */

import type { AccountDeletionActionPresentation } from "@osfo/api";
import { afterEach, expect, it } from "@effect/vitest";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime, Effect } from "effect";
import { vi } from "vitest";

import { AuthStateProvider } from "../auth-state";
import { createAppRouter } from "../router";

const apiClient = vi.hoisted(() => ({
  presentAccountDeletion: vi.fn<() => Promise<AccountDeletionActionPresentation>>(),
  requestAccountDeletion:
    vi.fn<(presentation: AccountDeletionActionPresentation) => Promise<void>>(),
}));

// oxlint-disable-next-line osfo/no-module-mocking, effecttsgo/async-function -- The real route stays intact while this focused web test replaces only its async HTTP client boundary.
vi.mock("../lib/api-client", async () => {
  const { Effect: MockEffect } = await import("effect");
  return {
    presentAccountDeletion: MockEffect.promise(() => apiClient.presentAccountDeletion()),
    requestAccountDeletion: (presentation: AccountDeletionActionPresentation) =>
      MockEffect.promise(() => apiClient.requestAccountDeletion(presentation)),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.effect("requires one server-presented confirmation before deleting the account", () =>
  Effect.gen(function* () {
    const presentation: AccountDeletionActionPresentation = {
      actionId: "account-delete:session-1",
      confirmation: "delete-my-account",
      consequence: "Permanently delete this account and all of its data.",
      operation: "account.delete",
      title: "Delete Account",
    };
    apiClient.presentAccountDeletion.mockImplementation(() => Promise.resolve(presentation));
    apiClient.requestAccountDeletion.mockImplementation(() => Promise.resolve());
    const assign = vi.spyOn(globalThis.location, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
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

    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText("Account Deletion")).toBeDefined()),
    );
    expect(screen.getByText("Permanent account removal requires confirmation.")).toBeDefined();
    yield* Effect.promise(() => user.click(screen.getByRole("button", { name: "Delete Account" })));
    yield* Effect.promise(() =>
      waitFor(() => expect(apiClient.presentAccountDeletion).toHaveBeenCalledOnce()),
    );
    expect(apiClient.requestAccountDeletion).not.toHaveBeenCalled();
    expect(screen.getAllByText("Delete Account")).toHaveLength(2);
    expect(screen.getAllByText(presentation.consequence)).toHaveLength(1);

    yield* Effect.promise(() =>
      user.click(screen.getByRole("button", { name: "Confirm account deletion" })),
    );
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(apiClient.requestAccountDeletion).toHaveBeenCalledExactlyOnceWith(presentation),
      ),
    );
    expect(assign).toHaveBeenCalledExactlyOnceWith("/");
  }),
);

// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect -- Testing Library interactions and fake wall-clock time intentionally drive the React expiry boundary. */
import { AccountDeletionActionUnavailable, type AccountDeletionAction } from "@osfo/api";
import { Unauthorized } from "@osfo/api/middleware/auth";
import { afterEach, expect, it, vi } from "@effect/vitest";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DateTime, Effect } from "effect";

import { AccountDeletionReplayStateProvider } from "../account-deletion-replay-state";
import { AuthStateProvider } from "../auth-state";
import { createAppRouter } from "../router";
import { DeleteAccountControl, type SettingsPrivacyDependencies } from "./settings-privacy-page";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const deletionAction = (actionId: string, expiresAt: Date): AccountDeletionAction => ({
  expiresAt,
  presentation: {
    actionId,
    confirmation: "delete-my-account",
    consequence: "Permanently delete this account and all of its data.",
    operation: "account.delete",
    title: "Delete Account",
  },
  presentationVersion: "account-deletion-v2",
  replayToken: actionId.endsWith("fresh") ? "b".repeat(43) : "a".repeat(43),
});

const renderPrivacyPage = (dependencies: SettingsPrivacyDependencies) =>
  render(
    <AccountDeletionReplayStateProvider
      initial={{
        access: { status: "available", storage: localStorage },
        replay: { status: "missing" },
      }}
    >
      <DeleteAccountControl dependencies={dependencies} />
    </AccountDeletionReplayStateProvider>,
  );

it("renders account deletion as an unpresented privacy action", () => {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/settings/privacy"] }),
  });
  render(
    <AuthStateProvider
      value={{
        data: {
          user: {
            id: "test-user",
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

it("retires an expired confirmation and presents a fresh exact Action without clearing other state", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
  localStorage.setItem("unrelated-setting", "retained");
  let presentations = 0;
  renderPrivacyPage({
    presentAccountDeletion: Effect.sync(() => {
      presentations += 1;
      return deletionAction(
        presentations === 1 ? "account-delete:stale" : "account-delete:fresh",
        new Date(Date.now() + 300_000),
      );
    }),
    requestAccountDeletion: () => Effect.die(new Error("not used")),
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete Account" }));
  await act(async () => undefined);
  expect(screen.getByRole("button", { name: "Confirm account deletion" })).toBeDefined();

  await act(async () => {
    vi.advanceTimersByTime(300_000);
  });

  expect(screen.queryByRole("button", { name: "Confirm account deletion" })).toBeNull();
  expect(screen.getByText("This confirmation has expired.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Request fresh confirmation" }));
  await act(async () => undefined);

  expect(screen.getByRole("button", { name: "Confirm account deletion" })).toBeDefined();
  expect(presentations).toBe(2);
  expect(localStorage.getItem("unrelated-setting")).toBe("retained");
});

it("does not route a proven pre-fence rejection to fenced recovery", async () => {
  const action = deletionAction("account-delete:rejected", new Date(Date.now() + 300_000));
  renderPrivacyPage({
    presentAccountDeletion: Effect.succeed(action),
    requestAccountDeletion: () =>
      Effect.fail(
        new AccountDeletionActionUnavailable({
          message: "Request a fresh account deletion confirmation",
          requestState: "notAccepted",
        }),
      ),
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete Account" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Confirm account deletion" })).toBeDefined(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm account deletion" }));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request fresh confirmation" })).toBeDefined(),
  );
  expect(screen.getByText("Account deletion was not started.")).toBeDefined();
  expect(localStorage.getItem("osfo-account-deletion-replay")).toBeNull();
  expect(globalThis.location.pathname).not.toBe("/account-deletion/recovery");
});

it("clears a session rejection and offers sign-in instead of deletion recovery", async () => {
  renderPrivacyPage({
    presentAccountDeletion: Effect.succeed(
      deletionAction("account-delete:session-ended", new Date(Date.now() + 300_000)),
    ),
    requestAccountDeletion: () => Effect.fail(new Unauthorized({})),
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete Account" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Confirm account deletion" })).toBeDefined(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm account deletion" }));

  await waitFor(() =>
    expect(screen.getByText("Your session no longer authorizes this request.")).toBeDefined(),
  );
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  expect(screen.queryByRole("button", { name: "Request fresh confirmation" })).toBeNull();
  expect(localStorage.getItem("osfo-account-deletion-replay")).toBeNull();
});

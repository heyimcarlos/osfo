// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function -- Testing Library interaction waits intentionally exercise React state transitions. */

import { Unauthorized } from "@osfo/api/middleware/auth";
import { afterEach, expect, it } from "@effect/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";

import { AccountDeletionReplayStateProvider } from "../account-deletion-replay-state";
import { saveAccountDeletionReplay } from "../lib/account-deletion-replay";
import {
  AccountDeletionRecoveryPage,
  type AccountDeletionRecoveryDependencies,
} from "./account-deletion-recovery-page";

const request = {
  approval: {
    decision: "approved" as const,
    presentation: {
      actionId: "account-delete:terminal-replay",
      confirmation: "delete-my-account",
      consequence: "Permanently delete this account and all of its data.",
      operation: "account.delete",
      title: "Delete Account",
    },
  },
  confirmation: "delete-my-account",
  presentationVersion: "account-deletion-v2",
  replayToken: "t".repeat(43),
} as const;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const renderRecovery = (dependencies: AccountDeletionRecoveryDependencies) => {
  saveAccountDeletionReplay(localStorage, request);
  return render(
    <AccountDeletionReplayStateProvider
      initial={{
        access: { status: "available", storage: localStorage },
        replay: { request, status: "available" },
      }}
    >
      <AccountDeletionRecoveryPage dependencies={dependencies} />
    </AccountDeletionReplayStateProvider>,
  );
};

it("clears a non-resumable replay without claiming deletion completed", async () => {
  renderRecovery({ requestAccountDeletion: () => Effect.fail(new Unauthorized({})) });

  fireEvent.click(screen.getByRole("button", { name: "Retry Account Deletion" }));

  await waitFor(() =>
    expect(screen.getByText("This saved request can no longer be resumed.")).toBeDefined(),
  );
  expect(screen.queryByRole("button", { name: "Retry Account Deletion" })).toBeNull();
  expect(screen.queryByText(/account deletion is complete/iu)).toBeNull();
  expect(screen.queryByText(/access.*fenced/iu)).toBeNull();
  expect(localStorage.getItem("osfo-account-deletion-replay")).toBeNull();
});

/* oxlint-disable effecttsgo/async-function -- The user-event test callback follows Vitest's Promise contract. */
import { render, screen } from "@testing-library/react";
import type { AccountDeletionActionPresentation } from "@osfo/api";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { DeleteAccountControl } from "./settings-privacy-page";

it("requires one explicit confirmation before deleting the account", async () => {
  const presentation: AccountDeletionActionPresentation = {
    actionId: "account-delete:session-1",
    confirmation: "delete-my-account",
    consequence: "Permanently delete this account and all of its data.",
    operation: "account.delete",
    title: "Delete Account",
  };
  const present = vi.fn<() => Promise<AccountDeletionActionPresentation>>(() =>
    Promise.resolve(presentation),
  );
  const remove = vi.fn<(approved: AccountDeletionActionPresentation) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const user = userEvent.setup();
  render(<DeleteAccountControl onDelete={remove} onPresent={present} />);

  expect(screen.getByText("Account Deletion")).toBeDefined();
  expect(screen.getByText("Permanent account removal requires confirmation.")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Delete Account" }));
  expect(present).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getAllByText("Delete Account")).toHaveLength(2);
  expect(screen.getAllByText("Permanently delete this account and all of its data.")).toHaveLength(
    1,
  );

  await user.click(screen.getByRole("button", { name: "Confirm account deletion" }));
  expect(remove).toHaveBeenCalledExactlyOnceWith(presentation);
});
// @vitest-environment happy-dom

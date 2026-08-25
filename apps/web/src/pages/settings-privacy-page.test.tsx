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
    consequence: "Permanently delete this account and all of its data",
    operation: "account.delete",
    title: "Delete account",
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
  await user.click(screen.getByRole("button", { name: "Delete Account" }));
  expect(present).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByText("Permanently delete this account and all of its data.")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Confirm account deletion" }));
  expect(remove).toHaveBeenCalledExactlyOnceWith(presentation);
});
// @vitest-environment happy-dom

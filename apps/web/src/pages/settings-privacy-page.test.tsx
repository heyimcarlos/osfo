/* oxlint-disable effecttsgo/async-function -- The user-event test callback follows Vitest's Promise contract. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { DeleteAccountControl } from "./settings-privacy-page";

it("requires one explicit confirmation before deleting the account", async () => {
  const remove = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const user = userEvent.setup();
  render(<DeleteAccountControl onDelete={remove} />);

  await user.click(screen.getByRole("button", { name: "Delete My Data" }));
  expect(remove).not.toHaveBeenCalled();
  expect(
    screen.getByText("This permanently deletes your account and all of its data."),
  ).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Confirm account deletion" }));
  expect(remove).toHaveBeenCalledOnce();
});
// @vitest-environment happy-dom

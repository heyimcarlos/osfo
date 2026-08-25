import { expect, it } from "@effect/vitest";
import { AccountDeletionRequest } from "@osfo/api";
import { Option, Schema } from "effect";

import { ActionId } from "../domain/action-execution";
import { accountDeletionPresentation, isExactApproval } from "./account-deletion-request";

it("keeps presentation versioning in the Worker while the API accepts bounded transport", () => {
  const expected = accountDeletionPresentation(ActionId.make("account-delete-random-1"));
  const exact = {
    approval: { decision: "approved" as const, presentation: expected },
    confirmation: expected.confirmation,
  };
  const drifted = {
    ...exact,
    approval: {
      ...exact.approval,
      presentation: { ...expected, title: "Delete this account" },
    },
  };

  expect(Option.isSome(Schema.decodeOption(AccountDeletionRequest)(exact))).toBe(true);
  expect(Option.isSome(Schema.decodeOption(AccountDeletionRequest)(drifted))).toBe(true);
  expect(expected.consequence).toBe("Permanently delete this account and all of its data.");
  expect(isExactApproval(exact)).toBe(true);
  expect(isExactApproval(drifted)).toBe(false);
  expect(isExactApproval({ ...exact, confirmation: "delete-account" })).toBe(false);
});

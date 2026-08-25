import { expect, it } from "@effect/vitest";
import { AccountDeletionRequest } from "@osfo/api";
import { Option, Schema } from "effect";

import { AuthSessionId } from "../domain/auth-session";
import { accountDeletionPresentation, isExactApproval } from "./account-deletion-request";

it("keeps presentation versioning in the Worker while the API accepts bounded transport", () => {
  const expected = accountDeletionPresentation(AuthSessionId.make("auth-session-1"));
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
  expect(isExactApproval(exact, expected)).toBe(true);
  expect(isExactApproval(drifted, expected)).toBe(false);
  expect(isExactApproval({ ...exact, confirmation: "delete-account" }, expected)).toBe(false);
});

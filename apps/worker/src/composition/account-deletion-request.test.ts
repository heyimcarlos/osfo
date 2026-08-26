import { expect, it } from "@effect/vitest";
import { AccountDeletionRequest } from "@osfo/api";
import { Option, Schema } from "effect";

import { ActionId } from "../domain/action-execution";
import {
  accountDeletionPresentation,
  isExactApproval,
  replayApproval,
} from "./account-deletion-request";

it("keeps presentation versioning in the Worker while the API accepts bounded transport", () => {
  const expected = accountDeletionPresentation(ActionId.make("account-delete-random-1"));
  const exact = {
    approval: { decision: "approved" as const, presentation: expected },
    confirmation: expected.confirmation,
    presentationVersion: "account-deletion-v2",
    replayToken: "a".repeat(43),
  };
  const drifted = {
    ...exact,
    approval: {
      ...exact.approval,
      presentation: { ...expected, title: "Delete this account" },
    },
  };

  expect(Option.isSome(Schema.decodeOption(AccountDeletionRequest)(exact))).toBe(true);
  const withoutReplayToken = { approval: exact.approval, confirmation: exact.confirmation };
  expect(
    Option.isNone(Schema.decodeUnknownOption(AccountDeletionRequest)(withoutReplayToken)),
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeOption(AccountDeletionRequest)({ ...exact, replayToken: "guessable" }),
    ),
  ).toBe(true);
  expect(Option.isSome(Schema.decodeOption(AccountDeletionRequest)(drifted))).toBe(true);
  expect(expected.consequence).toBe("Permanently delete this account and all of its data.");
  expect(isExactApproval(exact)).toBe(true);
  expect(isExactApproval(drifted)).toBe(false);
  expect(isExactApproval({ ...exact, confirmation: "delete-account" })).toBe(false);
});

it("retains the presented version across a later server-version rollover", () => {
  const presentation = accountDeletionPresentation(ActionId.make("account-delete-random-v1"));
  const retainedV1 = {
    approval: { decision: "approved" as const, presentation },
    confirmation: presentation.confirmation,
    presentationVersion: "account-deletion-v1",
    replayToken: "a".repeat(43),
  };

  expect(replayApproval(retainedV1)).toEqual(
    expect.objectContaining({
      value: expect.objectContaining({ presentationVersion: "account-deletion-v1" }),
    }),
  );
  expect(
    replayApproval({ ...retainedV1, presentationVersion: "account-deletion-tampered" }),
  ).toEqual(
    expect.objectContaining({
      value: expect.objectContaining({ presentationVersion: "account-deletion-tampered" }),
    }),
  );
});

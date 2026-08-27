import { expect, it } from "@effect/vitest";
import { AccountDeletionRequest } from "@osfo/api";
import { Option, Schema } from "effect";

import { ActionId } from "../domain/action-execution";
import { accountDeletionPresentation, replayApproval } from "./account-deletion-request";

it("accepts only exact supported server-owned presentation envelopes", () => {
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

  expect(Option.isSome(Schema.decodeUnknownOption(AccountDeletionRequest)(exact))).toBe(true);
  const withoutReplayToken = { approval: exact.approval, confirmation: exact.confirmation };
  expect(
    Option.isNone(Schema.decodeUnknownOption(AccountDeletionRequest)(withoutReplayToken)),
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(AccountDeletionRequest)({ ...exact, replayToken: "guessable" }),
    ),
  ).toBe(true);
  expect(Option.isNone(Schema.decodeUnknownOption(AccountDeletionRequest)(drifted))).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(AccountDeletionRequest)({
        ...exact,
        presentationVersion: "account-deletion-v3",
      }),
    ),
  ).toBe(true);
  expect(expected.consequence).toBe("Permanently delete this account and all of its data.");
});

it("retains the presented version across a later server-version rollover", () => {
  const presentation = accountDeletionPresentation(ActionId.make("account-delete-random-v1"));
  const retainedV1 = {
    approval: { decision: "approved" as const, presentation },
    confirmation: presentation.confirmation,
    presentationVersion: "account-deletion-v1",
    replayToken: "a".repeat(43),
  };

  expect(Option.isSome(Schema.decodeUnknownOption(AccountDeletionRequest)(retainedV1))).toBe(true);
  expect(replayApproval(retainedV1)).toEqual(
    expect.objectContaining({
      value: expect.objectContaining({ presentationVersion: "account-deletion-v1" }),
    }),
  );
  expect(
    replayApproval({ ...retainedV1, presentationVersion: "account-deletion-tampered" }),
  ).toEqual(Option.none());
});

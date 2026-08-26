// @vitest-environment happy-dom
import { beforeEach, expect, it } from "@effect/vitest";

import {
  clearAccountDeletionReplay,
  loadAccountDeletionReplay,
  saveAccountDeletionReplay,
} from "./account-deletion-replay";

const request = {
  approval: {
    decision: "approved" as const,
    presentation: {
      actionId: "account-delete:action-1",
      confirmation: "delete-my-account",
      consequence: "Permanently delete this account and all of its data.",
      operation: "account.delete",
      title: "Delete Account",
    },
  },
  confirmation: "delete-my-account",
  presentationVersion: "account-deletion-v1",
  replayToken: "a".repeat(43),
} as const;

beforeEach(() => {
  localStorage.clear();
});

it("round-trips one immutable versioned account deletion replay request", () => {
  saveAccountDeletionReplay(localStorage, request);

  expect(loadAccountDeletionReplay(localStorage)).toEqual({ request, status: "available" });
});

it("fails altered replay records closed and lets the User clear them", () => {
  const alterations = [
    {
      ...request,
      approval: {
        ...request.approval,
        presentation: { ...request.approval.presentation, title: "DELETE ACCOUNT" },
      },
    },
    {
      ...request,
      approval: {
        ...request.approval,
        presentation: { ...request.approval.presentation, consequence: "Delete some data." },
      },
    },
    {
      ...request,
      approval: {
        ...request.approval,
        presentation: { ...request.approval.presentation, confirmation: "DELETE ACCOUNT" },
      },
    },
    { ...request, confirmation: "DELETE ACCOUNT" },
    { ...request, presentationVersion: "account-deletion-v0" },
  ];

  for (const altered of alterations) {
    localStorage.setItem(
      "osfo-account-deletion-replay",
      JSON.stringify({ request: altered, version: 2 }),
    );
    expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "invalid" });
  }
  clearAccountDeletionReplay(localStorage);
  expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "missing" });
});

it("fails a legacy v1 replay without the exact presented server version closed", () => {
  localStorage.setItem(
    "osfo-account-deletion-replay",
    JSON.stringify({
      request: {
        approval: request.approval,
        confirmation: request.confirmation,
        replayToken: request.replayToken,
      },
      version: 1,
    }),
  );

  expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "invalid" });
});

it("leaves opaque Action identity and bearer authentication to the Worker", () => {
  const syntacticallyValidButUntrusted = {
    ...request,
    approval: {
      ...request.approval,
      presentation: {
        ...request.approval.presentation,
        actionId: "account-delete:edited-action",
      },
    },
    replayToken: "z".repeat(43),
  };
  localStorage.setItem(
    "osfo-account-deletion-replay",
    JSON.stringify({ request: syntacticallyValidButUntrusted, version: 2 }),
  );

  expect(loadAccountDeletionReplay(localStorage)).toEqual({
    request: syntacticallyValidButUntrusted,
    status: "available",
  });
});

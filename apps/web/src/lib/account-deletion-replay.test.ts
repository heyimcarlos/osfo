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
      confirmation: "DELETE ACCOUNT",
      consequence: "Permanently delete this account and all of its data.",
      operation: "account.delete",
      title: "Delete Account",
    },
  },
  confirmation: "DELETE ACCOUNT",
  presentationVersion: "account-deletion-v1",
  replayToken: "a".repeat(43),
};

beforeEach(() => {
  localStorage.clear();
});

it("round-trips one immutable versioned account deletion replay request", () => {
  saveAccountDeletionReplay(localStorage, request);

  expect(loadAccountDeletionReplay(localStorage)).toEqual({ request, status: "available" });
});

it("fails altered replay records closed and lets the User clear them", () => {
  saveAccountDeletionReplay(localStorage, request);
  const key = localStorage.key(0);
  expect(key).not.toBeNull();
  localStorage.setItem(key ?? "missing", '{"version":2,"request":{"confirmation":"ALTERED"}}');

  expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "invalid" });
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

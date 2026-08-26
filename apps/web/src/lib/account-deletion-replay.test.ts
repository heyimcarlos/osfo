// @vitest-environment happy-dom
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { beforeEach, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  clearAccountDeletionReplay,
  loadAccountDeletionReplay,
  prepareAccountDeletionSubmission,
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

it.effect("submits exactly once when replay storage is entirely unavailable", () =>
  Effect.gen(function* () {
    let submissions = 0;
    const unavailableStorage = {
      getItem: () => {
        throw new Error("getItem blocked");
      },
      removeItem: () => {
        throw new Error("removeItem blocked");
      },
      setItem: () => {
        throw new Error("setItem blocked");
      },
    };
    const submission = prepareAccountDeletionSubmission(unavailableStorage, request, (submitted) =>
      Effect.sync(() => {
        submissions += 1;
        expect(submitted).toEqual(request);
        return { status: "deletion-pending" as const };
      }),
    );

    expect(submission.replayAvailable).toBe(false);
    expect(loadAccountDeletionReplay(unavailableStorage)).toEqual({ status: "unavailable" });
    expect(yield* submission.effect).toEqual({ status: "deletion-pending" });
    expect(submissions).toBe(1);
  }),
);

it.effect("does not let a post-success replay clear failure override deletion", () =>
  Effect.gen(function* () {
    let submissions = 0;
    const storage = {
      removeItem: () => {
        throw new Error("removeItem blocked");
      },
      setItem: () => undefined,
    };
    const submission = prepareAccountDeletionSubmission(storage, request, () =>
      Effect.sync(() => {
        submissions += 1;
        return { status: "deletion-pending" as const };
      }),
    );

    expect(submission.replayAvailable).toBe(true);
    expect(yield* submission.effect).toEqual({ status: "deletion-pending" });
    expect(submissions).toBe(1);
  }),
);

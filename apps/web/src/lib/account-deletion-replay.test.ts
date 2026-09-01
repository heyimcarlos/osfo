// @vitest-environment happy-dom
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { AccountDeletionActionUnavailable } from "@osfo/api";
import { Unauthorized } from "@osfo/api/middleware/auth";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  accessBrowserAccountDeletionReplayStorage,
  clearBrowserAccountDeletionReplay,
  clearAccountDeletionReplay,
  loadAccountDeletionReplay,
  loadBrowserAccountDeletionReplay,
  prepareAccountDeletionSubmission,
  prepareBrowserAccountDeletionSubmission,
  saveAccountDeletionReplay,
} from "./account-deletion-replay";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

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

afterEach(() => {
  if (localStorageDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
    return;
  }
  Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
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
    let signedOut = false;
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
    const submission = prepareAccountDeletionSubmission(
      unavailableStorage,
      request,
      (submitted) =>
        Effect.sync(() => {
          submissions += 1;
          expect(submitted).toEqual(request);
          return { status: "deletion-pending" as const };
        }),
      () => {
        signedOut = true;
      },
    );

    expect(submission.replayAvailable).toBe(false);
    expect(loadAccountDeletionReplay(unavailableStorage)).toEqual({ status: "unavailable" });
    expect(yield* submission.effect).toEqual({ status: "deletion-pending" });
    expect(submissions).toBe(1);
    expect(signedOut).toBe(true);
  }),
);

it.effect("does not let a post-success replay clear failure override deletion", () =>
  Effect.gen(function* () {
    let submissions = 0;
    let signedOut = false;
    const storage = {
      removeItem: () => {
        throw new Error("removeItem blocked");
      },
      setItem: () => undefined,
    };
    const submission = prepareAccountDeletionSubmission(
      storage,
      request,
      () =>
        Effect.sync(() => {
          submissions += 1;
          return { status: "deletion-pending" as const };
        }),
      () => {
        signedOut = true;
      },
    );

    expect(submission.replayAvailable).toBe(true);
    expect(yield* submission.effect).toEqual({ status: "deletion-pending" });
    expect(submissions).toBe(1);
    expect(signedOut).toBe(true);
  }),
);

it.effect("clears an exact replay after the Worker proves the request was not accepted", () =>
  Effect.gen(function* () {
    const rejected = new AccountDeletionActionUnavailable({
      message: "Request a fresh account deletion confirmation",
      requestState: "notAccepted",
    });
    const submission = prepareAccountDeletionSubmission(
      localStorage,
      request,
      () => Effect.fail(rejected),
      () => undefined,
    );

    expect(submission.replayAvailable).toBe(true);
    expect(loadAccountDeletionReplay(localStorage)).toEqual({ request, status: "available" });
    expect(Exit.isFailure(yield* Effect.exit(submission.effect))).toBe(true);
    expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "missing" });
  }),
);

it.effect("clears an exact replay after a raw pre-fence rejection status", () =>
  Effect.gen(function* () {
    const httpRequest = HttpClientRequest.delete("https://api.osfo.ai/v1/account");
    const rejected = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request: httpRequest,
        response: HttpClientResponse.fromWeb(httpRequest, new Response(null, { status: 410 })),
      }),
    });
    const submission = prepareAccountDeletionSubmission(
      localStorage,
      request,
      () => Effect.fail(rejected),
      () => undefined,
    );

    expect(Exit.isFailure(yield* Effect.exit(submission.effect))).toBe(true);
    expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "missing" });
  }),
);

it.effect("retains the exact replay when the destructive response is lost", () =>
  Effect.gen(function* () {
    const submission = prepareAccountDeletionSubmission(
      localStorage,
      request,
      () => Effect.die(new Error("response lost")),
      () => undefined,
    );

    expect(Exit.isFailure(yield* Effect.exit(submission.effect))).toBe(true);
    expect(loadAccountDeletionReplay(localStorage)).toEqual({ request, status: "available" });
  }),
);

it.effect("clears an exact replay after terminal 400 or 401 responses", () =>
  Effect.gen(function* () {
    const httpRequest = HttpClientRequest.delete("https://api.osfo.ai/v1/account");
    const badRequestResponse = HttpClientResponse.fromWeb(
      httpRequest,
      new Response(null, { status: 400 }),
    );
    const failures = [
      new Unauthorized({}),
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
          request: httpRequest,
          response: badRequestResponse,
        }),
      }),
    ];

    for (const failure of failures) {
      const submission = prepareAccountDeletionSubmission(
        localStorage,
        request,
        () => Effect.fail(failure),
        () => undefined,
      );
      expect(Exit.isFailure(yield* Effect.exit(submission.effect))).toBe(true);
      expect(loadAccountDeletionReplay(localStorage)).toEqual({ status: "missing" });
    }
  }),
);

it.effect("submits and signs out when the browser storage getter is blocked", () =>
  Effect.gen(function* () {
    let getterReads = 0;
    let signedOut = false;
    let submissions = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        getterReads += 1;
        throw new Error("localStorage getter blocked");
      },
    });

    const storage = accessBrowserAccountDeletionReplayStorage();
    const submission = prepareBrowserAccountDeletionSubmission(
      storage,
      request,
      () =>
        Effect.sync(() => {
          submissions += 1;
          return { status: "deletion-pending" as const };
        }),
      () => {
        signedOut = true;
      },
    );

    expect(storage).toEqual({ status: "unavailable" });
    expect(loadBrowserAccountDeletionReplay(storage)).toEqual({ status: "unavailable" });
    expect(clearBrowserAccountDeletionReplay(storage)).toBe("unavailable");
    expect(yield* submission.effect).toEqual({ status: "deletion-pending" });
    expect(submissions).toBe(1);
    expect(signedOut).toBe(true);
    expect(getterReads).toBe(1);
  }),
);

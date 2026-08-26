// @vitest-environment happy-dom
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */

import type { AccountDeletionActionPresentation } from "@osfo/api";
import { afterEach, expect, it } from "@effect/vitest";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime, Effect } from "effect";
import { vi } from "vitest";

import { AuthStateProvider } from "../auth-state";
import { createAppRouter } from "../router";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it.effect("requires one server-presented confirmation before deleting the account", () =>
  Effect.gen(function* () {
    const presentation: AccountDeletionActionPresentation = {
      actionId: "account-delete:session-1",
      confirmation: "delete-my-account",
      consequence: "Permanently delete this account and all of its data.",
      operation: "account.delete",
      title: "Delete Account",
    };
    const requests: Array<Request> = [];
    globalThis.fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/v1/account/deletion-action"
      ) {
        return Promise.resolve(Response.json(presentation));
      }
      if (request.method === "DELETE" && new URL(request.url).pathname === "/v1/account") {
        return Promise.resolve(Response.json({ status: "deletion-pending" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const assign = vi.spyOn(globalThis.location, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/settings/privacy"] }),
    });
    render(
      <AuthStateProvider
        value={{
          data: {
            user: {
              name: "Osfo User",
              phoneNumber: "+14165550101",
              registrationCompletedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-18T12:00:00.000Z"),
              ),
            },
          },
          isPending: false,
          refreshFromAuthority: () => Promise.resolve(),
        }}
      >
        <RouterProvider router={router} />
      </AuthStateProvider>,
    );

    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText("Account Deletion")).toBeDefined()),
    );
    expect(screen.getByText("Permanent account removal requires confirmation.")).toBeDefined();
    yield* Effect.promise(() => user.click(screen.getByRole("button", { name: "Delete Account" })));
    yield* Effect.promise(() => waitFor(() => expect(requests).toHaveLength(1)));
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]?.url ?? "https://invalid.test").pathname).toBe(
      "/v1/account/deletion-action",
    );
    expect(screen.getAllByText("Delete Account")).toHaveLength(2);
    expect(screen.getAllByText(presentation.consequence)).toHaveLength(1);

    yield* Effect.promise(() =>
      user.click(screen.getByRole("button", { name: "Confirm account deletion" })),
    );
    yield* Effect.promise(() => waitFor(() => expect(requests).toHaveLength(2)));
    const deleteRequest = yield* Effect.fromNullishOr(requests[1]).pipe(Effect.orDie);
    expect(deleteRequest.method).toBe("DELETE");
    expect(new URL(deleteRequest.url).pathname).toBe("/v1/account");
    const payload = yield* Effect.promise(() => deleteRequest.clone().json());
    expect(payload).toEqual({
      approval: { decision: "approved", presentation },
      confirmation: presentation.confirmation,
    });
    expect(assign).toHaveBeenCalledExactlyOnceWith("/");
  }),
);

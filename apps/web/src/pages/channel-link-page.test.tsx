// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { DateTime, Effect } from "effect";

import { AuthStateProvider } from "../auth-state";
import { renderWithTestRouter } from "../testing/router";
import { ChannelLinkPage } from "./channel-link-page";

/* oxlint-disable effecttsgo/async-function -- Testing Library exposes Promise-based DOM queries. */

afterEach(cleanup);

describe("Channel Link Invite page", () => {
  it("waits for Better Auth before choosing an authenticated invitation state", async () => {
    renderWithTestRouter(
      <AuthStateProvider
        value={{
          data: null,
          isPending: true,
          refreshFromAuthority: () => Promise.resolve(),
        }}
      >
        <ChannelLinkPage
          dependencies={{
            accept: () => Effect.die(new Error("Acceptance requires authentication")),
            inspect: () =>
              Effect.succeed({
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T20:00:00.000Z")),
                state: "pending" as const,
              }),
          }}
          token="private.claims"
        />
      </AuthStateProvider>,
    );

    expect(await screen.findByText("Checking your link")).toBeDefined();
    expect(screen.queryByRole("button", { name: "SMS code" })).toBeNull();
  });

  it("keeps a new visitor on the same invitation while presenting Better Auth", async () => {
    renderWithTestRouter(
      <AuthStateProvider
        value={{
          data: null,
          isPending: false,
          refreshFromAuthority: () => Promise.resolve(),
        }}
      >
        <ChannelLinkPage
          dependencies={{
            accept: () => Effect.die(new Error("Acceptance requires authentication")),
            inspect: () =>
              Effect.succeed({
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T20:00:00.000Z")),
                state: "pending" as const,
              }),
          }}
          token="private.claims"
        />
      </AuthStateProvider>,
    );

    expect(await screen.findByText("Link a messaging channel")).toBeDefined();
    expect(screen.getByRole("button", { name: "SMS code" })).toBeDefined();
    expect(screen.queryByText("private.claims")).toBeNull();
  });

  it("shows a safe invitation before accepting it for the current User", async () => {
    const accepted: Array<string> = [];
    const token = "private.claims";
    renderWithTestRouter(
      <AuthStateProvider
        value={{
          data: {
            user: {
              name: "Registered User",
              registrationCompletedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe("2026-08-20T20:00:00.000Z"),
              ),
            },
          },
          isPending: false,
          refreshFromAuthority: () => Promise.resolve(),
        }}
      >
        <ChannelLinkPage
          dependencies={{
            accept: (submitted) => {
              accepted.push(submitted);
              return Effect.succeed({ state: "linked" as const });
            },
            inspect: () =>
              Effect.succeed({
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T20:00:00.000Z")),
                state: "pending" as const,
              }),
          }}
          token={token}
        />
      </AuthStateProvider>,
    );

    expect(await screen.findByText("Link a messaging channel")).toBeDefined();
    expect(screen.queryByText(token)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Link this channel" }));

    await waitFor(() => expect(accepted).toEqual([token]));
    expect(await screen.findByText("Channel linked")).toBeDefined();
  });
});

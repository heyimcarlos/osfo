// @vitest-environment happy-dom

import { AgentId, UserId } from "@osfo/api";
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
            completeRegistration: () =>
              Effect.die(new Error("Registration requires authentication")),
            inspect: () =>
              Effect.succeed({
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T20:00:00.000Z")),
                state: "pending" as const,
              }),
          }}
          token="k7Xm2pRq"
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
            completeRegistration: () =>
              Effect.die(new Error("Registration requires authentication")),
            inspect: () =>
              Effect.succeed({
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T20:00:00.000Z")),
                state: "pending" as const,
              }),
          }}
          token="k7Xm2pRq"
        />
      </AuthStateProvider>,
    );

    expect(await screen.findByText("Continue by SMS")).toBeDefined();
    expect(screen.queryByText("Link a messaging channel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Email and password" })).toBeNull();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.queryByText("k7Xm2pRq")).toBeNull();
  });

  it("shows a safe invitation before accepting it for the current User", async () => {
    const accepted: Array<string> = [];
    const token = "k7Xm2pRq";
    renderWithTestRouter(
      <AuthStateProvider
        value={{
          data: {
            user: {
              id: "test-user",
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
            completeRegistration: () => Effect.die(new Error("Registration is already complete")),
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

    expect(await screen.findByText("Connect this chat")).toBeDefined();
    expect(screen.queryByText("Link a messaging channel")).toBeNull();
    expect(screen.queryByText(token)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Link this channel" }));

    await waitFor(() => expect(accepted).toEqual([token]));
    expect(await screen.findByText("Channel linked")).toBeDefined();
  });

  it("provisions an SMS-verified User without entering website onboarding", async () => {
    const token = "k7Xm2pRq";
    const completed: Array<{
      readonly helpAreas: ReadonlyArray<string>;
      readonly locale: string;
      readonly preferredName: string | null;
    }> = [];
    let refreshed = 0;
    renderWithTestRouter(
      <AuthStateProvider
        value={{
          data: {
            user: {
              id: "test-user",
              name: "New User",
              registrationCompletedAt: null,
            },
          },
          isPending: false,
          refreshFromAuthority: () => {
            refreshed += 1;
            return Promise.resolve();
          },
        }}
      >
        <ChannelLinkPage
          dependencies={{
            accept: () => Effect.die(new Error("Registration must complete first")),
            completeRegistration: (profile) => {
              completed.push(profile);
              return Effect.succeed({
                agentId: AgentId.make("agent-new-user"),
                completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T19:00:00.000Z")),
                userId: UserId.make("user-new-user"),
              });
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

    await waitFor(() => expect(screen.getByText("Connect this chat")).toBeDefined());
    expect(completed).toEqual([
      {
        helpAreas: [],
        locale: "en",
        preferredName: null,
      },
    ]);
    expect(refreshed).toBe(1);
    expect(screen.queryByText("What should Osfo call you?")).toBeNull();
  });
});

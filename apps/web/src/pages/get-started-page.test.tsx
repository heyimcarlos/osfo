// @vitest-environment happy-dom

import { AgentId, UserId } from "@osfo/api";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { DateTime, Effect } from "effect";

import { AuthStateProvider, type AuthState } from "../auth-state";
import type { CompleteOnboardingPayload } from "../lib/api-client";
import { withTestRouter } from "../testing/router";
import { GetStartedPage, type GetStartedPageDependencies } from "./get-started-page";

/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */

afterEach(cleanup);

describe("GetStartedPage", () => {
  it("keeps name, phone verification, and help areas in the website-first order", async () => {
    const user = userEvent.setup();
    const completeCalls: Array<CompleteOnboardingPayload> = [];
    const sentNumbers: Array<string> = [];
    const verifiedNumbers: Array<string> = [];
    let completed = false;
    const dependencies: GetStartedPageDependencies = {
      complete: (input) => {
        completeCalls.push(input);
        return Effect.succeed(webCompletion);
      },
      phoneAuth: {
        sendCode: ({ phoneNumber }) => {
          sentNumbers.push(phoneNumber);
          return Promise.resolve({ error: null });
        },
        verifyCode: ({ phoneNumber }) => {
          verifiedNumbers.push(phoneNumber);
          return Promise.resolve({ error: null });
        },
      },
    };
    const { container } = renderPage(
      <GetStartedPage
        dependencies={dependencies}
        onComplete={() => {
          completed = true;
        }}
      />,
    );

    expect(screen.getByText("What should Osfo call you?")).toBeTruthy();
    expect(screen.queryByLabelText("Phone number")).toBeNull();
    expect(screen.queryByText("Research")).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);

    await user.type(screen.getByLabelText("Your name"), "Ari");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Phone number")).toBeTruthy();
    expect(screen.queryByText("Research")).toBeNull();

    await user.type(screen.getByLabelText("Phone number"), "4165550186");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));

    expect(
      await screen.findByRole("group", { name: "What would you like help with?" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Phone number")).toBeNull();
    await user.click(screen.getByText("Research"));
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(sentNumbers).toEqual(["+14165550186"]);
    expect(verifiedNumbers).toEqual(["+14165550186"]);
    expect(completeCalls).toEqual([
      {
        existingProfileChoice: "apply",
        helpAreas: ["research"],
        invitationToken: null,
        locale: "en",
        preferredName: "Ari",
      },
    ]);
    await waitFor(() => expect(completed).toBe(true));
  });

  it("skips SMS for an authenticated but incomplete account", async () => {
    const user = userEvent.setup();
    const dependencies: GetStartedPageDependencies = {
      complete: () => Effect.succeed(webCompletion),
      phoneAuth: {
        sendCode: () => Promise.resolve({ error: null }),
        verifyCode: () => Promise.resolve({ error: null }),
      },
    };
    renderPage(
      <GetStartedPage dependencies={dependencies} onComplete={() => undefined} />,
      signedInIncomplete,
    );

    await user.type(screen.getByLabelText("Your name"), "Ari");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("group", { name: "What would you like help with?" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Phone number")).toBeNull();
  });
});

const signedOut: AuthState = {
  data: null,
  isPending: false,
  refreshFromAuthority: () => Promise.resolve(),
};

const signedInIncomplete: AuthState = {
  data: {
    user: {
      name: "Osfo User",
      phoneNumber: "+14165550186",
      registrationCompletedAt: null,
    },
  },
  isPending: false,
  refreshFromAuthority: () => Promise.resolve(),
};

const renderPage = (page: React.ReactNode, authState: AuthState = signedOut) =>
  render(withTestRouter(<AuthStateProvider value={authState}>{page}</AuthStateProvider>));

const webCompletion = {
  agentId: AgentId.make("agent-web-complete"),
  channel: { _tag: "NotConnected" as const },
  completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
  profileConfirmationRequired: false,
  userId: UserId.make("user-web-complete"),
};

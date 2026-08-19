// @vitest-environment happy-dom

import { AgentId, ChannelBindingId, UserId } from "@osfo/api";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime, Effect } from "effect";

import { AuthStateProvider, type AuthState } from "../auth-state";
import type { CompleteOnboardingPayload } from "../lib/api-client";
import { withTestRouter } from "../testing/router";
import { VerifyPage, type VerifyPageDependencies } from "./verify-page";

/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */

afterEach(cleanup);

describe("VerifyPage", () => {
  it("opens directly on invitation-scoped SMS and binds without profile questions", async () => {
    const user = userEvent.setup();
    const token = "b".repeat(64);
    const authTokens: Array<string | undefined> = [];
    const completeCalls: Array<CompleteOnboardingPayload> = [];
    const dependencies = makeDependencies({ authTokens, completeCalls });
    let returned = false;
    renderPage(
      <VerifyPage
        dependencies={dependencies}
        token={token}
        onReturnToChannel={() => {
          returned = true;
        }}
      />,
    );

    expect(await screen.findByLabelText("Phone number")).toBeTruthy();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(screen.queryByText("Research")).toBeNull();

    await user.type(screen.getByLabelText("Phone number"), "4165550199");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));

    expect(await screen.findByText("You are connected")).toBeTruthy();
    expect(authTokens).toEqual([token, token]);
    expect(completeCalls).toEqual([
      {
        existingProfileChoice: "keep",
        helpAreas: [],
        invitationToken: token,
        locale: "en",
        preferredName: null,
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Return to Telegram" }));
    expect(returned).toBe(true);
  });

  it("binds an already authenticated account without another profile or SMS step", async () => {
    const completeCalls: Array<CompleteOnboardingPayload> = [];
    renderPage(
      <VerifyPage dependencies={makeDependencies({ completeCalls })} token={"c".repeat(64)} />,
      signedIn,
    );

    expect(await screen.findByText("You are connected")).toBeTruthy();
    expect(screen.queryByLabelText("Phone number")).toBeNull();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(completeCalls).toHaveLength(1);
  });

  it("keeps an unavailable invitation on the verify flow", async () => {
    const dependencies = makeDependencies({
      inspectInvitation: () =>
        Effect.succeed({
          locale: "en",
          maskedPhoneNumber: null,
          provider: "telegram",
          state: "expired",
        }),
    });
    renderPage(<VerifyPage dependencies={dependencies} token={"d".repeat(64)} />);

    expect(await screen.findByText("This link is unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText("Phone number")).toBeNull());
  });
});

const signedOut: AuthState = {
  data: null,
  isPending: false,
  refreshFromAuthority: () => Promise.resolve(),
};

const signedIn: AuthState = {
  data: {
    user: {
      name: "Ari",
      phoneNumber: "+14165550199",
      registrationCompletedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
    },
  },
  isPending: false,
  refreshFromAuthority: () => Promise.resolve(),
};

const renderPage = (page: React.ReactNode, authState: AuthState = signedOut) =>
  render(withTestRouter(<AuthStateProvider value={authState}>{page}</AuthStateProvider>));

const makeDependencies = ({
  authTokens = [],
  completeCalls = [],
  inspectInvitation = () =>
    Effect.succeed({
      locale: "en" as const,
      maskedPhoneNumber: null,
      provider: "telegram" as const,
      state: "live" as const,
    }),
}: {
  readonly authTokens?: Array<string | undefined>;
  readonly completeCalls?: Array<CompleteOnboardingPayload>;
  readonly inspectInvitation?: VerifyPageDependencies["inspectInvitation"];
} = {}): VerifyPageDependencies => ({
  complete: (input) => {
    completeCalls.push(input);
    return Effect.succeed(bindingCompletion);
  },
  inspectInvitation,
  phoneAuth: {
    sendCode: ({ invitationToken }) => {
      authTokens.push(invitationToken);
      return Promise.resolve({ error: null });
    },
    verifyCode: ({ invitationToken }) => {
      authTokens.push(invitationToken);
      return Promise.resolve({ error: null });
    },
  },
});

const bindingCompletion = {
  agentId: AgentId.make("agent-telegram-invitation"),
  channel: {
    _tag: "BindingCreated" as const,
    channelBindingId: ChannelBindingId.make("binding-telegram-invitation"),
  },
  completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z")),
  profileConfirmationRequired: false,
  userId: UserId.make("user-telegram-invitation"),
};

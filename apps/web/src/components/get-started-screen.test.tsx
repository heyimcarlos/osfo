// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AgentId, ChannelBindingId, UserId } from "@osfo/api";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { DateTime, Effect } from "effect";

import type { CompleteOnboardingPayload } from "../lib/api-client";
import { GetStartedScreen, type GetStartedDependencies } from "./get-started-screen";

/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */

afterEach(cleanup);

describe("GetStartedScreen acceptance journeys", () => {
  it("has no automated accessibility violations through profile, notice, and plan stages", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <GetStartedScreen
        dependencies={makeDependencies()}
        isAuthenticated
        onComplete={() => undefined}
      />,
    );

    expect((await axe.run(container)).violations).toEqual([]);
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect((await axe.run(container)).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    expect((await axe.run(container)).violations).toEqual([]);
    expect(screen.getByText(/You are starting on Free/u)).toBeTruthy();
  });

  it("supports an optional-fields-skipped phone journey and SMS code paste", async () => {
    const user = userEvent.setup();
    render(<GetStartedScreen dependencies={makeDependencies()} onComplete={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.type(screen.getByLabelText("Phone number"), "4165550184");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const code = await screen.findByLabelText("Verification code");
    await user.click(code);
    await user.paste("123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));

    expect(await screen.findByText(/You are starting on Free/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm Free/u })).toBeTruthy();
  });

  it("resumes a masked invitation and requires an explicit unselected consent choice", async () => {
    const user = userEvent.setup();
    let inspections = 0;
    const dependencies = makeDependencies({
      inspectInvitation: () => {
        inspections += 1;
        return Effect.succeed({
          locale: "en",
          maskedPhoneNumber: "••••••••0185",
          provider: "whatsapp",
          state: "live",
        });
      },
    });
    render(
      <GetStartedScreen
        dependencies={dependencies}
        invitationToken={"8".repeat(64)}
        isAuthenticated
        onComplete={() => undefined}
      />,
    );

    await waitFor(() => expect(inspections).toBe(1));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    expect(screen.getAllByRole("radio").every((radio) => !radio.hasAttribute("checked"))).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: /Confirm Free/u }));
    expect(screen.getByRole("alert").textContent).toContain("Choose whether");
    expect(dependencies.completeCalls).toEqual([]);
  });

  it("does not bind or welcome until an existing User chooses apply or keep", async () => {
    const user = userEvent.setup();
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
    let completion = 0;
    const dependencies = makeDependencies({
      complete: () => {
        completion += 1;
        return completion === 1
          ? Effect.succeed({
              agentId: AgentId.make("agent-existing"),
              channel: { _tag: "ProfileConfirmationPending" },
              completedAt,
              profileConfirmationRequired: true,
              userId: UserId.make("user-existing"),
            })
          : Effect.succeed({
              agentId: AgentId.make("agent-existing"),
              channel: {
                _tag: "EnrollmentPending",
                enrollmentUrl: new URL(`https://t.me/osfo_test_bot?start=${"7".repeat(64)}`),
              },
              completedAt,
              profileConfirmationRequired: false,
              userId: UserId.make("user-existing"),
            });
      },
    });
    render(
      <GetStartedScreen dependencies={dependencies} isAuthenticated onComplete={() => undefined} />,
    );

    await user.type(screen.getByLabelText("Preferred name"), "New name");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.click(screen.getByRole("button", { name: /Confirm Free/u }));
    expect(await screen.findByText("Keep or update your profile")).toBeTruthy();
    expect(dependencies.completeCalls).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Keep my existing profile" }));
    await waitFor(() => expect(dependencies.completeCalls).toHaveLength(2));
    expect(dependencies.completeCalls[1]).toMatchObject({ existingProfileChoice: "keep" });
    expect(await screen.findByRole("link", { name: /Continue in Telegram/u })).toBeTruthy();
  });

  it("shows safe recovery for an expired, consumed, replaced, or invalid link", async () => {
    const dependencies = makeDependencies({
      inspectInvitation: () =>
        Effect.succeed({
          locale: "en",
          maskedPhoneNumber: null,
          provider: null,
          state: "expired",
        }),
    });
    render(
      <GetStartedScreen
        dependencies={dependencies}
        invitationToken={"9".repeat(64)}
        onComplete={() => undefined}
      />,
    );

    expect(await screen.findByText("This link is unavailable")).toBeTruthy();
    expect(screen.getByText(/Request a fresh registration link/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain("account exists");
  });

  it("localizes the complete setup surface in Spanish", async () => {
    const user = userEvent.setup();
    render(
      <GetStartedScreen
        dependencies={makeDependencies()}
        isAuthenticated
        onComplete={() => undefined}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Language"), "es");
    expect(document.documentElement.lang).toBe("es");
    expect(screen.getByText("¿Cómo puede ayudarte Osfo?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Cómo funciona la configuración")).toBeTruthy();
    expect(screen.getByRole("link", { name: /privacidad/u }).getAttribute("href")).toBe(
      "/privacy?lang=es",
    );
  });

  it("completes web enrollment with country-aware phone formatting and explicit profile facts", async () => {
    const user = userEvent.setup();
    const sentNumbers: Array<string> = [];
    const verifiedNumbers: Array<string> = [];
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
    const dependencies = makeDependencies({
      complete: () =>
        Effect.succeed({
          agentId: AgentId.make("agent-web-complete"),
          channel: {
            _tag: "EnrollmentPending",
            enrollmentUrl: new URL("https://wa.me/14165550100?text=OSFO%20ENROLL%20token"),
          },
          completedAt,
          profileConfirmationRequired: false,
          userId: UserId.make("user-web-complete"),
        }),
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
    });
    render(<GetStartedScreen dependencies={dependencies} onComplete={() => undefined} />);

    await user.type(screen.getByLabelText("Preferred name"), "Ari");
    await user.click(screen.getByText("Research"));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.selectOptions(screen.getByLabelText("Country or region"), "CA");
    await user.type(screen.getByLabelText("Phone number"), "4165550186");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    await user.click(await screen.findByRole("button", { name: /Confirm Free/u }));

    expect(sentNumbers).toEqual(["+14165550186"]);
    expect(verifiedNumbers).toEqual(["+14165550186"]);
    expect(dependencies.completeCalls[0]).toMatchObject({
      helpAreas: ["research"],
      preferredName: "Ari",
    });
    expect(await screen.findByRole("link", { name: /Continue in WhatsApp/u })).toBeTruthy();
  });

  it("shows web enrollment as pending until the WhatsApp control message is received", async () => {
    const user = userEvent.setup();
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
    const dependencies = makeDependencies({
      complete: () =>
        Effect.succeed({
          agentId: AgentId.make("agent-web-pending"),
          channel: {
            _tag: "EnrollmentPending",
            enrollmentUrl: new URL("https://wa.me/14165550100?text=OSFO%20ENROLL%20token"),
          },
          completedAt,
          profileConfirmationRequired: false,
          userId: UserId.make("user-web-pending"),
        }),
    });
    render(
      <GetStartedScreen dependencies={dependencies} isAuthenticated onComplete={() => undefined} />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.click(screen.getByRole("button", { name: /Confirm Free/u }));

    expect(await screen.findByText("WhatsApp connection pending")).toBeTruthy();
    expect(screen.getByText(/Send the enrollment message/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Setup complete");
    expect(document.body.textContent).not.toContain("You are ready");
    expect(document.body.textContent).not.toContain("Your personal Osfo Agent is ready");
  });

  it("shows Telegram web enrollment and keeps the Agent pending until the deep link is used", async () => {
    const user = userEvent.setup();
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
    const dependencies = makeDependencies({
      complete: () =>
        Effect.succeed({
          agentId: AgentId.make("agent-telegram-pending"),
          channel: {
            _tag: "EnrollmentPending",
            enrollmentUrl: new URL(`https://t.me/osfo_test_bot?start=${"a".repeat(64)}`),
          },
          completedAt,
          profileConfirmationRequired: false,
          userId: UserId.make("user-telegram-pending"),
        }),
    });
    render(
      <GetStartedScreen
        dependencies={dependencies}
        enrollmentProvider="telegram"
        isAuthenticated
        onComplete={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.body.textContent).toContain("Telegram processes channel messages");
    expect(document.body.textContent).not.toContain("WhatsApp");
    expect(document.body.textContent).not.toContain("STOP");
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.click(screen.getByRole("button", { name: /Confirm Free/u }));

    expect(await screen.findByText("Telegram connection pending")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Continue in Telegram/u }).getAttribute("href"),
    ).toMatch(/^https:\/\/t\.me\/osfo_test_bot\?start=/u);
    expect(document.body.textContent).not.toContain("You are ready");
  });

  it("uses normal SMS verification for a Telegram-first invitation before consent", async () => {
    const user = userEvent.setup();
    const dependencies = makeDependencies({
      inspectInvitation: () =>
        Effect.succeed({
          locale: "en",
          maskedPhoneNumber: null,
          provider: "telegram",
          state: "live",
        }),
    });
    render(
      <GetStartedScreen
        dependencies={dependencies}
        invitationToken={"b".repeat(64)}
        onComplete={() => undefined}
      />,
    );

    await screen.findByText("How can Osfo help?");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));

    expect(screen.getByLabelText("Phone number").hasAttribute("disabled")).toBe(false);
    await user.type(screen.getByLabelText("Phone number"), "4165550199");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(screen.getByText(/Telegram identity are separate evidence/u)).toBeTruthy();
  });

  it("localizes pending WhatsApp enrollment without ready claims", async () => {
    const user = userEvent.setup();
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
    render(
      <GetStartedScreen
        dependencies={makeDependencies({
          complete: () =>
            Effect.succeed({
              agentId: AgentId.make("agent-web-pending-es"),
              channel: {
                _tag: "EnrollmentPending",
                enrollmentUrl: new URL("https://wa.me/14165550100"),
              },
              completedAt,
              profileConfirmationRequired: false,
              userId: UserId.make("user-web-pending-es"),
            }),
        })}
        isAuthenticated
        onComplete={() => undefined}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Language"), "es");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await user.click(screen.getByRole("button", { name: /verificación/u }));
    await user.click(screen.getByRole("button", { name: /Confirmar Free/u }));

    expect(await screen.findByText("Conexión de WhatsApp pendiente")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Todo listo");
    expect(document.body.textContent).not.toContain("Agente Osfo personal está listo");
  });

  it("shows ready copy only after a confirmed Channel Binding", async () => {
    const user = userEvent.setup();
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"));
    render(
      <GetStartedScreen
        dependencies={makeDependencies({
          complete: () =>
            Effect.succeed({
              agentId: AgentId.make("agent-bound"),
              channel: {
                _tag: "BindingCreated",
                channelBindingId: ChannelBindingId.make("binding-confirmed"),
              },
              completedAt,
              profileConfirmationRequired: false,
              userId: UserId.make("user-bound"),
            }),
        })}
        isAuthenticated
        onComplete={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.click(screen.getByRole("button", { name: /Confirm Free/u }));

    expect(await screen.findByText("You are ready")).toBeTruthy();
    expect(screen.getByText(/Your personal Osfo Agent is ready/u)).toBeTruthy();
  });

  it("shows accessible recovery for wrong, expired, and reused SMS codes", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const dependencies = makeDependencies({
      phoneAuth: {
        sendCode: () => Promise.resolve({ error: null }),
        verifyCode: () => {
          attempts += 1;
          return Promise.resolve({ error: attempts <= 3 ? { attempt: attempts } : null });
        },
      },
    });
    render(<GetStartedScreen dependencies={dependencies} onComplete={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.type(screen.getByLabelText("Phone number"), "4165550187");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const code = await screen.findByLabelText("Verification code");
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(screen.getByRole("alert").textContent).toContain("could not be verified");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(screen.getByRole("alert").textContent).toContain("could not be verified");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(screen.getByRole("alert").textContent).toContain("could not be verified");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(await screen.findByText(/You are starting on Free/u)).toBeTruthy();
  });

  it("shows an accessible recovery action when SMS sending is rate limited", async () => {
    const user = userEvent.setup();
    const dependencies = makeDependencies({
      phoneAuth: {
        sendCode: () => Promise.resolve({ error: { code: "TOO_MANY_REQUESTS" } }),
        verifyCode: () => Promise.resolve({ error: null }),
      },
    });
    render(<GetStartedScreen dependencies={dependencies} onComplete={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Continue to phone verification/u }));
    await user.type(screen.getByLabelText("Phone number"), "4165550188");
    await user.click(screen.getByRole("button", { name: "Send code" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("wait before trying again");
  });

  it("resumes a live invitation after reload or device change with the same token", async () => {
    const token = "6".repeat(64);
    let inspections = 0;
    const dependencies = makeDependencies({
      inspectInvitation: () => {
        inspections += 1;
        return Effect.succeed({
          locale: "en",
          maskedPhoneNumber: null,
          provider: "telegram",
          state: "live",
        });
      },
    });
    const first = render(
      <GetStartedScreen
        dependencies={dependencies}
        invitationToken={token}
        onComplete={() => undefined}
      />,
    );
    expect(await screen.findByText("How can Osfo help?")).toBeTruthy();
    first.unmount();

    render(
      <GetStartedScreen
        dependencies={dependencies}
        invitationToken={token}
        onComplete={() => undefined}
      />,
    );
    expect(await screen.findByText("How can Osfo help?")).toBeTruthy();
    expect(inspections).toBe(2);
  });
});

interface TestDependencies extends GetStartedDependencies {
  readonly completeCalls: Array<CompleteOnboardingPayload>;
}

const makeDependencies = (overrides?: {
  readonly complete?: GetStartedDependencies["complete"];
  readonly inspectInvitation?: GetStartedDependencies["inspectInvitation"];
  readonly phoneAuth?: GetStartedDependencies["phoneAuth"];
}): TestDependencies => {
  const completeCalls: Array<CompleteOnboardingPayload> = [];
  const complete = overrides?.complete ?? (() => Effect.die("Completion was not expected"));
  return {
    complete: (input) => {
      completeCalls.push(input);
      return complete(input);
    },
    completeCalls,
    inspectInvitation:
      overrides?.inspectInvitation ?? (() => Effect.die("Inspection was not expected")),
    phoneAuth: overrides?.phoneAuth ?? {
      sendCode: () => Promise.resolve({ error: null }),
      verifyCode: () => Promise.resolve({ error: null }),
    },
  };
};

// @vitest-environment happy-dom

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Testing Library owns browser Promises and fixtures use fixed wire timestamps. */

import { ChannelLinkId, type ChannelLinksResponse } from "@osfo/api";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";

import {
  channelLinkRevocationPrompt,
  type SettingsChannelsDependencies,
  SettingsChannelsPage,
  SettingsChannelsView,
} from "./settings-channels-page";

afterEach(cleanup);

it("keeps failed disconnects visible and removes only the confirmed link after a successful retry", async () => {
  const targetId = ChannelLinkId.make("channel-link-target");
  const otherId = ChannelLinkId.make("channel-link-other");
  const revoke = vi
    .fn<SettingsChannelsDependencies["revokeChannelLink"]>(() =>
      Effect.succeed({ state: "unlinked" }),
    )
    .mockImplementationOnce(() => Effect.die(new Error("channel disconnect unavailable")));
  render(
    <SettingsChannelsPage
      dependencies={{
        inspectChannelLinks: Effect.succeed({
          items: [
            {
              channel: "telegram",
              channelLinkId: targetId,
              linkedAt: new Date("2026-08-31T12:00:00.000Z"),
            },
            {
              channel: "telegram",
              channelLinkId: otherId,
              linkedAt: new Date("2026-09-01T12:00:00.000Z"),
            },
          ],
        }),
        revokeChannelLink: revoke,
      }}
    />,
  );
  const targetName = "Disconnect Telegram link …k-target, connected 2026-08-31";
  const otherName = "Disconnect Telegram link …nk-other, connected 2026-09-01";
  await userEvent.click(await screen.findByRole("button", { name: targetName }));
  expect(revoke).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("could not be disconnected"),
  );
  expect(screen.getByRole("button", { name: targetName })).toBeDefined();
  expect(screen.getByRole("button", { name: otherName })).toBeDefined();
  expect(revoke).toHaveBeenCalledExactlyOnceWith(targetId);

  await userEvent.click(screen.getByRole("button", { name: targetName }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: targetName })).toBeNull());
  expect(screen.getByRole("button", { name: otherName })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenLastCalledWith(targetId);
});

describe("SettingsChannelsView", () => {
  it("confirms the exact link, contains focus, and supports cancellation without mutation", async () => {
    const channelLinkId = ChannelLinkId.make("channel-link-1");
    const onDisconnect =
      vi.fn<(link: ChannelLinksResponse["items"][number], description: string) => void>();
    render(
      <SettingsChannelsView
        busyLinkId={null}
        error={null}
        summary={{
          items: [
            {
              channel: "telegram",
              channelLinkId,
              linkedAt: new Date("2026-08-31T12:00:00.000Z"),
            },
          ],
        }}
        onDisconnect={onDisconnect}
      />,
    );

    const description = "Telegram link …l-link-1, connected 2026-08-31";
    expect(screen.getByText("Connected")).toBeDefined();
    expect(screen.getByText(description)).toBeDefined();
    expect(screen.queryByText(/telegram-user/u)).toBeNull();

    const trigger = screen.getByRole("button", { name: `Disconnect ${description}` });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Disconnect channel?" });
    expect(within(dialog).getByText(channelLinkRevocationPrompt(description))).toBeDefined();
    expect(onDisconnect).not.toHaveBeenCalled();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm disconnect" });
    expect(document.activeElement).toBe(cancel);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await userEvent.tab();
    expect(document.activeElement).toBe(cancel);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onDisconnect).not.toHaveBeenCalled();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onDisconnect).not.toHaveBeenCalled();

    await userEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(
      {
        channel: "telegram",
        channelLinkId,
        linkedAt: new Date("2026-08-31T12:00:00.000Z"),
      },
      description,
    );
    expect(channelLinkRevocationPrompt(description)).toBe(
      `Disconnect ${description} from Osfo? Messages from this account will no longer reach your agent.`,
    );
  });

  it("directs unlinked channels to a private messenger conversation", () => {
    render(
      <SettingsChannelsView
        busyLinkId={null}
        error={null}
        summary={{ items: [] }}
        onDisconnect={vi.fn<
          (link: ChannelLinksResponse["items"][number], description: string) => void
        >()}
      />,
    );

    expect(screen.getByText(/Send Osfo a private message/u)).toBeDefined();
    expect(screen.getByText(/Links are never posted in group conversations/u)).toBeDefined();
    expect(screen.getAllByText("Not connected")).toHaveLength(2);
  });

  it("does not report channels as disconnected when inspection is unavailable", () => {
    render(
      <SettingsChannelsView
        busyLinkId={null}
        error="Channel links are temporarily unavailable. Please try again."
        summary={null}
        onDisconnect={vi.fn<
          (link: ChannelLinksResponse["items"][number], description: string) => void
        >()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(screen.getAllByText("Connection unavailable")).toHaveLength(2);
    expect(screen.queryByText("Not connected")).toBeNull();
  });
});

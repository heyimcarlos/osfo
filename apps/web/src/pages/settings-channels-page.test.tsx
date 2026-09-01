// @vitest-environment happy-dom

/* oxlint-disable effecttsgo/global-date -- A fixed wire timestamp exercises the browser presentation boundary. */

import { ChannelLinkId, type ChannelLinksResponse } from "@osfo/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { channelLinkRevocationPrompt, SettingsChannelsView } from "./settings-channels-page";

afterEach(cleanup);

describe("SettingsChannelsView", () => {
  it("lists an owner-safe exact link and exposes its destructive action", () => {
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

    fireEvent.click(screen.getByRole("button", { name: `Disconnect ${description}` }));
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

// @vitest-environment happy-dom

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Testing Library waits and a fixed wire timestamp exercise the browser boundary. */

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsChannelsPage } from "./settings-channels-page";

afterEach(cleanup);

describe("SettingsChannelsPage", () => {
  it("lists safe active links and requires the exact confirmation before revocation", async () => {
    const revoke = vi.fn<(channelLinkId: string) => Effect.Effect<{ state: "unlinked" }>>(() =>
      Effect.succeed({ state: "unlinked" as const }),
    );
    const confirm = vi.fn<(message: string) => boolean>(() => false);
    render(
      <SettingsChannelsPage
        dependencies={{
          confirm,
          inspect: Effect.succeed({
            items: [
              {
                channel: "telegram",
                channelLinkId: "channel-link-1",
                linkedAt: new Date("2026-08-31T12:00:00.000Z"),
              },
            ],
          }),
          revoke,
        }}
      />,
    );

    expect(await screen.findByText("Connected")).toBeDefined();
    expect(screen.getByText("Telegram")).toBeDefined();
    expect(screen.queryByText(/telegram-user/u)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Telegram" }));
    expect(confirm).toHaveBeenCalledWith(
      "Disconnect Telegram from Osfo? Messages from this account will no longer reach your agent.",
    );
    expect(revoke).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Telegram" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("channel-link-1"));
    await waitFor(() => expect(screen.getAllByText("Not connected")).toHaveLength(2));
  });

  it("directs unlinked channels to a private messenger conversation", async () => {
    render(
      <SettingsChannelsPage
        dependencies={{
          confirm: vi.fn<(message: string) => boolean>(() => true),
          inspect: Effect.succeed({ items: [] }),
          revoke: vi.fn<(channelLinkId: string) => Effect.Effect<{ state: "unlinked" }>>(() =>
            Effect.succeed({ state: "unlinked" as const }),
          ),
        }}
      />,
    );

    expect(screen.getByText(/Send Osfo a private message/u)).toBeDefined();
    expect(screen.getByText(/Links are never posted in group conversations/u)).toBeDefined();
    expect(await screen.findAllByText("Not connected")).toHaveLength(2);
  });
});

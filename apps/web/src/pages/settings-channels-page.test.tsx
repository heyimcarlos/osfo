// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";

import { SettingsChannelsPage } from "./settings-channels-page";

/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser interaction Promises. */

afterEach(cleanup);

describe("SettingsChannelsPage", () => {
  it("starts an explicit Telegram connection and shows its provider deep link", async () => {
    const user = userEvent.setup();
    const providers: Array<"telegram" | "whatsapp"> = [];
    render(
      <SettingsChannelsPage
        dependencies={{
          startEnrollment: (provider) => {
            providers.push(provider);
            return Effect.succeed({
              enrollmentUrl: new URL("https://t.me/osfo_test_bot?start=test-token"),
              provider,
            });
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Connect Telegram" }));

    const link = await screen.findByRole("link", { name: "Open Telegram" });
    expect(providers).toEqual(["telegram"]);
    expect(link.getAttribute("href")).toBe("https://t.me/osfo_test_bot?start=test-token");
    expect(screen.getByRole("button", { name: "Connect WhatsApp" })).toBeTruthy();
  });
});

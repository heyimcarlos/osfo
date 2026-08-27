import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsIntegrationsContent } from "./settings-integrations-page";

describe("SettingsIntegrationsContent", () => {
  it("shows all provider-neutral lifecycle states without account identifiers", () => {
    const html = renderToStaticMarkup(
      <SettingsIntegrationsContent
        busyToolkit={null}
        connections={[
          {
            description: "Search and read email on demand.",
            label: "Gmail",
            status: "connected",
            toolkit: "gmail",
          },
          {
            description: "Read and manage events.",
            label: "Google Calendar",
            status: "missing",
            toolkit: "googlecalendar",
          },
          {
            description: "Read files and deliver documents.",
            label: "Google Drive",
            status: "unavailable",
            toolkit: "googledrive",
          },
        ]}
        onConnect={vi.fn<(toolkit: "gmail" | "googlecalendar" | "googledrive") => void>()}
        onDisconnect={vi.fn<(toolkit: "gmail" | "googlecalendar" | "googledrive") => void>()}
        onRefresh={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain("Connected");
    expect(html).toContain("Not connected");
    expect(html).toContain("Unavailable here");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Connect");
    expect(html).not.toContain("connectedAccountId");
  });
});

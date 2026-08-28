import { renderToStaticMarkup } from "react-dom/server";
/* oxlint-disable effecttsgo/global-date -- Browser rendering fixtures use fixed wire timestamps. */
import { describe, expect, it, vi } from "vitest";

import {
  ScheduledEmailControlContent,
  SettingsIntegrationsContent,
} from "./settings-integrations-page";

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

describe("ScheduledEmailControlContent", () => {
  it("shows every exact approved field and only privacy-safe terminal status", () => {
    const html = renderToStaticMarkup(
      <ScheduledEmailControlContent
        busyPresentationId={null}
        error={null}
        items={{
          approvals: [
            {
              actionId: "scheduled-email-action",
              consequences: ["Send this exact message at the scheduled instant."],
              description: "Schedule the exact Gmail message and send time shown here.",
              fields: [
                { label: "Recipients", name: "recipients", value: "recipient@example.test" },
                { label: "Subject", name: "subject", value: "Scheduled Email verification" },
                { label: "Body", name: "body", value: "Exact body." },
                { label: "Scheduled for", name: "scheduledAt", value: "2026-08-29T12:00:00Z" },
                { label: "Mailbox", name: "mailbox", value: "Connected primary Gmail mailbox" },
              ],
              presentationId: "scheduled-email-presentation",
              title: "Schedule Gmail message",
            },
          ],
          notifications: [
            {
              deliveredAt: new Date("2026-08-29T12:00:30.000Z"),
              state: "success",
              workflowId: "scheduled-email:verification",
            },
          ],
        }}
        onDecide={vi.fn<(presentationId: string, decision: "approve" | "reject") => void>()}
        onRefresh={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain("recipient@example.test");
    expect(html).toContain("Scheduled Email verification");
    expect(html).toContain("Exact body.");
    expect(html).toContain("2026-08-29T12:00:00Z");
    expect(html).toContain("Connected primary Gmail mailbox");
    expect(html).toContain("Approve exact Scheduled Email");
    expect(html).toContain("Scheduled Email sent");
    expect(html).not.toContain("providerLogId");
  });
});

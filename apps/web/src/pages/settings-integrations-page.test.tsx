import { renderToStaticMarkup } from "react-dom/server";
/* oxlint-disable effecttsgo/global-date -- Browser rendering fixtures use fixed wire timestamps. */
import { describe, expect, it, vi } from "vitest";

import {
  GmailSendControlContent,
  ScheduledEmailControlContent,
  SettingsIntegrationsContent,
} from "./settings-integrations-page";

describe("GmailSendControlContent", () => {
  it("shows the exact immediate send separately from Scheduled Email and safe outcomes only", () => {
    const html = renderToStaticMarkup(
      <GmailSendControlContent
        busyPresentationId={null}
        decision="rejected"
        error={null}
        items={{
          approvals: [
            {
              actionId: "gmail-action",
              consequences: ["This sends one external message immediately."],
              description: "Send the exact Gmail message shown.",
              fields: [
                { label: "Gmail mailbox", name: "gmailResource", value: "primary" },
                { label: "Integration manifest", name: "manifestVersion", value: "gmail-v1" },
                { label: "Recipients", name: "recipients", value: '["recipient@example.test"]' },
                { label: "Subject", name: "subject", value: "Immediate verification" },
                { label: "Message", name: "body", value: "Exact immediate body." },
              ],
              presentationId: "gmail-presentation",
              title: "Send Gmail message",
            },
          ],
          statuses: [
            {
              actionId: "gmail-applied",
              presentationId: "gmail-applied-presentation",
              status: "applied",
            },
            {
              actionId: "gmail-not-applied",
              presentationId: "gmail-not-applied-presentation",
              status: "notApplied",
            },
            {
              actionId: "gmail-ambiguous",
              presentationId: "gmail-ambiguous-presentation",
              status: "ambiguous",
            },
            {
              actionId: "gmail-rejected",
              presentationId: "gmail-rejected-presentation",
              status: "rejected",
            },
            {
              actionId: "gmail-invalidated",
              presentationId: "gmail-invalidated-presentation",
              status: "invalidated",
            },
          ],
        }}
        onDecide={vi.fn<(presentationId: string, decision: "approve" | "reject") => void>()}
        onRefresh={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain("Immediate Gmail Sends");
    expect(html).toContain("primary");
    expect(html).toContain("gmail-v1");
    expect(html).toContain("recipient@example.test");
    expect(html).toContain("Immediate verification");
    expect(html).toContain("Exact immediate body.");
    expect(html).toContain("Approve exact Gmail send");
    expect(html).toContain("Immediate Gmail send rejected. No message was sent.");
    expect(html).toContain("Gmail message sent");
    expect(html).toContain("Gmail message not sent");
    expect(html).toContain("Gmail send rejected — no message was sent");
    expect(html).toContain("Gmail send invalidated — no message was sent");
    expect(html).toContain("Gmail delivery unconfirmed — it may have been sent");
    expect(html).not.toContain("providerLogId");
    expect(html).not.toContain("Scheduled Emails");
  });
});

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
              sendOutcome: "applied",
              state: "success",
              workflowId: "scheduled-email:verification",
            },
            {
              deliveredAt: new Date("2026-08-29T12:01:30.000Z"),
              sendOutcome: "ambiguous",
              state: "failure",
              workflowId: "scheduled-email:unconfirmed",
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
    expect(html).toContain("Scheduled Email delivery unconfirmed — it may have been sent");
    expect(html).not.toContain("providerLogId");
  });

  it("renders canonical late provider truth instead of the original ambiguity snapshot", () => {
    const html = renderToStaticMarkup(
      <ScheduledEmailControlContent
        busyPresentationId={null}
        error={null}
        items={{
          approvals: [],
          notifications: [
            {
              deliveredAt: new Date("2026-08-29T12:00:30.000Z"),
              sendOutcome: "applied",
              state: "success",
              workflowId: "scheduled-email:late-applied",
            },
            {
              deliveredAt: new Date("2026-08-29T12:01:30.000Z"),
              sendOutcome: "notApplied",
              state: "failure",
              workflowId: "scheduled-email:late-not-applied",
            },
          ],
        }}
        onDecide={vi.fn<(presentationId: string, decision: "approve" | "reject") => void>()}
        onRefresh={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain("Scheduled Email sent");
    expect(html).toContain("Scheduled Email not sent");
    expect(html).not.toContain("Scheduled Email delivery unconfirmed");
  });
});

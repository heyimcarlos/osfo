// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "@effect/vitest";
import type { DocumentBuildNotificationSummary } from "@osfo/api";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Effect } from "effect";

import { renderWithTestRouter } from "../../testing/router";
import {
  defaultAgentControlPreferences,
  loadAgentControlPreferences,
  saveAgentControlPreferences,
} from "./agent-control-preferences";
import { OsfoAgentControlPanel } from "./osfo-agent-control-panel";
import { ResearchReportNotificationCenterContent } from "./research-report-notification-center";
import {
  documentExportUrl,
  DocumentBuildNotificationCenterContent,
  DocumentBuildNotificationCenterWithLoader,
} from "./document-build-notification-center";

/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Testing Library and controlled deferred responses own browser Promises. */
/* oxlint-disable effecttsgo/global-date -- Fixed delivered timestamps make notification presentation deterministic. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("OsfoAgentControlPanel", () => {
  it("has no automated accessibility violations", async () => {
    const { container } = renderWithTestRouter(<OsfoAgentControlPanel />);

    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("keeps the selected primary channel synchronized across both controls", async () => {
    const user = userEvent.setup();
    renderWithTestRouter(<OsfoAgentControlPanel />);

    expect(screen.getByRole("radio", { name: "WhatsApp" }).matches(":checked")).toBe(true);
    expect(screen.getByRole("button", { name: /WhatsApp, Preferred/u })).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "Telegram" }));

    expect(screen.getByRole("radio", { name: "Telegram" }).matches(":checked")).toBe(true);
    expect(screen.getByRole("button", { name: /Telegram, Preferred/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /WhatsApp, Available/u })).toBeTruthy();
  });

  it("exposes an operable receive-messages switch", async () => {
    const user = userEvent.setup();
    renderWithTestRouter(<OsfoAgentControlPanel />);
    const receiveSwitch = screen.getByRole("switch", { name: "Receive Messages" });

    expect(receiveSwitch.getAttribute("aria-checked")).toBe("true");
    await user.click(receiveSwitch);
    expect(receiveSwitch.getAttribute("aria-checked")).toBe("false");
  });

  it("supports arrow-key selection in the primary-channel radio group", async () => {
    const user = userEvent.setup();
    renderWithTestRouter(<OsfoAgentControlPanel />);

    await user.click(screen.getByRole("radio", { name: "WhatsApp" }));
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("radio", { name: "Telegram" }).matches(":checked")).toBe(true);
    expect(screen.getByRole("button", { name: /Telegram, Preferred/u })).toBeTruthy();
  });

  it("explains settings that are not supported instead of presenting inert controls", async () => {
    const user = userEvent.setup();
    renderWithTestRouter(<OsfoAgentControlPanel />);

    await user.click(screen.getByRole("button", { name: /Memory/u }));
    expect(screen.getByRole("dialog", { name: "Memory" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Memory/u }));
  });

  it("restores saved browser preferences after remount", async () => {
    const user = userEvent.setup();
    const first = renderWithTestRouter(<OsfoAgentControlPanel />);
    await user.click(screen.getByRole("radio", { name: "Telegram" }));
    first.unmount();

    renderWithTestRouter(<OsfoAgentControlPanel />);
    expect(screen.getByRole("radio", { name: "Telegram" }).matches(":checked")).toBe(true);
  });

  it("degrades to safe in-memory defaults when browser storage is corrupt or unavailable", () => {
    expect(loadAgentControlPreferences({ getItem: () => "v1|sms|off|extra" })).toEqual(
      defaultAgentControlPreferences,
    );
    expect(
      loadAgentControlPreferences({
        getItem: () => Effect.runSync(Effect.fail(new DOMException("denied", "SecurityError"))),
      }),
    ).toEqual(defaultAgentControlPreferences);
    expect(() =>
      saveAgentControlPreferences(
        {
          setItem: () =>
            Effect.runSync(Effect.fail(new DOMException("full", "QuotaExceededError"))),
        },
        defaultAgentControlPreferences,
      ),
    ).not.toThrow();
  });

  it("shows a delivered Research Report result without exposing private report content", async () => {
    const user = userEvent.setup();
    renderWithTestRouter(
      <ResearchReportNotificationCenterContent
        items={[
          {
            artifactContentId: "document:workflow:research:verification",
            deliveredAt: new Date("2026-08-28T12:00:00.000Z"),
            kind: "terminal",
            safeFailureCode: null,
            state: "success",
            workflowId: "research:verification",
          },
        ]}
        open={false}
        onClose={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Notification center, 1 update" })).toBeTruthy();
    cleanup();
    renderWithTestRouter(
      <ResearchReportNotificationCenterContent
        items={[
          {
            artifactContentId: "document:workflow:research:verification",
            deliveredAt: new Date("2026-08-28T12:00:00.000Z"),
            kind: "terminal",
            safeFailureCode: null,
            state: "success",
            workflowId: "research:verification",
          },
        ]}
        open
        onClose={() => undefined}
        onOpen={() => undefined}
      />,
    );
    const notificationCenter = screen.getByRole("dialog", { name: "Notification center" });
    expect(notificationCenter).toBeTruthy();
    expect(notificationCenter.hasAttribute("aria-modal")).toBe(false);
    expect(screen.getByText("Research Report complete")).toBeTruthy();
    expect(screen.getByText("The cited report artifact is ready.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("canonical public source evidence");
    await user.click(screen.getByRole("button", { name: "Close notification center" }));
  });

  it("keeps a delivered Document Build preview progress-only after later success", () => {
    renderWithTestRouter(
      <DocumentBuildNotificationCenterContent
        loadState={{
          _tag: "Ready",
          items: [
            {
              artifactContentId: "document:workflow:document-build:verification",
              deliveredAt: new Date("2026-08-28T12:00:00.000Z"),
              format: "pdf",
              kind: "previewReady",
              safeFailureCode: null,
              state: "success",
              workflowId: "document-build:verification",
            },
          ],
        }}
        open
        onClose={() => undefined}
        onOpen={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("Preview ready")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
  });

  it("builds authenticated export links from production and development API origins", () => {
    const contentId = "document:workflow:document-build:verification";
    expect(documentExportUrl(contentId, "https://api.osfo.ai")).toBe(
      "https://api.osfo.ai/documents/export?contentId=document%3Aworkflow%3Adocument-build%3Averification",
    );
    expect(documentExportUrl(contentId, "http://localhost:8787")).toBe(
      "http://localhost:8787/documents/export?contentId=document%3Aworkflow%3Adocument-build%3Averification",
    );
  });

  it("refreshes Document Build notifications whenever the center reopens", async () => {
    const user = userEvent.setup();
    let loads = 0;
    renderWithTestRouter(
      <DocumentBuildNotificationCenterWithLoader
        loadNotifications={() => {
          loads += 1;
          return Promise.resolve({
            items:
              loads === 1
                ? []
                : [
                    {
                      artifactContentId: "document:workflow:document-build:verification",
                      deliveredAt: new Date("2026-08-28T12:00:00.000Z"),
                      format: "pdf" as const,
                      kind: "terminal" as const,
                      safeFailureCode: null,
                      state: "success" as const,
                      workflowId: "document-build:verification",
                    },
                  ],
          });
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Document Build notifications" }));
    await screen.findByText("No Document Build updates yet.");
    await user.click(screen.getByRole("button", { name: "Close Document Build notifications" }));
    await user.click(screen.getByRole("button", { name: "Document Build notifications" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Download PDF" })).toBeTruthy());
    expect(loads).toBe(2);
  });

  it("shows notification outages and recovers through an explicit retry", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderWithTestRouter(
      <DocumentBuildNotificationCenterWithLoader
        loadNotifications={() => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("temporary outage"))
            : Promise.resolve({ items: [] });
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Document Build notifications" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Document Build updates are temporarily unavailable.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No Document Build updates yet.");
    expect(attempts).toBe(2);
  });

  it("ignores an older notification load after a newer reopen completes", async () => {
    const user = userEvent.setup();
    let resolveFirst:
      | ((value: { readonly items: ReadonlyArray<DocumentBuildNotificationSummary> }) => void)
      | undefined;
    let resolveSecond:
      | ((value: { readonly items: ReadonlyArray<DocumentBuildNotificationSummary> }) => void)
      | undefined;
    let load = 0;
    renderWithTestRouter(
      <DocumentBuildNotificationCenterWithLoader
        loadNotifications={() => {
          load += 1;
          return new Promise((resolve) => {
            if (load === 1) resolveFirst = resolve;
            else resolveSecond = resolve;
          });
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Document Build notifications" }));
    await user.click(screen.getByRole("button", { name: "Close Document Build notifications" }));
    await user.click(screen.getByRole("button", { name: "Document Build notifications" }));
    await act(async () => {
      resolveSecond?.({ items: [successfulDocumentBuildNotification] });
      await Promise.resolve();
    });
    expect(screen.getByRole("link", { name: "Download PDF" })).toBeTruthy();
    await act(async () => {
      resolveFirst?.({ items: [] });
      await Promise.resolve();
    });

    expect(screen.getByRole("link", { name: "Download PDF" })).toBeTruthy();
    expect(screen.queryByText("No Document Build updates yet.")).toBeNull();
  });
});

const successfulDocumentBuildNotification: DocumentBuildNotificationSummary = {
  artifactContentId: "document:workflow:document-build:verification",
  deliveredAt: new Date("2026-08-28T12:00:00.000Z"),
  format: "pdf",
  kind: "terminal",
  safeFailureCode: null,
  state: "success",
  workflowId: "document-build:verification",
};

import { describe, expect, it, vi } from "@effect/vitest";

import { IntegrationTools, type IntegrationToolExecutor } from "./integration-tools";

describe("Integration Tools", () => {
  it("publishes exactly three reads and four Actions with consequence-based Approval", () => {
    const definitions = IntegrationTools.make({
      executeEffect: vi.fn<IntegrationToolExecutor["executeEffect"]>(() =>
        Promise.reject(new Error("not executed")),
      ),
      executeRead: vi.fn<IntegrationToolExecutor["executeRead"]>(() =>
        Promise.reject(new Error("not executed")),
      ),
    });

    expect(Object.keys(definitions.tools)).toEqual([
      "calendarListEvents",
      "driveGetMetadata",
      "gmailFetchThread",
    ]);
    expect(Object.keys(definitions.actions)).toEqual([
      "calendarCreatePrivate",
      "calendarUpdateEvent",
      "gmailCreateDraft",
      "gmailSendEmail",
    ]);
    expect(definitions.actions.gmailCreateDraft.config.approval).toBeUndefined();
    expect(definitions.actions.calendarCreatePrivate.config.approval).toBeUndefined();
    expect(definitions.actions.gmailSendEmail.config).toMatchObject({
      approval: true,
      kind: "durable-pause",
    });
    expect(definitions.actions.calendarUpdateEvent.config).toMatchObject({
      approval: true,
      kind: "durable-pause",
    });
  });
});

import { describe, expect, it } from "@effect/vitest";

import {
  boundedTranscriptWindow,
  planTeardown,
  sanitizeCompanyMessage,
  transcriptMessagesToPrune,
} from "./company-conversation";

/* oxlint-disable effecttsgo/global-date, eslint/no-underscore-dangle -- Pure lifecycle policy consumes Think Date values and Effect tagged unions. */

describe("Company Conversation policy", () => {
  it("removes invitation URLs and messenger snapshots before model intake", () => {
    const invite = "https://osfo.test/verify/user-replayed-token";
    const sanitizedString = sanitizeCompanyMessage(`Can I use ${invite} again?`);
    const sanitizedMessage = sanitizeCompanyMessage({
      id: "telegram:message-1",
      metadata: {
        messenger: {
          message: { text: invite },
        },
      },
      parts: [
        {
          providerMetadata: { test: { secret: invite } },
          text: `I pasted ${invite}`,
          type: "text",
        },
        { type: "step-start" },
      ],
      role: "user",
    });

    expect(sanitizedString).toBe("Can I use [invite removed] again?");
    expect(sanitizedMessage).toEqual({
      id: "telegram:message-1",
      parts: [{ text: "I pasted [invite removed]", type: "text" }],
      role: "user",
    });
    expect(JSON.stringify(sanitizedMessage)).not.toContain("user-replayed-token");
  });

  it("bounds model input on a user boundary", () => {
    const short = [{ role: "user" }, { role: "assistant" }];
    const long = [
      { role: "user" },
      { role: "assistant" },
      { role: "tool" },
      { role: "user" },
      { role: "assistant" },
    ];

    expect(boundedTranscriptWindow(short, 12)).toEqual(short);
    expect(boundedTranscriptWindow(long, 2)).toEqual([{ role: "user" }, { role: "assistant" }]);
  });

  it("selects the oldest durable messages beyond the storage ceiling", () => {
    const history = Array.from({ length: 14 }, (_, index) => ({ id: `message-${index + 1}` }));

    expect(transcriptMessagesToPrune(history, 12)).toEqual(["message-1", "message-2"]);
    expect(transcriptMessagesToPrune(history.slice(0, 12), 12)).toEqual([]);
  });

  it("keeps teardown expiry-only with acceptance before idle deadlines", () => {
    const lastActivityAt = new Date("2026-08-21T12:00:00.000Z");
    const at = (hours: number) => new Date(lastActivityAt.getTime() + hours * 3_600_000);

    expect(planTeardown({ lastActivityAt, linked: true, now: at(1) })).toEqual({
      _tag: "Destroy",
    });
    expect(planTeardown({ lastActivityAt, linked: false, now: at(25) })).toEqual({
      _tag: "Destroy",
    });
    expect(planTeardown({ lastActivityAt, linked: false, now: at(7) })).toEqual({
      _tag: "Wait",
      at: at(12),
    });
    expect(planTeardown({ lastActivityAt, linked: null, now: at(2) })._tag).toBe("Wait");
  });
});

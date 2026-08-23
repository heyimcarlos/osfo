import { describe, expect, it } from "@effect/vitest";

import { AssistantMessageId, SessionId } from "../../domain";
import { projectCommittedConversationDelta } from "./memory-provider-projection";

/* oxlint-disable eslint/no-underscore-dangle -- Effect Option and tagged metadata use the canonical _tag discriminator. */

const sessionId = SessionId.make("session-1");
const assistantMessageId = AssistantMessageId.make("assistant-2");

describe("committed conversation projection", () => {
  it("captures only the new visible delta and sanitizes supported outcomes and sources", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "old", type: "text" }],
        role: "user",
      },
      { id: "assistant-1", parts: [{ text: "old answer", type: "text" }], role: "assistant" },
      {
        id: "user-2",
        metadata: managedMetadata(),
        parts: [
          { text: "Remember this. api_key=very-secret-value", type: "text" },
          { type: "file", url: "data:text/plain;base64,c2VjcmV0" },
        ],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [
          { text: "Final answer", type: "text" },
          { text: "private chain of thought", type: "reasoning" },
          {
            output: { count: 2, token: "hidden", values: ["one", "two"] },
            state: "output-available",
            title: "Search result",
            toolCallId: "call-1",
            type: "tool-search",
          },
          {
            sourceId: "source-1",
            title: "Visible source",
            type: "source-url",
            url: "https://user:password@example.com/article?token=hidden#private",
          },
          { state: "streaming", text: "aborted output", type: "text" },
          { errorText: "provider stack trace", state: "output-error", type: "tool-search" },
        ],
        role: "assistant",
      },
    ] as const;
    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value).toEqual({
      allowancePeriodId: "allowance-1",
      firstMessageId: "user-2",
      lastMessageId: "assistant-2",
      messages: [
        { content: "Remember this. [redacted]", role: "user" },
        {
          content:
            'Final answer\nSearch result: {"count":2,"values":["one","two"]}\nVisible source: https://example.com/article',
          role: "assistant",
        },
      ],
      sessionId: "session-1",
      userId: "user-1",
    });
  });

  it("does not project a turn without trusted managed-turn attribution", () => {
    const history = [
      { id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" },
      { id: "assistant-2", parts: [{ text: "hi", type: "text" }], role: "assistant" },
    ] as const;
    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("None");
  });

  it("does not reuse managed-turn attribution from an earlier delta", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "first", type: "text" }],
        role: "user",
      },
      { id: "assistant-1", parts: [{ text: "first answer", type: "text" }], role: "assistant" },
      { id: "user-2", parts: [{ text: "second", type: "text" }], role: "user" },
      { id: "assistant-2", parts: [{ text: "second answer", type: "text" }], role: "assistant" },
    ] as const;

    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("None");
  });

  it("retains nested human-readable tool outcomes", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Find the source", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [
          {
            output: {
              results: [
                { title: "First", url: "https://example.com/first" },
                {
                  cookie: "session=hidden",
                  host: "db.internal",
                  message: 'result={"password":"hunter2","answer":"safe","raw":"trace"}',
                  note: '{"password":"hunter2","answer":"safe"}',
                  password: "hidden",
                  raw: "provider trace",
                  report: "public finding",
                  region: "yyz",
                  requestId: "request-infrastructure",
                  server: "origin-1",
                  service: "search",
                  statusCode: 200,
                  title: "Second",
                  url: "https://user:password@example.com/second?token=hidden#trace",
                },
              ],
            },
            state: "output-available",
            title: "Search",
            type: "tool-search",
          },
        ],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.messages[1]?.content).toBe(
      'Search: {"results":[{"title":"First","url":"https://example.com/first"},{"message":"result={\\"answer\\":\\"safe\\"}","note":{"answer":"safe"},"report":"public finding","title":"Second","url":"https://example.com/second"}]}',
    );
  });

  it("retains public DNS sources whose names begin with IPv6-looking letters", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Find it", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [{ title: "Public source", type: "source-url", url: "https://fdic.gov/news" }],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.messages[1]?.content).toBe("Public source: https://fdic.gov/news");
  });

  it("excludes IPv4-mapped private IPv6 sources", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Find it", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [
          { text: "No public source", type: "text" },
          { title: "Internal", type: "source-url", url: "https://[::ffff:10.0.0.1]/trace" },
        ],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.messages[1]?.content).toBe("No public source");
  });

  it("redacts common credential formats from visible text", () => {
    const credentials = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "authorization: slack-test-value",
      "AIzaSyD-abcdefghijklmnopqrstuvwxyz12345",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: credentials, type: "text" }],
        role: "user",
      },
      { id: "assistant-2", parts: [{ text: "Done", type: "text" }], role: "assistant" },
    ] as const;

    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.messages[0]?.content).toBe(
      ["[redacted]", "[redacted]", "[redacted]", "[redacted]", "[redacted]"].join("\n"),
    );
  });

  it("sanitizes quoted JSON credentials and URL userinfo in visible text", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [
          {
            text: 'config={"password":"hunter2","answer":"safe","raw":"trace"}',
            type: "text",
          },
        ],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [{ text: "See https://user:password@example.com/article", type: "text" }],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationDelta(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.messages).toEqual([
      { content: 'config={"answer":"safe"}', role: "user" },
      { content: "See https://example.com/article", role: "assistant" },
    ]);
  });
});

const managedMetadata = () => ({
  turnMetadata: {
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "allowance-1",
    authorityIdentity: { _tag: "AuthSession", authSessionId: "auth-session-1", userId: "user-1" },
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "AuthSession",
        authSessionId: "auth-session-1",
        expiresAt: "2026-08-23T13:00:00.000Z",
        userId: "user-1",
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-23T12:00:00.000Z",
      originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-session-1" },
      resourceOwnerUserId: "user-1",
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId: "user-1" },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-session-1" },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "route-1",
    sessionId: "session-1",
    submissionId: "submission-1",
    targetInputTokens: 18_000,
  },
});

import { describe, expect, it } from "@effect/vitest";

import { AssistantMessageId, SessionId } from "../../domain";
import {
  projectCommittedConversationSnapshot,
  projectTerminalMarkedCommittedTurns,
} from "./memory-provider-projection";

/* oxlint-disable eslint/no-underscore-dangle -- Effect Option and tagged metadata use the canonical _tag discriminator. */

const sessionId = SessionId.make("session-1");
const assistantMessageId = AssistantMessageId.make("assistant-2");

describe("committed conversation projection", () => {
  it("captures the visible conversation and sanitizes supported outcomes and sources", () => {
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
    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value).toEqual({
      allowancePeriodId: "allowance-1",
      conversation: {
        messages: [
          { content: "old", role: "user" },
          { content: "old answer", role: "assistant" },
          { content: "Remember this. [redacted]", role: "user" },
          {
            content:
              'Final answer\nSearch result: {"count":2,"values":["one","two"]}\nVisible source: https://example.com/article',
            role: "assistant",
          },
        ],
        usageStartIndex: 2,
      },
      lastMessageId: "assistant-2",
      sessionId: "session-1",
      userId: "user-1",
    });
  });

  it("does not project a turn without trusted managed-turn attribution", () => {
    const history = [
      { id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" },
      { id: "assistant-2", parts: [{ text: "hi", type: "text" }], role: "assistant" },
    ] as const;
    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("None");
  });

  it("recovers a terminal-marked completed turn after activation restart", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Remember this", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        metadata: {
          osfoCommittedTurn: {
            attribution: {
              allowancePeriodId: "allowance-1",
              sessionId: "session-1",
              userId: "user-1",
            },
            requestId: "request-2",
            status: "completed",
          },
        },
        parts: [{ text: "I will remember it", type: "text" }],
        role: "assistant",
      },
    ] as const;

    expect(projectTerminalMarkedCommittedTurns(history, sessionId)).toMatchObject([
      {
        assistantMessageId: "assistant-2",
        projection: {
          conversation: {
            messages: [
              { content: "Remember this", role: "user" },
              { content: "I will remember it", role: "assistant" },
            ],
            usageStartIndex: 0,
          },
        },
        terminal: { requestId: "request-2", status: "completed" },
      },
    ]);
  });

  it("does not enqueue provider ingestion for an exhausted continuity turn", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Delete my current session", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        metadata: {
          osfoCommittedTurn: {
            attribution: {
              allowancePeriodId: "allowance-1",
              executionMode: "exhaustedConversation",
              sessionId: "session-1",
              userId: "user-1",
            },
            requestId: "request-2",
            status: "completed",
          },
        },
        parts: [{ text: "Please confirm deletion", type: "text" }],
        role: "assistant",
      },
    ] as const;

    expect(projectTerminalMarkedCommittedTurns(history, sessionId)).toMatchObject([
      { assistantMessageId: "assistant-2", projection: undefined },
    ]);
  });

  it("excludes an earlier terminal-marked aborted assistant from later snapshots", () => {
    const finalAssistantMessageId = AssistantMessageId.make("assistant-3");
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Try the first answer", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-1",
        metadata: {
          osfoCommittedTurn: {
            requestId: "request-1",
            status: "aborted",
          },
        },
        parts: [
          { state: "done", text: "Partial output that must not be remembered", type: "text" },
        ],
        role: "assistant",
      },
      {
        id: "user-2",
        metadata: managedMetadata(),
        parts: [{ text: "Try again", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-3",
        parts: [{ text: "Successful answer", type: "text" }],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationSnapshot(
      history,
      finalAssistantMessageId,
      sessionId,
    );

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation).toEqual({
      messages: [
        { content: "Try the first answer", role: "user" },
        { content: "Try again", role: "user" },
        { content: "Successful answer", role: "assistant" },
      ],
      usageStartIndex: 1,
    });
  });

  it("captures an assistant-only continuation from its durable terminal attribution", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Run the tool", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-1",
        parts: [
          { text: "Working", type: "text" },
          {
            output: "done",
            state: "output-available",
            title: "Tool result",
            type: "tool-search",
          },
        ],
        role: "assistant",
      },
      {
        id: "assistant-2",
        metadata: {
          osfoCommittedTurn: {
            attribution: {
              allowancePeriodId: "allowance-1",
              sessionId: "session-1",
              userId: "user-1",
            },
            requestId: "request-2",
            status: "completed",
          },
        },
        parts: [{ text: "The tool finished", type: "text" }],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value).toMatchObject({
      conversation: {
        messages: [
          { content: "Run the tool", role: "user" },
          { content: "Working\nTool result: done", role: "assistant" },
          { content: "The tool finished", role: "assistant" },
        ],
        usageStartIndex: 1,
      },
      userId: "user-1",
    });
  });

  it("includes a delayed prior-assistant tool outcome in the next turn's usage evidence", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Run the tool", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-1",
        parts: [
          { text: "Waiting for approval", type: "text" },
          {
            output: "approved result",
            state: "output-available",
            title: "Tool result",
            type: "tool-search",
          },
        ],
        role: "assistant",
      },
      {
        id: "user-2",
        metadata: managedMetadata(),
        parts: [{ text: "Now summarize it", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [{ text: "Summary", type: "text" }],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation).toMatchObject({ usageStartIndex: 1 });
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

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

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

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages[1]?.content).toBe(
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

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages[1]?.content).toBe(
      "Public source: https://fdic.gov/news",
    );
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

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages[1]?.content).toBe("No public source");
  });

  it("redacts credentials from public source URL paths", () => {
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
          {
            title: "Public source",
            type: "source-url",
            url: "https://example.com/ghp_abcdefghijklmnopqrstuvwxyz1234567890/report",
          },
        ],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages[1]?.content).toBe(
      "Public source: https://example.com/[redacted]/report",
    );
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

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages[0]?.content).toBe(
      ["[redacted]", "[redacted]", "[redacted]", "[redacted]", "[redacted]"].join("\n"),
    );
  });

  it("redacts credentials from source and tool labels", () => {
    const history = [
      {
        id: "user-1",
        metadata: managedMetadata(),
        parts: [{ text: "Summarize the results", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-2",
        parts: [
          {
            title: "Source api_key=source-secret",
            type: "source-url",
            url: "https://example.com/article",
          },
          {
            filename: "authorization=bearer-secret",
            title: "Document token=document-secret",
            type: "source-document",
          },
          {
            output: "public result",
            state: "output-available",
            title: "Search password=tool-secret",
            type: "tool-search",
          },
        ],
        role: "assistant",
      },
    ] as const;

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages[1]?.content).toBe(
      [
        "Source [redacted]: https://example.com/article",
        "Document [redacted] ([redacted])",
        "Search [redacted]: public result",
      ].join("\n"),
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

    const projection = projectCommittedConversationSnapshot(history, assistantMessageId, sessionId);

    expect(projection._tag).toBe("Some");
    if (projection._tag === "None") return;
    expect(projection.value.conversation.messages).toEqual([
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

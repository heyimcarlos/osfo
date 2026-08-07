// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react";
import { AcceptanceReceipt } from "@osfo/api";
import { describe, expect, it } from "@effect/vitest";
import {
  applyThreadEvent,
  makeAgentRunSucceeded,
  makeAssistantOutputAppended,
  makeAssistantOutputCompleted,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
} from "@osfo/session";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { makeThreadChat } from "./chat/atoms";
import { makeThreadProjectionStore } from "./chat/projection-store";
import { ConfigurationRequired } from "./configuration-required";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const receipt = new AcceptanceReceipt({
  acceptedAt: "2026-08-06T14:32:00.000Z",
  agentRunId: "f3466bd9-26e6-456e-904c-456198b23a57",
  idempotencyKey: "1429eaac-2f56-4a7e-b78c-ddd58a9d0f99",
  protocolVersion: 1,
  receiptId: "10fc5bd9-ca92-46aa-bd36-d305157defd2",
  threadId,
  threadPosition: "1",
  userMessageId: "2aa53c48-fdcf-4131-ab5f-7b04cfa8363e",
});

const makeTestChat = () =>
  makeThreadChat({
    authenticationToken: "reference-session",
    baseUrl: "https://osfo.test",
    clientInstanceId: "A",
    threadId,
    submitMessage: () => Effect.succeed(receipt),
  });

describe("browser reference client", () => {
  it("composes an empty durable Thread from shared chat primitives", () => {
    const chat = makeTestChat();
    const html = renderToStaticMarkup(
      <RegistryProvider>
        <App chat={chat} threadId={threadId} />
      </RegistryProvider>,
    );

    expect(html).toContain("Start the durable Thread");
    expect(html).toContain("Tab A");
    expect(html).toContain("Synchronizing");
    expect(html).toContain('data-slot="message-scroller"');
    expect(html).toContain('data-slot="message-composer"');
  });

  it("renders an accepted message from its canonical projection source", () => {
    const chat = makeTestChat();
    const html = renderToStaticMarkup(
      <RegistryProvider
        initialValues={[
          [
            chat.messages,
            [
              {
                type: "userMessage",
                messageId: receipt.userMessageId,
                agentRunId: receipt.agentRunId,
                content: "Hello through React",
                eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
                occurredAt: receipt.acceptedAt,
                threadPosition: receipt.threadPosition,
                userMessageId: receipt.userMessageId,
              },
            ],
          ],
        ]}
      >
        <App chat={chat} threadId={threadId} />
      </RegistryProvider>,
    );

    expect(html).toContain("Hello through React");
    expect(html).toContain("Canonical at position 1");
    expect(html).toContain("34dc8a78-a94d-4050-8c5b-e3bf21077c40");
    expect(html).toContain(receipt.agentRunId);
  });

  it("renders committed assistant output from the canonical projection", () => {
    const chat = makeTestChat();
    const assistantOutputId = "86290831-b9ca-414a-abf1-4055b5347133";
    const html = renderToStaticMarkup(
      <RegistryProvider
        initialValues={[
          [
            chat.messages,
            [
              {
                type: "assistantOutput",
                messageId: assistantOutputId,
                assistantOutputId,
                agentRunId: receipt.agentRunId,
                content: "Echo: Hello through React",
                eventId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
                occurredAt: receipt.acceptedAt,
                threadPosition: "2",
                status: { type: "completed" },
              },
            ],
          ],
        ]}
      >
        <App chat={chat} threadId={threadId} />
      </RegistryProvider>,
    );

    expect(html).toContain("Echo: Hello through React");
    expect(html).toContain(assistantOutputId);
    expect(html).toContain("Canonical at position 2");
  });

  it("renders a client-safe Action receipt from the canonical projection", () => {
    const chat = makeTestChat();
    const toolCallId = "tool_4ad4707e-a960-448b-ab7b-6edcc7ae213f";
    const html = renderToStaticMarkup(
      <RegistryProvider
        initialValues={[
          [
            chat.messages,
            [
              {
                type: "actionReceipt",
                messageId: toolCallId,
                toolCallId,
                agentRunId: receipt.agentRunId,
                approval: {
                  type: "approved",
                  approvalRequestId: "32e520b0-224a-4ab4-aa49-b7d2defb43f0",
                },
                content: [
                  "Send demo email",
                  "Destination: Controlled development inbox",
                  "Subject: Development Action proof",
                  "Outcome: applied",
                  "Boundary: controlled sink stored one message with the Action stable Message-ID",
                  "Does not prove: delivery to a real recipient",
                ].join("\n"),
                eventId: "b399f65c-0274-40b4-aa4d-e7b80f8c531c",
                occurredAt: receipt.acceptedAt,
                outcome: "applied",
                successBoundary: {
                  name: "mailpitMessageStored",
                  version: 1,
                  appliedMeans:
                    "controlled sink stored one message with the Action stable Message-ID",
                  doesNotProve: "delivery to a real recipient",
                },
                threadPosition: "3",
              },
            ],
          ],
        ]}
      >
        <App chat={chat} threadId={threadId} />
      </RegistryProvider>,
    );

    expect(html).toContain("Outcome: applied");
    expect(html).toContain("Controlled development inbox");
    expect(html).toContain("Does not prove: delivery to a real recipient");
    expect(html).toContain(toolCallId);
    expect(html).not.toContain("osfo-demo-recipient@example.invalid");
  });

  it("resumes committed assistant output through the API and renders it reactively", async () => {
    const assistantOutputId = "86290831-b9ca-414a-abf1-4055b5347133";
    const eventInput = {
      threadId,
      userMessageId: receipt.userMessageId,
      agentRunId: receipt.agentRunId,
      occurredAt: receipt.acceptedAt,
    };
    const events = [
      Effect.runSync(
        makeUserMessageAppended({
          ...eventInput,
          eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
          threadPosition: "1",
          content: "Hello through resume",
        }),
      ),
      Effect.runSync(
        makeAssistantOutputAppended({
          ...eventInput,
          eventId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
          threadPosition: "2",
          assistantOutputId,
          content: "Echo: Hello through resume",
        }),
      ),
      Effect.runSync(
        makeAssistantOutputCompleted({
          ...eventInput,
          eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          threadPosition: "3",
          assistantOutputId,
        }),
      ),
      Effect.runSync(
        makeAgentRunSucceeded({
          ...eventInput,
          eventId: "269787db-071e-4478-806f-1d85d00b7337",
          threadPosition: "4",
        }),
      ),
    ];
    const snapshot = events.reduce(
      (projection, event, index) =>
        Effect.runSync(
          applyThreadEvent(projection, { ...event, cursor: `cursor-position-${index + 1}` }),
        ),
      Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" })),
    );
    const streamRequested = Deferred.makeUnsafe<void>();
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      clientInstanceId: "A",
      threadId,
      projectionStore: makeThreadProjectionStore({ storage: new MemoryStorage(), threadId }),
      submitMessage: () => Effect.succeed(receipt),
    });
    const originalFetch = globalThis.fetch;
    const requestedPaths: Array<string> = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requestedPaths.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/snapshot")) {
        return new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/events")) {
        Effect.runSync(Deferred.succeed(streamRequested, undefined));
        return new Response(
          `event: caught_up\ndata: ${JSON.stringify({
            throughPosition: snapshot.throughPosition,
            throughCursor: snapshot.throughCursor,
          })}\n\n`,
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      }
      return new Response(undefined, { status: 404 });
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const hadReactActEnvironment = Object.hasOwn(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    const originalReactActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    try {
      await act(() => {
        root.render(
          <RegistryProvider>
            <App chat={chat} threadId={threadId} />
          </RegistryProvider>,
        );
      });
      await Effect.runPromise(Deferred.await(streamRequested));
      await act(async () => undefined);

      expect(requestedPaths).toContain(`/v1/threads/${threadId}/snapshot`);
      expect(requestedPaths).toContain(
        `/v1/threads/${threadId}/events?after=${encodeURIComponent(snapshot.throughCursor)}`,
      );
      expect(container.innerHTML).toContain("Echo: Hello through resume");
      expect(container.innerHTML).toContain(assistantOutputId);
      expect(container.innerHTML).toContain("Canonical at position 2");
      expect(container.innerHTML).toContain("Reconnecting");
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      if (hadReactActEnvironment) {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalReactActEnvironment);
      } else {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      }
    }
  });

  it("explains the explicit configuration when browser authority is missing", () => {
    const html = renderToStaticMarkup(<ConfigurationRequired />);

    expect(html).toContain('type="password"');
    expect(html).toContain("Authentication token");
    expect(html).toContain("Thread ID");
    expect(html).toContain("Connect this tab");
    expect(html).not.toContain("VITE_OSFO_AUTHENTICATION_TOKEN");
  });
});

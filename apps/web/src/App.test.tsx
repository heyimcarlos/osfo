import { RegistryProvider } from "@effect/atom-react";
import { AcceptanceReceipt } from "@osfo/api";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { makeThreadChat } from "./chat/atoms";
import { ConfigurationRequired } from "./configuration-required";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";

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

  it("explains the explicit configuration when browser authority is missing", () => {
    const html = renderToStaticMarkup(<ConfigurationRequired />);

    expect(html).toContain("VITE_OSFO_THREAD_ID");
    expect(html).toContain("db:seed:reference");
  });
});

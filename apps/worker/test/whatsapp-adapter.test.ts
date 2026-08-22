import { splitMessage } from "@chat-adapter/whatsapp";
import { deliverMessengerReply } from "@cloudflare/think/messengers";
import { describe, expect, it } from "@effect/vitest";

import { makeOsfoMessengerRouter } from "../src/agents/osfo/messenger-routing";
import { makeWhatsAppAdapter, makeWhatsAppChannel } from "../src/integrations/whatsapp";

/* oxlint-disable effecttsgo/async-function, osfo/no-runtime-typeof -- Official Chat SDK tests implement Promise-based callbacks and distinguish the documented delivery union. */

describe("Official WhatsApp adapter boundary", () => {
  it("accepts only the configured GET verification token", async () => {
    const adapter = makeWhatsAppAdapter({
      accessToken: "test-access-token",
      appSecret: "test-app-secret",
      phoneNumberId: "123456789",
      userName: "osfo_test",
      verifyToken: "test-verify-token",
    });
    const accepted = await adapter.handleWebhook(
      verificationRequest("test-verify-token", "challenge-1"),
    );
    const rejected = await adapter.handleWebhook(verificationRequest("wrong", "challenge-2"));

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("challenge-1");
    expect(rejected.status).toBe(403);
  });

  it("uses the product binding resolver and never invents an Agent facet", async () => {
    const resolved: Array<string> = [];
    const resolver = makeOsfoMessengerRouter({
      hasAgent: (agentId) => agentId === "agent-bound",
      resolveAgentId: async (authorId) => {
        resolved.push(authorId);
        return authorId === "15550000001" ? "agent-bound" : "agent-missing";
      },
    });

    await expect(resolver(event("15550000001"))).resolves.toMatchObject({
      name: "agent-bound",
      target: "subagent",
    });
    await expect(resolver(event("15550000002"))).resolves.toEqual({ target: "self" });
    expect(resolved).toEqual(["15550000001", "15550000002"]);
  });

  it("uses the official 4096-character delivery split", () => {
    const chunks = splitMessage(`${"a".repeat(4_090)}\n\n${"b".repeat(100)}`);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 4_096)).toBe(true);
    expect(chunks.join("")).toBe(`${"a".repeat(4_090)}${"b".repeat(100)}`);
  });

  it("delivers deterministic directory replies through the active stream", async () => {
    const visible: Array<string> = [];
    const channel = makeWhatsAppChannel({
      accessToken: "test-access-token",
      appSecret: "test-app-secret",
      conversation: () => ({ target: "self" }),
      phoneNumberId: "123456789",
      userName: "osfo_test",
      verifyToken: "test-verify-token",
    });
    const surface = {
      post: async (message: string | { markdown: string } | AsyncIterable<string>) => {
        if (typeof message === "string") visible.push(message);
        else if (Symbol.asyncIterator in message) {
          for await (const chunk of message) visible.push(chunk);
        } else visible.push(message.markdown);
      },
    };

    await deliverMessengerReply({
      event: event("15550000001"),
      policy: channel.delivery ?? {},
      surface,
      target: {
        cancelChat: () => undefined,
        chat: async (_message, callback) => {
          await callback.onStart({ requestId: "directory-reply" });
          await callback.onEvent(
            JSON.stringify({ delta: "Connect WhatsApp from Osfo.", type: "text-delta" }),
          );
          await callback.onDone();
        },
      },
    });

    expect(visible).toEqual(["Connect WhatsApp from Osfo."]);
  });
});

const verificationRequest = (token: string, challenge: string) =>
  new Request(
    `https://osfo.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`,
  );

const event = (authorId: string) => ({
  author: { userId: authorId },
  capabilities: {},
  kind: "direct-message" as const,
  message: {
    attachments: [],
    author: { userId: authorId },
    id: "message-1",
    providerMessageId: "message-1",
    text: "Hello",
  },
  messengerId: "whatsapp",
  provider: "whatsapp",
  thread: {
    id: `whatsapp:123456789:${authorId}`,
    isDirectMessage: true,
    providerThreadId: `whatsapp:123456789:${authorId}`,
  },
});

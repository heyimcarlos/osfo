import { createWhatsAppAdapter, type WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { messengerChannel, type ChannelDefinition } from "@cloudflare/think";
import {
  chatSdkMessenger,
  type MessengerConversationResolver,
  type MessengerEvent,
} from "@cloudflare/think/messengers";

import type { OsfoAgent } from "../agents/osfo/agent";

/* oxlint-disable effecttsgo/async-function -- Think conversation and delivery boundaries are Promise-based. */

const WHATSAPP_INSTRUCTIONS =
  "Reply for a private WhatsApp chat. Use concise text and short paragraphs. Do not expose internal identifiers or operational details.";

/** Official WhatsApp adapter credentials and identity. */
export interface WhatsAppAdapterOptions {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly phoneNumberId: string;
  readonly userName: string;
  readonly verifyToken: string;
}

/** Configuration for the Osfo WhatsApp Think channel. */
export interface WhatsAppChannelOptions extends WhatsAppAdapterOptions {
  readonly conversation: MessengerConversationResolver;
}

/** Product dependencies used to map one WhatsApp author to a registered Agent facet. */
export interface WhatsAppConversationOptions {
  readonly agentClass: typeof OsfoAgent;
  readonly hasAgent: (agentId: string) => boolean;
  readonly resolveAgentId: (authorId: string, messengerId: string) => Promise<string | null>;
}

/** Construct the official Chat SDK adapter used by both webhook methods. */
export const makeWhatsAppAdapter = (options: WhatsAppAdapterOptions): WhatsAppAdapter =>
  createWhatsAppAdapter({
    accessToken: options.accessToken,
    appSecret: options.appSecret,
    phoneNumberId: options.phoneNumberId,
    userName: options.userName,
    verifyToken: options.verifyToken,
  });

const makeThinkWhatsAppAdapter = (options: WhatsAppAdapterOptions) => {
  const adapter = makeWhatsAppAdapter(options);
  // SAFETY: Think and the official WhatsApp package use the same Chat SDK Adapter at runtime. Their declarations differ only because WhatsApp exposes botUserId as optional until initialization.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Compatibility boundary between two upstream package declarations.
  return adapter as Parameters<typeof chatSdkMessenger>[0]["adapter"];
};

/** Resolve one WhatsApp conversation without taking ownership of transport state. */
export const makeWhatsAppConversationResolver =
  (options: WhatsAppConversationOptions): MessengerConversationResolver =>
  async (event: MessengerEvent) => {
    const authorId = event.author?.userId;
    if (authorId === undefined || !event.thread.isDirectMessage) return { target: "self" };
    const agentId = await options.resolveAgentId(authorId, event.messengerId);
    return agentId !== null && options.hasAgent(agentId)
      ? { agentClass: options.agentClass, name: agentId, target: "subagent" }
      : { target: "self" };
  };

/** Build the only WhatsApp transport configuration used by Osfo. */
export const makeWhatsAppChannel = (options: WhatsAppChannelOptions): ChannelDefinition => ({
  ...messengerChannel(
    chatSdkMessenger({
      adapter: makeThinkWhatsAppAdapter(options),
      adapterName: "whatsapp",
      conversation: options.conversation,
      delivery: {
        errorResponseText: "I could not answer that right now. Please try again.",
        interruptedResponseText: "My response was interrupted. Please send your message again.",
      },
      path: "/webhooks/whatsapp",
      provider: "whatsapp",
      respondTo: ["direct-message", "mention", "subscribed-thread", "action"],
      userName: options.userName,
      // The official adapter still verifies the POST signature. This disables only Think's second verifier.
      verifyWebhook: false,
    }),
  ),
  instructions: WHATSAPP_INSTRUCTIONS,
  maxTurns: 6,
  tools: (all) => {
    const selected = { ...all };
    delete selected.exportDocument;
    return selected;
  },
});

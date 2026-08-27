import { createWhatsAppAdapter, type WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { messengerChannel, type ChannelDefinition } from "@cloudflare/think";
import { chatSdkMessenger, type MessengerConversationResolver } from "@cloudflare/think/messengers";

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
    delete selected.exportArtifact;
    return selected;
  },
});

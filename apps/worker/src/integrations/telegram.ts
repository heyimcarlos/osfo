import { messengerChannel, type ChannelDefinition } from "@cloudflare/think";
import type { MessengerConversationResolver } from "@cloudflare/think/messengers";
import {
  isExpectedTelegramFinalEditNoop,
  telegramMessenger,
  type TelegramMessengerOptions,
} from "@cloudflare/think/messengers/telegram";

/* oxlint-disable effecttsgo/async-function -- The Think conversation resolver is Promise-based. */

const TELEGRAM_INSTRUCTIONS =
  "Reply for a private Telegram chat. Use concise text and short paragraphs. Do not expose internal identifiers or operational details.";

/** Configuration required by the Cloudflare Think Telegram channel. */
export interface TelegramChannelOptions {
  readonly apiBaseURL?: string | undefined;
  readonly conversation: MessengerConversationResolver;
  readonly secretToken: string;
  readonly token: string;
  readonly userName: string;
}

/** Build the only Telegram transport configuration used by Osfo. */
export const makeTelegramChannel = (options: TelegramChannelOptions): ChannelDefinition => {
  const messengerOptions: TelegramMessengerOptions = {
    conversation: options.conversation,
    delivery: {
      errorResponseText: "I could not answer that right now. Please try again.",
      interruptedResponseText: "My response was interrupted. Please send your message again.",
      isExpectedDeliveryCompletion: isExpectedTelegramFinalEditNoop,
    },
    mode: "webhook",
    path: "/webhooks/telegram",
    respondTo: ["direct-message", "mention", "subscribed-thread", "action"],
    secretToken: options.secretToken,
    token: options.token,
    userName: options.userName,
  };
  if (options.apiBaseURL !== undefined) messengerOptions.apiBaseUrl = options.apiBaseURL;

  return {
    ...messengerChannel(telegramMessenger(messengerOptions)),
    instructions: TELEGRAM_INSTRUCTIONS,
    maxTurns: 6,
    tools: (all) => {
      const selected = { ...all };
      delete selected.exportDocument;
      delete selected.exportArtifact;
      return selected;
    },
  };
};

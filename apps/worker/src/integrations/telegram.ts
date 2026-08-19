import { messengerChannel, type ChannelDefinition, type StreamCallback } from "@cloudflare/think";
import type { MessengerConversationResolver, MessengerEvent } from "@cloudflare/think/messengers";
import {
  isExpectedTelegramFinalEditNoop,
  telegramMessenger,
} from "@cloudflare/think/messengers/telegram";

import type { OsfoAgent } from "../agents/osfo/agent";

/* oxlint-disable effecttsgo/async-function -- The Think conversation resolver is Promise-based. */

const TELEGRAM_INSTRUCTIONS =
  "Reply for a private Telegram chat. Use concise text and short paragraphs. Do not expose internal identifiers or operational details.";
const DETERMINISTIC_REPLY_COMPLETE = "osfo:telegram:deterministic-reply-complete";

/** Configuration required by the Cloudflare Think Telegram channel. */
export interface TelegramChannelOptions {
  readonly conversation: MessengerConversationResolver;
  readonly secretToken: string;
  readonly token: string;
  readonly userName: string;
}

/** Product dependencies used to map one Telegram author to a registered Agent facet. */
export interface TelegramConversationOptions {
  readonly agentClass: typeof OsfoAgent;
  readonly hasAgent: (agentId: string) => boolean;
  readonly isAllowed: (authorId: string) => boolean;
  readonly resolveAgentId: (authorId: string) => Promise<string | null>;
}

/** Resolve one Telegram conversation without taking ownership of transport state. */
export const makeTelegramConversationResolver =
  (options: TelegramConversationOptions): MessengerConversationResolver =>
  async (event: MessengerEvent) => {
    const authorId = event.message?.author.userId ?? event.author?.userId;
    if (authorId === undefined || !options.isAllowed(authorId)) return { target: "self" };
    const agentId = await options.resolveAgentId(authorId);
    return agentId !== null && options.hasAgent(agentId)
      ? { agentClass: options.agentClass, name: agentId, target: "subagent" }
      : { target: "self" };
  };

/** Build the only Telegram transport configuration used by Osfo. */
export const makeTelegramChannel = (options: TelegramChannelOptions): ChannelDefinition => ({
  ...messengerChannel(
    telegramMessenger({
      conversation: options.conversation,
      delivery: {
        errorResponseText: "I could not answer that right now. Please try again.",
        interruptedResponseText: "My response was interrupted. Please send your message again.",
        isExpectedDeliveryCompletion: (error, callback) =>
          (error instanceof Error && error.message === DETERMINISTIC_REPLY_COMPLETE) ||
          isExpectedTelegramFinalEditNoop(error, callback),
      },
      mode: "webhook",
      path: "/webhooks/telegram",
      respondTo: ["direct-message"],
      secretToken: options.secretToken,
      token: options.token,
      userName: options.userName,
    }),
  ),
  instructions: TELEGRAM_INSTRUCTIONS,
  maxTurns: 6,
  tools: (all) => {
    const selected = { ...all };
    delete selected.exportDocument;
    return selected;
  },
});

/** End the messenger reply after `deliverNotice` posts a deterministic response. */
export const completeDeterministicTelegramReply = async (
  callback: StreamCallback,
): Promise<never> => {
  await callback.onError(DETERMINISTIC_REPLY_COMPLETE);
  throw new Error(DETERMINISTIC_REPLY_COMPLETE);
};

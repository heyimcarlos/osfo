import { createTelegramAdapter } from "@chat-adapter/telegram";
import { splitTelegramMessageText } from "@cloudflare/think/messengers/telegram";
import { Effect, Redacted } from "effect";

import {
  TelegramOutboundUnavailable,
  type TelegramOutbound,
} from "../../handlers/telegram-webhook";

/** Configuration owned by the official Chat SDK Telegram adapter. */
export interface Options {
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly botToken: Redacted.Redacted;
  readonly userName: string;
}

/** Post deterministic onboarding responses through the official Telegram adapter. */
export const make = (options: Options): TelegramOutbound => {
  const adapter = createTelegramAdapter({
    allowedUserIds: [...options.allowedUserIds],
    botToken: Redacted.value(options.botToken),
    mode: "webhook",
    userName: options.userName,
  });
  return {
    post: (chatId, text) =>
      Effect.forEach(
        splitTelegramMessageText(text),
        (chunk) =>
          Effect.tryPromise({
            try: () => adapter.postMessage(adapter.encodeThreadId({ chatId }), chunk),
            catch: (cause) =>
              new TelegramOutboundUnavailable({
                cause,
                message: "Telegram could not receive the onboarding response",
              }),
          }),
        { concurrency: 1, discard: true },
      ),
  };
};

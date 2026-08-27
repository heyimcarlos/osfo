import {
  createWhatsAppAdapter,
  type WhatsAppAdapter,
  type WhatsAppAdapterConfig,
} from "@chat-adapter/whatsapp";
import { messengerChannel, type ChannelDefinition } from "@cloudflare/think";
import { chatSdkMessenger, type MessengerConversationResolver } from "@cloudflare/think/messengers";
import { ConsoleLogger } from "chat";
import { Duration, Effect, Layer, Redacted } from "effect";

import type { WhatsAppConfig } from "../config";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Think boundaries are Promise-based and Effect/domain variants use the canonical _tag discriminator. */

const WHATSAPP_INSTRUCTIONS =
  "Reply for a private WhatsApp chat. Use concise text and short paragraphs. Do not expose internal identifiers or operational details.";

/** Official WhatsApp adapter credentials and identity. */
export interface WhatsAppAdapterOptions {
  readonly accessToken: string;
  readonly apiUrl?: string | undefined;
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
export const makeWhatsAppAdapter = (options: WhatsAppAdapterOptions): WhatsAppAdapter => {
  const adapterConfig: WhatsAppAdapterConfig = {
    accessToken: options.accessToken,
    appSecret: options.appSecret,
    phoneNumberId: options.phoneNumberId,
    userName: options.userName,
    verifyToken: options.verifyToken,
  };
  if (options.apiUrl !== undefined) adapterConfig.apiUrl = trimTrailingSlash(options.apiUrl);
  return createWhatsAppAdapter(adapterConfig);
};

/** Build the only proactive WhatsApp operation, disabled until approval is attested. */
export const wakeUpSenderLayer = (config: WhatsAppConfig) =>
  Layer.succeed(
    WhatsAppWakeUps.Sender,
    WhatsAppWakeUps.Sender.of({
      sendTemplate: Effect.fn("WhatsAppWakeUpSender.sendTemplate")(function* (input) {
        const activation = config.wakeUp;
        if (activation._tag === "Inactive") {
          return yield* new WhatsAppWakeUps.ProviderAmbiguous({
            cause: "WhatsApp Wake-up template approval is not attested",
            failureClass: "malformedSuccess",
          });
        }
        const adapterConfig: WhatsAppAdapterConfig = {
          accessToken: Redacted.value(config.accessToken),
          appSecret: Redacted.value(config.appSecret),
          logger: new ConsoleLogger("silent"),
          phoneNumberId: config.phoneNumberId,
          userName: config.botUsername,
          verifyToken: Redacted.value(config.verifyToken),
        };
        if (config.apiBaseURL !== undefined) {
          adapterConfig.apiUrl = trimTrailingSlash(config.apiBaseURL);
        }
        const adapter = createWhatsAppAdapter(adapterConfig);
        const threadId = `whatsapp:${config.phoneNumberId}:${input.endpoint}`;
        return yield* Effect.tryPromise({
          try: () =>
            adapter.sendTemplate(threadId, {
              language: input.locale,
              name: activation.templateName,
            }),
          catch: classifyWakeUpFailure,
        }).pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.catchTag(
            "TimeoutError",
            (cause) =>
              new WhatsAppWakeUps.ProviderAmbiguous({ cause, failureClass: "providerTimeout" }),
          ),
          Effect.map(({ id }) => id),
        );
      }),
    }),
  );

const classifyWakeUpFailure = (cause: unknown) => {
  if (cause instanceof Error && isProvenProviderRejection(cause.message)) {
    return new WhatsAppWakeUps.ProviderRejected({ cause });
  }
  return new WhatsAppWakeUps.ProviderAmbiguous({
    cause,
    failureClass:
      cause instanceof TypeError ||
      (cause instanceof Error &&
        /network|fetch|connection|WhatsApp API error:/iu.test(cause.message))
        ? "connectionLost"
        : "malformedSuccess",
  });
};

const isProvenProviderRejection = (message: string) => {
  const match = /^WhatsApp API error: (\d{3})\b/u.exec(message);
  const statusText = match?.[1];
  if (statusText === undefined) return false;
  const status = Number.parseInt(statusText, 10);
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/u, "");

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

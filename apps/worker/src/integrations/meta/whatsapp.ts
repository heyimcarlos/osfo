import { Effect, Redacted, Schema } from "effect";

import { ProviderMessageId } from "../../domain";
import {
  type InboundWhatsAppMessage,
  WhatsAppDirectChannelIdentity,
  WhatsAppMessageText,
  WhatsAppPhoneNumberId,
} from "../../services/whatsapp-admission";

/** Expected failure when Meta webhook authentication does not match configuration. */
export class MetaWebhookAuthenticationFailed extends Schema.TaggedError<MetaWebhookAuthenticationFailed>()(
  "MetaWebhookAuthenticationFailed",
  { message: Schema.String },
) {}

/** Expected failure when an authenticated Meta body is outside the closed event schema. */
export class MetaWebhookPayloadInvalid extends Schema.TaggedError<MetaWebhookPayloadInvalid>()(
  "MetaWebhookPayloadInvalid",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected failure when request or Web Crypto I/O cannot authenticate a Meta event. */
export class MetaWebhookUnavailable extends Schema.TaggedError<MetaWebhookUnavailable>()(
  "MetaWebhookUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Successful Meta verification challenge. */
export interface ChallengeVerified {
  readonly _tag: "ChallengeVerified";
  readonly challenge: string;
}

/** Valid inbound facts that do not enter normal UserMessage admission. */
export type IgnoredMetaEvent =
  | {
      readonly _tag: "GroupMessageRejected";
      readonly phoneNumberId: string;
      readonly providerMessageId: string;
    }
  | {
      readonly _tag: "NonMessageEvent";
      readonly phoneNumberId: string;
    }
  | {
      readonly _tag: "ProviderEcho";
      readonly phoneNumberId: string;
      readonly providerMessageId: string;
    }
  | {
      readonly _tag: "UnsupportedDirectMessage";
      readonly phoneNumberId: string;
      readonly providerMessageId: string;
    };

/** Closed normalized output of one authenticated Meta webhook body. */
export type MetaInboundFact = IgnoredMetaEvent | InboundWhatsAppMessage;

const MessageContext = Schema.Struct({
  forwarded: Schema.optional(Schema.Boolean),
  frequently_forwarded: Schema.optional(Schema.Boolean),
  from: Schema.optional(WhatsAppDirectChannelIdentity),
  group_id: Schema.optional(Schema.String),
  id: Schema.optional(ProviderMessageId),
  referred_product: Schema.optional(
    Schema.Struct({
      catalog_id: Schema.String,
      product_retailer_id: Schema.String,
    }),
  ),
});
const MessageIdentity = Schema.Struct({
  acknowledged: Schema.Boolean,
  created_timestamp: Schema.Finite,
  hash: Schema.String,
});
const MessageReferral = Schema.Struct({
  body: Schema.optional(Schema.String),
  headline: Schema.optional(Schema.String),
  image_url: Schema.optional(Schema.String),
  media_type: Schema.optional(Schema.Literals(["image", "video"])),
  source_id: Schema.String,
  source_type: Schema.Literals(["ad", "post"]),
  source_url: Schema.String,
  thumbnail_url: Schema.optional(Schema.String),
  video_url: Schema.optional(Schema.String),
});
const MessageBase = {
  context: Schema.optional(MessageContext),
  from: WhatsAppDirectChannelIdentity,
  id: ProviderMessageId,
  identity: Schema.optional(MessageIdentity),
  referral: Schema.optional(MessageReferral),
  timestamp: Schema.String,
  to: Schema.optional(WhatsAppDirectChannelIdentity),
};
const MediaIdentity = {
  id: Schema.String,
  mime_type: Schema.String,
  sha256: Schema.String,
};
const Contact = Schema.Struct({
  addresses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        city: Schema.optional(Schema.String),
        country: Schema.optional(Schema.String),
        country_code: Schema.optional(Schema.String),
        state: Schema.optional(Schema.String),
        street: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
        zip: Schema.optional(Schema.String),
      }),
    ),
  ),
  birthday: Schema.optional(Schema.String),
  emails: Schema.optional(
    Schema.Array(
      Schema.Struct({
        email: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
      }),
    ),
  ),
  name: Schema.Struct({
    first_name: Schema.optional(Schema.String),
    formatted_name: Schema.String,
    last_name: Schema.optional(Schema.String),
    middle_name: Schema.optional(Schema.String),
    prefix: Schema.optional(Schema.String),
    suffix: Schema.optional(Schema.String),
  }),
  org: Schema.optional(
    Schema.Struct({
      company: Schema.optional(Schema.String),
      department: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
  phones: Schema.optional(
    Schema.Array(
      Schema.Struct({
        phone: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
        wa_id: Schema.optional(Schema.String),
      }),
    ),
  ),
  urls: Schema.optional(
    Schema.Array(
      Schema.Struct({ type: Schema.optional(Schema.String), url: Schema.optional(Schema.String) }),
    ),
  ),
});
const MetaMessageError = Schema.Struct({
  code: Schema.Finite,
  details: Schema.String,
  title: Schema.String,
});
const MetaMessage = Schema.Union([
  Schema.Struct({
    ...MessageBase,
    text: Schema.Struct({ body: WhatsAppMessageText }),
    type: Schema.Literal("text"),
  }),
  Schema.Struct({
    ...MessageBase,
    interactive: Schema.Struct({
      button_reply: Schema.Struct({ id: Schema.String, title: WhatsAppMessageText }),
      type: Schema.Literal("button_reply"),
    }),
    type: Schema.Literal("interactive"),
  }),
  Schema.Struct({
    ...MessageBase,
    interactive: Schema.Union([
      Schema.Struct({
        list_reply: Schema.Struct({
          description: Schema.optional(Schema.String),
          id: Schema.String,
          title: Schema.String,
        }),
        type: Schema.Literal("list_reply"),
      }),
      Schema.Struct({
        nfm_reply: Schema.Struct({
          body: Schema.String,
          name: Schema.String,
          response_json: Schema.String,
        }),
        type: Schema.Literal("nfm_reply"),
      }),
    ]),
    type: Schema.Literal("interactive"),
  }),
  Schema.Struct({
    ...MessageBase,
    button: Schema.Struct({ payload: Schema.String, text: WhatsAppMessageText }),
    type: Schema.Literal("button"),
  }),
  Schema.Struct({
    ...MessageBase,
    image: Schema.Struct({ ...MediaIdentity, caption: Schema.optional(Schema.String) }),
    type: Schema.Literal("image"),
  }),
  Schema.Struct({
    ...MessageBase,
    audio: Schema.Struct({ ...MediaIdentity, voice: Schema.optional(Schema.Boolean) }),
    type: Schema.Literal("audio"),
  }),
  Schema.Struct({
    ...MessageBase,
    document: Schema.Struct({
      ...MediaIdentity,
      caption: Schema.optional(Schema.String),
      filename: Schema.optional(Schema.String),
    }),
    type: Schema.Literal("document"),
  }),
  Schema.Struct({
    ...MessageBase,
    sticker: Schema.Struct({ ...MediaIdentity, animated: Schema.optional(Schema.Boolean) }),
    type: Schema.Literal("sticker"),
  }),
  Schema.Struct({
    ...MessageBase,
    video: Schema.Struct({ ...MediaIdentity, caption: Schema.optional(Schema.String) }),
    type: Schema.Literal("video"),
  }),
  Schema.Struct({
    ...MessageBase,
    contacts: Schema.Array(Contact),
    type: Schema.Literal("contacts"),
  }),
  Schema.Struct({
    ...MessageBase,
    location: Schema.Struct({
      address: Schema.optional(Schema.String),
      latitude: Schema.Finite,
      longitude: Schema.Finite,
      name: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
    type: Schema.Literal("location"),
  }),
  Schema.Struct({
    ...MessageBase,
    reaction: Schema.Struct({ emoji: Schema.String, message_id: ProviderMessageId }),
    type: Schema.Literal("reaction"),
  }),
  Schema.Struct({
    ...MessageBase,
    order: Schema.Struct({
      catalog_id: Schema.String,
      product_items: Schema.Array(
        Schema.Struct({
          currency: Schema.String,
          item_price: Schema.String,
          product_retailer_id: Schema.String,
          quantity: Schema.String,
        }),
      ),
      text: Schema.optional(Schema.String),
    }),
    type: Schema.Literal("order"),
  }),
  Schema.Struct({
    ...MessageBase,
    system: Schema.Struct({
      body: Schema.optional(Schema.String),
      identity: Schema.optional(Schema.String),
      new_wa_id: Schema.optional(WhatsAppDirectChannelIdentity),
      type: Schema.String,
      user: Schema.optional(WhatsAppDirectChannelIdentity),
    }),
    type: Schema.Literal("system"),
  }),
  Schema.Struct({
    ...MessageBase,
    errors: Schema.Array(MetaMessageError),
    type: Schema.Literal("unknown"),
  }),
]);
const MetaStatus = Schema.Struct({
  conversation: Schema.optional(
    Schema.Struct({
      expiration_timestamp: Schema.optional(Schema.String),
      id: Schema.String,
      origin: Schema.Struct({ type: Schema.String }),
    }),
  ),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        code: Schema.Finite,
        error_data: Schema.optional(Schema.Struct({ details: Schema.String })),
        href: Schema.optional(Schema.String),
        message: Schema.String,
        title: Schema.String,
      }),
    ),
  ),
  id: Schema.String,
  pricing: Schema.optional(
    Schema.Struct({
      billable: Schema.Boolean,
      category: Schema.String,
      pricing_model: Schema.String,
      type: Schema.optional(Schema.String),
    }),
  ),
  recipient_id: Schema.String,
  status: Schema.String,
  timestamp: Schema.String,
});
const MetaWebhook = Schema.Struct({
  entry: Schema.Array(
    Schema.Struct({
      changes: Schema.Array(
        Schema.Struct({
          field: Schema.Literal("messages"),
          value: Schema.Struct({
            contacts: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  profile: Schema.optional(Schema.Struct({ name: Schema.String })),
                  wa_id: Schema.String,
                }),
              ),
            ),
            messaging_product: Schema.Literal("whatsapp"),
            messages: Schema.optional(Schema.Array(MetaMessage)),
            metadata: Schema.Struct({
              display_phone_number: Schema.String,
              phone_number_id: WhatsAppPhoneNumberId,
            }),
            statuses: Schema.optional(Schema.Array(MetaStatus)),
          }),
        }),
      ),
      id: Schema.String,
    }),
  ),
  object: Schema.Literal("whatsapp_business_account"),
});

/** Verify Meta's GET handshake without exposing the configured token. */
export const verifyChallenge = (
  url: URL,
  verificationToken: Redacted.Redacted,
): ChallengeVerified | MetaWebhookAuthenticationFailed => {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  return mode === "subscribe" && token === Redacted.value(verificationToken) && challenge !== null
    ? { _tag: "ChallengeVerified", challenge }
    : new MetaWebhookAuthenticationFailed({ message: "Meta webhook verification failed" });
};

/** Authenticate exact request bytes, then decode only the supported Meta event shape. */
export const authenticateAndDecode = (
  request: Request,
  appSecret: Redacted.Redacted,
): Effect.Effect<
  ReadonlyArray<MetaInboundFact>,
  MetaWebhookAuthenticationFailed | MetaWebhookPayloadInvalid | MetaWebhookUnavailable
> =>
  Effect.gen(function* () {
    const rawBody = new Uint8Array(
      yield* Effect.tryPromise({
        try: () => request.arrayBuffer(),
        catch: (cause) =>
          new MetaWebhookUnavailable({
            cause,
            message: "The Meta webhook request body could not be read",
          }),
      }),
    );
    const signature = request.headers.get("X-Hub-Signature-256");
    const verified = yield* verifySignature(rawBody, signature, appSecret);
    if (!verified) {
      return yield* new MetaWebhookAuthenticationFailed({
        message: "Meta webhook signature verification failed",
      });
    }
    const webhook = yield* Schema.decodeEffect(Schema.fromJsonString(MetaWebhook), {
      onExcessProperty: "error",
    })(new TextDecoder().decode(rawBody)).pipe(
      Effect.mapError(
        (cause) =>
          new MetaWebhookPayloadInvalid({
            cause,
            message: "Meta webhook payload is outside the supported schema",
          }),
      ),
    );
    return webhook.entry.flatMap((entry) =>
      entry.changes.flatMap((change) => {
        const phoneNumberId = change.value.metadata.phone_number_id;
        if (change.value.messages === undefined) {
          return [{ _tag: "NonMessageEvent", phoneNumberId } as const];
        }
        return change.value.messages.map((message): MetaInboundFact => {
          if (message.to !== undefined) {
            return {
              _tag: "ProviderEcho",
              phoneNumberId,
              providerMessageId: message.id,
            };
          }
          if (message.context?.group_id !== undefined) {
            return {
              _tag: "GroupMessageRejected",
              phoneNumberId,
              providerMessageId: message.id,
            };
          }
          if (message.type === "text" && "text" in message) {
            return {
              _tag: "TextMessage",
              channelIdentity: message.from,
              message: message.text.body,
              phoneNumberId,
              providerMessageId: message.id,
            };
          }
          if (
            message.type === "interactive" &&
            "interactive" in message &&
            "button_reply" in message.interactive
          ) {
            return {
              _tag: "ButtonReply",
              channelIdentity: message.from,
              message: message.interactive.button_reply.title,
              phoneNumberId,
              providerMessageId: message.id,
            };
          }
          if (message.type === "button" && "button" in message) {
            return {
              _tag: "ButtonReply",
              channelIdentity: message.from,
              message: message.button.text,
              phoneNumberId,
              providerMessageId: message.id,
            };
          }
          return {
            _tag: "UnsupportedDirectMessage",
            phoneNumberId,
            providerMessageId: message.id,
          };
        });
      }),
    );
  });

const verifySignature = (
  rawBody: Uint8Array,
  signature: string | null,
  appSecret: Redacted.Redacted,
) =>
  Effect.gen(function* () {
    if (signature === null || !/^sha256=[0-9a-f]{64}$/u.test(signature)) return false;
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(Redacted.value(appSecret)),
          { hash: "SHA-256", name: "HMAC" },
          false,
          ["sign"],
        ),
      catch: (cause) =>
        new MetaWebhookUnavailable({
          cause,
          message: "Meta webhook signature verification is unavailable",
        }),
    });
    const bodyBuffer = Uint8Array.from(rawBody).buffer;
    const expected = new Uint8Array(
      yield* Effect.tryPromise({
        try: () => crypto.subtle.sign("HMAC", key, bodyBuffer),
        catch: (cause) =>
          new MetaWebhookUnavailable({
            cause,
            message: "Meta webhook signature verification is unavailable",
          }),
      }),
    );
    const actual = decodeHex(signature.slice("sha256=".length));
    let difference = expected.length ^ actual.length;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= (expected.at(index) ?? 0) ^ (actual.at(index) ?? 0);
    }
    return difference === 0;
  });

const decodeHex = (value: string) =>
  Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );

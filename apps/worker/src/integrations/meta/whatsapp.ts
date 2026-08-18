import { Effect, Redacted, Schema } from "effect";

import { ProviderMessageId } from "../../domain";
import {
  InboundWhatsAppMessage,
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
export const IgnoredMetaEvent = Schema.Union([
  Schema.TaggedStruct("GroupMessageRejected", {
    phoneNumberId: WhatsAppPhoneNumberId,
    providerMessageId: ProviderMessageId,
  }),
  Schema.TaggedStruct("MessageStatus", {
    errors: Schema.Array(
      Schema.Struct({
        code: Schema.Finite,
        details: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
        title: Schema.String,
      }),
    ),
    phoneNumberId: WhatsAppPhoneNumberId,
    providerMessageId: ProviderMessageId,
    recipientId: WhatsAppDirectChannelIdentity,
    status: Schema.Literals(["deleted", "delivered", "failed", "read", "sent"]),
    timestamp: Schema.String,
  }),
  Schema.TaggedStruct("NonMessageNotification", {
    notification: Schema.Literals([
      "account_update",
      "account_review_update",
      "message_template_status_update",
      "phone_number_name_update",
      "phone_number_quality_update",
    ]),
    occurredAt: Schema.NullOr(Schema.Finite),
    whatsAppBusinessAccountId: Schema.String,
  }),
  Schema.TaggedStruct("ProviderEcho", {
    phoneNumberId: WhatsAppPhoneNumberId,
    providerMessageId: ProviderMessageId,
  }),
  Schema.TaggedStruct("UnsupportedDirectMessage", {
    phoneNumberId: WhatsAppPhoneNumberId,
    providerMessageId: ProviderMessageId,
  }),
]);

/** Valid inbound facts that do not enter normal UserMessage admission. */
export type IgnoredMetaEvent = typeof IgnoredMetaEvent.Type;

/** Closed normalized output of one authenticated Meta webhook body. */
export const MetaInboundFact = Schema.Union([IgnoredMetaEvent, InboundWhatsAppMessage]);

/** Closed normalized output of one authenticated Meta webhook body. */
export type MetaInboundFact = typeof MetaInboundFact.Type;

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
      Schema.Struct({
        type: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
      }),
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
      button_reply: Schema.Struct({
        id: Schema.String,
        title: WhatsAppMessageText,
      }),
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
    button: Schema.Struct({
      payload: Schema.String,
      text: WhatsAppMessageText,
    }),
    type: Schema.Literal("button"),
  }),
  Schema.Struct({
    ...MessageBase,
    image: Schema.Struct({
      ...MediaIdentity,
      caption: Schema.optional(Schema.String),
    }),
    type: Schema.Literal("image"),
  }),
  Schema.Struct({
    ...MessageBase,
    audio: Schema.Struct({
      ...MediaIdentity,
      voice: Schema.optional(Schema.Boolean),
    }),
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
    sticker: Schema.Struct({
      ...MediaIdentity,
      animated: Schema.optional(Schema.Boolean),
    }),
    type: Schema.Literal("sticker"),
  }),
  Schema.Struct({
    ...MessageBase,
    video: Schema.Struct({
      ...MediaIdentity,
      caption: Schema.optional(Schema.String),
    }),
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
    reaction: Schema.Struct({
      emoji: Schema.String,
      message_id: ProviderMessageId,
    }),
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
const MetaStatusBase = {
  id: ProviderMessageId,
  recipient_id: WhatsAppDirectChannelIdentity,
  timestamp: Schema.String,
};
const MetaStatusConversation = Schema.Struct({
  expiration_timestamp: Schema.optional(Schema.String),
  id: Schema.String,
  origin: Schema.Struct({ type: Schema.String }),
});
const MetaStatusPricing = Schema.Struct({
  billable: Schema.Boolean,
  category: Schema.String,
  pricing_model: Schema.String,
  type: Schema.optional(Schema.String),
});
const MetaStatusError = Schema.Struct({
  code: Schema.Finite,
  error_data: Schema.optional(Schema.Struct({ details: Schema.String })),
  href: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  title: Schema.String,
});
const MetaStatus = Schema.Union([
  Schema.Struct({
    ...MetaStatusBase,
    conversation: Schema.optional(MetaStatusConversation),
    pricing: Schema.optional(MetaStatusPricing),
    status: Schema.Literals(["sent", "delivered", "read"]),
  }),
  Schema.Struct({ ...MetaStatusBase, status: Schema.Literal("deleted") }),
  Schema.Struct({
    ...MetaStatusBase,
    errors: Schema.Array(MetaStatusError).check(Schema.isMinLength(1)),
    status: Schema.Literal("failed"),
  }),
]);
const MetaMessageChange = Schema.Struct({
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
    messages: Schema.Array(MetaMessage).check(Schema.isMinLength(1)),
    metadata: Schema.Struct({
      display_phone_number: Schema.String,
      phone_number_id: WhatsAppPhoneNumberId,
    }),
  }),
});
const MetaStatusChange = Schema.Struct({
  field: Schema.Literal("messages"),
  value: Schema.Struct({
    messaging_product: Schema.Literal("whatsapp"),
    metadata: Schema.Struct({
      display_phone_number: Schema.String,
      phone_number_id: WhatsAppPhoneNumberId,
    }),
    statuses: Schema.Array(MetaStatus).check(Schema.isMinLength(1)),
  }),
});
const MetaNonMessageChange = Schema.Union([
  Schema.Struct({
    field: Schema.Literal("phone_number_name_update"),
    value: Schema.Struct({
      decision: Schema.Literals(["APPROVED", "REJECTED"]),
      display_phone_number: Schema.String,
      rejection_reason: Schema.NullOr(Schema.String),
      requested_verified_name: Schema.String,
    }),
  }),
  Schema.Struct({
    field: Schema.Literal("phone_number_quality_update"),
    value: Schema.Struct({
      current_limit: Schema.Literals(["TIER_1K", "TIER_10K", "TIER_100K"]),
      display_phone_number: Schema.String,
      event: Schema.Literals(["ONBOARDING", "UPGRADE", "DOWNGRADE", "FLAGGED", "UNFLAGGED"]),
    }),
  }),
  Schema.Struct({
    field: Schema.Literal("account_update"),
    value: Schema.Union([
      Schema.Struct({
        event: Schema.Literal("VERIFIED_ACCOUNT"),
        phone_number: Schema.String,
      }),
      Schema.Struct({
        ban_info: Schema.Struct({
          waba_ban_date: Schema.String,
          waba_ban_state: Schema.Literals(["FLAGGED", "DISABLE", "REINSTATE"]),
        }),
        event: Schema.Literal("DISABLED_UPDATE"),
      }),
    ]),
  }),
  Schema.Struct({
    field: Schema.Literal("account_review_update"),
    value: Schema.Struct({
      decision: Schema.Literals(["APPROVED", "REJECTED"]),
    }),
  }),
  Schema.Struct({
    field: Schema.Literal("message_template_status_update"),
    value: Schema.Struct({
      event: Schema.Literals([
        "APPROVED",
        "IN_APPEAL",
        "PENDING",
        "REJECTED",
        "PENDING_DELETION",
        "DELETED",
        "DISABLED",
        "FLAGGED",
        "REINSTATED",
      ]),
      message_template_id: Schema.String,
      message_template_language: Schema.String,
      message_template_name: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  }),
]);
const MetaWebhook = Schema.Struct({
  entry: Schema.Array(
    Schema.Struct({
      changes: Schema.Array(
        Schema.Union([MetaMessageChange, MetaStatusChange, MetaNonMessageChange]),
      ),
      id: Schema.String,
      time: Schema.optional(Schema.Finite),
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
    : new MetaWebhookAuthenticationFailed({
        message: "Meta webhook verification failed",
      });
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
      entry.changes.flatMap((change): ReadonlyArray<MetaInboundFact> => {
        if (change.field !== "messages") {
          return [
            {
              _tag: "NonMessageNotification",
              notification: change.field,
              occurredAt: entry.time ?? null,
              whatsAppBusinessAccountId: entry.id,
            },
          ];
        }
        const phoneNumberId = change.value.metadata.phone_number_id;
        if ("statuses" in change.value) {
          return change.value.statuses.map((status) => ({
            _tag: "MessageStatus",
            errors:
              "errors" in status
                ? status.errors.map((error) => ({
                    code: error.code,
                    details: error.error_data?.details,
                    message: error.message,
                    title: error.title,
                  }))
                : [],
            phoneNumberId,
            providerMessageId: status.id,
            recipientId: status.recipient_id,
            status: status.status,
            timestamp: status.timestamp,
          }));
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

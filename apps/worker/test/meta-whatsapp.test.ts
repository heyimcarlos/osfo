import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import { authenticateAndDecode, verifyChallenge } from "../src/integrations/meta/whatsapp";
import { encodeJsonText, sign, webhook } from "./whatsapp-webhook-fixture";

describe("Meta WhatsApp adapter", () => {
  it.effect("matches a fixed known Meta HMAC-SHA256 vector", () =>
    Effect.gen(function* () {
      const body = '{"entry":[],"object":"whatsapp_business_account"}';
      const signature = "sha256=0fcdf92dd6b3ed4ef51de3f6a33f6c12cd86c186956b8c34054ab43f177f510b";

      const decoded = yield* authenticateAndDecode(
        request(body, signature),
        Redacted.make("meta-app-secret"),
      );

      expect(decoded).toEqual([]);
    }),
  );

  it.effect("rejects every closed Meta signature failure form", () =>
    Effect.gen(function* () {
      const body = '{"entry":[],"object":"whatsapp_business_account"}';
      const validHex = "0fcdf92dd6b3ed4ef51de3f6a33f6c12cd86c186956b8c34054ab43f177f510b";
      const failures = [
        undefined,
        `sha256=1${validHex.slice(1)}`,
        `sha1=${validHex}`,
        `sha256=${"z".repeat(64)}`,
        `sha256=${validHex.slice(1)}`,
        `sha256=${validHex}00`,
      ] as const;

      const rejected = yield* Effect.forEach(failures, (signature) =>
        authenticateAndDecode(request(body, signature), Redacted.make("meta-app-secret")).pipe(
          Effect.flip,
        ),
      );
      const mutated = yield* authenticateAndDecode(
        request(`${body} `, `sha256=${validHex}`),
        Redacted.make("meta-app-secret"),
      ).pipe(Effect.flip);

      expect(rejected).toEqual(
        Array.from({ length: 6 }, () =>
          expect.objectContaining({ _tag: "MetaWebhookAuthenticationFailed" }),
        ),
      );
      expect(mutated).toMatchObject({ _tag: "MetaWebhookAuthenticationFailed" });
    }),
  );

  it("returns the verification challenge only for an exact token match", () => {
    const url = new URL(
      "https://osfo.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-1",
    );

    expect(verifyChallenge(url, Redacted.make("verify-me"))).toEqual({
      _tag: "ChallengeVerified",
      challenge: "challenge-1",
    });
    expect(verifyChallenge(url, Redacted.make("verify-me-mutated"))).toMatchObject({
      _tag: "MetaWebhookAuthenticationFailed",
    });
  });

  it.effect("verifies the exact raw body before decoding and rejects a mutated body", () =>
    Effect.gen(function* () {
      const secret = Redacted.make("meta-app-secret");
      const body = encodeJsonText(webhook([textMessage()]));
      const signature = yield* sign(body, "meta-app-secret");
      const accepted = yield* authenticateAndDecode(request(body, signature), secret);
      const rejected = yield* Effect.flip(
        authenticateAndDecode(request(`${body} `, signature), secret),
      );

      expect(accepted).toEqual([
        {
          _tag: "TextMessage",
          channelIdentity: "14165550123",
          message: "Please help",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.1",
        },
      ]);
      expect(rejected).toMatchObject({ _tag: "MetaWebhookAuthenticationFailed" });
    }),
  );

  it.effect("decodes a signed direct reply with closed reply and product context", () =>
    Effect.gen(function* () {
      const body = encodeJsonText(
        webhook([
          {
            ...textMessage(),
            context: {
              forwarded: true,
              frequently_forwarded: false,
              from: "14165550100",
              id: "wamid.business-message",
              referred_product: {
                catalog_id: "catalog-1",
                product_retailer_id: "product-1",
              },
            },
            id: "wamid.direct-reply",
          },
        ]),
      );

      const decoded = yield* authenticateAndDecode(
        request(body, yield* sign(body, "meta-app-secret")),
        Redacted.make("meta-app-secret"),
      );

      expect(decoded).toEqual([
        {
          _tag: "TextMessage",
          channelIdentity: "14165550123",
          message: "Please help",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.direct-reply",
        },
      ]);
    }),
  );

  it.effect("rejects a signed payload outside the closed webhook schema", () =>
    Effect.gen(function* () {
      const body = encodeJsonText({
        entry: [{ changes: "not-an-array" }],
        object: "whatsapp_business_account",
      });
      const signature = yield* sign(body, "meta-app-secret");

      const rejected = yield* Effect.flip(
        authenticateAndDecode(request(body, signature), Redacted.make("meta-app-secret")),
      );

      expect(rejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
    }),
  );

  it.effect("rejects a signed text event that omits the required text payload", () =>
    Effect.gen(function* () {
      const body = encodeJsonText(
        webhook([
          {
            context: { from: "14165550100", id: "wamid.button-prompt" },
            from: "14165550123",
            id: "wamid.malformed-text",
            timestamp: "1786924800",
            type: "text",
          },
        ]),
      );
      const signature = yield* sign(body, "meta-app-secret");

      const rejected = yield* Effect.flip(
        authenticateAndDecode(request(body, signature), Redacted.make("meta-app-secret")),
      );

      expect(rejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
    }),
  );

  it.effect("rejects signed excess properties at root, message, and context boundaries", () =>
    Effect.gen(function* () {
      const rootBody = encodeJsonText({ ...webhook([textMessage()]), unexpected: true });
      const nestedBody = encodeJsonText(
        webhook([{ ...textMessage(), unexpected: "provider-field" }]),
      );
      const contextBody = encodeJsonText(
        webhook([
          {
            ...textMessage(),
            context: {
              from: "14165550100",
              id: "wamid.business-message",
              unexpected: true,
            },
          },
        ]),
      );
      const productBody = encodeJsonText(
        webhook([
          {
            ...textMessage(),
            context: {
              referred_product: {
                catalog_id: "catalog-1",
                product_retailer_id: "product-1",
                unexpected: true,
              },
            },
          },
        ]),
      );

      const rootRejected = yield* Effect.flip(
        authenticateAndDecode(
          request(rootBody, yield* sign(rootBody, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );
      const nestedRejected = yield* Effect.flip(
        authenticateAndDecode(
          request(nestedBody, yield* sign(nestedBody, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );
      const contextRejected = yield* Effect.flip(
        authenticateAndDecode(
          request(contextBody, yield* sign(contextBody, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );
      const productRejected = yield* Effect.flip(
        authenticateAndDecode(
          request(productBody, yield* sign(productBody, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );

      expect(rootRejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
      expect(nestedRejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
      expect(contextRejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
      expect(productRejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
    }),
  );

  it.effect("rejects provider identities outside domain bounds", () =>
    Effect.gen(function* () {
      const body = encodeJsonText(webhook([{ ...textMessage(), id: `wamid.${"x".repeat(500)}` }]));

      const rejected = yield* Effect.flip(
        authenticateAndDecode(
          request(body, yield* sign(body, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );

      expect(rejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
    }),
  );

  it.effect("rejects direct-message text outside the admitted length bounds", () =>
    Effect.gen(function* () {
      const emptyBody = encodeJsonText(webhook([{ ...textMessage(), text: { body: "" } }]));
      const oversizedBody = encodeJsonText(
        webhook([{ ...textMessage(), text: { body: "x".repeat(4_097) } }]),
      );

      const empty = yield* Effect.flip(
        authenticateAndDecode(
          request(emptyBody, yield* sign(emptyBody, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );
      const oversized = yield* Effect.flip(
        authenticateAndDecode(
          request(oversizedBody, yield* sign(oversizedBody, "meta-app-secret")),
          Redacted.make("meta-app-secret"),
        ),
      );

      expect(empty).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
      expect(oversized).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
    }),
  );

  it.effect("decodes supported button replies and rejects group messages", () =>
    Effect.gen(function* () {
      const body = encodeJsonText(
        webhook([
          {
            from: "14165550123",
            id: "wamid.button",
            interactive: {
              button_reply: { id: "continue", title: "Continue" },
              type: "button_reply",
            },
            timestamp: "1786924800",
            type: "interactive",
          },
          {
            button: { payload: "continue", text: "Continue setup" },
            from: "14165550123",
            id: "wamid.quick-button",
            timestamp: "1786924800",
            type: "button",
          },
          {
            ...textMessage(),
            context: {
              from: "14165550100",
              group_id: "group-1",
              id: "wamid.group-prompt",
            },
            id: "wamid.group",
          },
        ]),
      );
      const signature = yield* sign(body, "meta-app-secret");

      const decoded = yield* authenticateAndDecode(
        request(body, signature),
        Redacted.make("meta-app-secret"),
      );

      expect(decoded).toEqual([
        {
          _tag: "ButtonReply",
          channelIdentity: "14165550123",
          message: "Continue",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.button",
        },
        {
          _tag: "ButtonReply",
          channelIdentity: "14165550123",
          message: "Continue setup",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.quick-button",
        },
        {
          _tag: "GroupMessageRejected",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.group",
        },
      ]);
    }),
  );

  it.effect("classifies list replies as unsupported direct messages", () =>
    Effect.gen(function* () {
      const body = encodeJsonText(
        webhook([
          {
            from: "14165550123",
            id: "wamid.list",
            interactive: {
              list_reply: { description: "Details", id: "item-1", title: "Item" },
              type: "list_reply",
            },
            timestamp: "1786924800",
            type: "interactive",
          },
        ]),
      );

      const decoded = yield* authenticateAndDecode(
        request(body, yield* sign(body, "meta-app-secret")),
        Redacted.make("meta-app-secret"),
      );

      expect(decoded).toEqual([
        {
          _tag: "UnsupportedDirectMessage",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.list",
        },
      ]);
    }),
  );

  it.effect("classifies unsupported direct content and status-only events without messages", () =>
    Effect.gen(function* () {
      const unsupportedBody = encodeJsonText(
        webhook([
          {
            from: "14165550123",
            image: {
              caption: "A reference photo",
              id: "2754859441498128",
              mime_type: "image/jpeg",
              sha256: "81d3bd8a8db4868c9520ed47186e8b7c5789e61ff79f7f834be6950b808a90d3",
            },
            id: "wamid.image",
            timestamp: "1786924800",
            type: "image",
          },
        ]),
      );
      const statusBody = encodeJsonText(statusWebhook());

      const unsupported = yield* authenticateAndDecode(
        request(unsupportedBody, yield* sign(unsupportedBody, "meta-app-secret")),
        Redacted.make("meta-app-secret"),
      );
      const status = yield* authenticateAndDecode(
        request(statusBody, yield* sign(statusBody, "meta-app-secret")),
        Redacted.make("meta-app-secret"),
      );

      expect(unsupported).toEqual([
        {
          _tag: "UnsupportedDirectMessage",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.image",
        },
      ]);
      expect(status).toEqual([{ _tag: "NonMessageEvent", phoneNumberId: "123456789" }]);
    }),
  );

  it.effect("classifies the finite documented unsupported direct-message union", () =>
    Effect.gen(function* () {
      const media = {
        id: "media-1",
        mime_type: "application/octet-stream",
        sha256: "media-sha256",
      };
      const messages = [
        { ...unsupportedMessage("audio"), audio: { ...media, voice: true } },
        { ...unsupportedMessage("video"), video: { ...media, caption: "A video" } },
        {
          ...unsupportedMessage("document"),
          document: { ...media, caption: "A document", filename: "brief.pdf" },
        },
        {
          ...unsupportedMessage("sticker"),
          sticker: { ...media, animated: false, mime_type: "image/webp" },
        },
        {
          ...unsupportedMessage("location"),
          location: {
            address: "1 Main Street",
            latitude: 43.6532,
            longitude: -79.3832,
            name: "Toronto",
          },
        },
        {
          ...unsupportedMessage("contacts"),
          contacts: [
            {
              name: { first_name: "Ada", formatted_name: "Ada Lovelace" },
              phones: [{ phone: "+14165550124", type: "CELL", wa_id: "14165550124" }],
            },
          ],
        },
        {
          ...unsupportedMessage("reaction"),
          reaction: { emoji: "👍", message_id: "wamid.reacted-to" },
        },
        {
          ...unsupportedMessage("order"),
          context: { from: "14165550100", id: "wamid.catalog-message" },
          order: {
            catalog_id: "catalog-1",
            product_items: [
              {
                currency: "CAD",
                item_price: "10.00",
                product_retailer_id: "product-1",
                quantity: "2",
              },
            ],
            text: "Two please",
          },
        },
        {
          ...unsupportedMessage("system"),
          system: {
            body: "The customer changed their phone number",
            new_wa_id: "14165550124",
            type: "user_changed_number",
          },
        },
        {
          ...unsupportedMessage("unknown"),
          errors: [
            {
              code: 130_501,
              details: "Message type is not currently supported",
              title: "Unsupported message type",
            },
          ],
        },
      ];
      const body = encodeJsonText(webhook(messages));

      const decoded = yield* authenticateAndDecode(
        request(body, yield* sign(body, "meta-app-secret")),
        Redacted.make("meta-app-secret"),
      );

      expect(decoded).toEqual(
        [
          "audio",
          "video",
          "document",
          "sticker",
          "location",
          "contacts",
          "reaction",
          "order",
          "system",
          "unknown",
        ].map((type) => ({
          _tag: "UnsupportedDirectMessage",
          phoneNumberId: "123456789",
          providerMessageId: `wamid.${type}`,
        })),
      );
    }),
  );

  it.effect("rejects malformed known content and unrecognized message types safely", () =>
    Effect.gen(function* () {
      const invalidMessages = [
        {
          ...unsupportedMessage("image"),
          image: { id: "media-1", mime_type: "image/jpeg" },
        },
        {
          ...unsupportedMessage("image"),
          image: {
            id: "media-1",
            mime_type: "image/jpeg",
            sha256: "media-sha256",
            unexpected: true,
          },
        },
        unsupportedMessage("future-provider-type"),
      ];
      const rejected = yield* Effect.forEach(invalidMessages, (message) => {
        const body = encodeJsonText(webhook([message]));
        return sign(body, "meta-app-secret").pipe(
          Effect.flatMap((signature) =>
            authenticateAndDecode(request(body, signature), Redacted.make("meta-app-secret")),
          ),
          Effect.flip,
        );
      });

      expect(rejected).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ _tag: "MetaWebhookPayloadInvalid" }),
        ),
      );
    }),
  );

  it.effect("classifies a signed provider echo outside UserMessage admission", () =>
    Effect.gen(function* () {
      const body = encodeJsonText(
        webhook([
          {
            from: "14165550100",
            id: "wamid.provider-echo",
            text: { body: "A business reply" },
            timestamp: "1786924800",
            to: "14165550123",
            type: "text",
          },
        ]),
      );

      const decoded = yield* authenticateAndDecode(
        request(body, yield* sign(body, "meta-app-secret")),
        Redacted.make("meta-app-secret"),
      );

      expect(decoded).toEqual([
        {
          _tag: "ProviderEcho",
          phoneNumberId: "123456789",
          providerMessageId: "wamid.provider-echo",
        },
      ]);
    }),
  );
});

const request = (body: string, signature?: string) => {
  const headers = new Headers();
  if (signature !== undefined) headers.set("X-Hub-Signature-256", signature);
  return new Request("https://osfo.test/webhooks/whatsapp", {
    body,
    headers,
    method: "POST",
  });
};

const textMessage = () => ({
  from: "14165550123",
  id: "wamid.1",
  text: { body: "Please help" },
  timestamp: "1786924800",
  type: "text",
});

const unsupportedMessage = (type: string) => ({
  from: "14165550123",
  id: `wamid.${type}`,
  timestamp: "1786924800",
  type,
});

const statusWebhook = () => ({
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "14165550100", phone_number_id: "123456789" },
            statuses: [
              {
                conversation: {
                  id: "conversation-1",
                  origin: { type: "service" },
                },
                id: "wamid.outbound",
                pricing: {
                  billable: true,
                  category: "service",
                  pricing_model: "CBP",
                },
                recipient_id: "14165550123",
                status: "delivered",
                timestamp: "1786924800",
              },
            ],
          },
        },
      ],
      id: "waba-1",
    },
  ],
  object: "whatsapp_business_account",
});

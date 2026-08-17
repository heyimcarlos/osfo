import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";

import { authenticateAndDecode, verifyChallenge } from "../src/integrations/meta/whatsapp";

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

  it.effect("rejects signed excess properties at root and message boundaries", () =>
    Effect.gen(function* () {
      const rootBody = encodeJsonText({ ...webhook([textMessage()]), unexpected: true });
      const nestedBody = encodeJsonText(
        webhook([{ ...textMessage(), unexpected: "provider-field" }]),
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

      expect(rootRejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
      expect(nestedRejected).toMatchObject({ _tag: "MetaWebhookPayloadInvalid" });
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
          { ...textMessage(), context: { group_id: "group-1" }, id: "wamid.group" },
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

const webhook = (messages: ReadonlyArray<object>) => ({
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            contacts: [{ profile: { name: "Ada" }, wa_id: "14165550123" }],
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "14165550100", phone_number_id: "123456789" },
            messages,
          },
        },
      ],
      id: "waba-1",
    },
  ],
  object: "whatsapp_business_account",
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
                id: "wamid.outbound",
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

const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const sign = (body: string, secret: string) =>
  Effect.gen(function* () {
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      ),
    );
    const bytes = yield* Effect.promise(() =>
      crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const hex = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `sha256=${hex}`;
  });

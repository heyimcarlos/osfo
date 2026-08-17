import { Effect, Schema } from "effect";

export const webhook = (messages: ReadonlyArray<object>) => ({
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

export type MetaMessageStatus = "deleted" | "delivered" | "failed" | "read" | "sent";

export const statusWebhook = (status: MetaMessageStatus = "delivered") => ({
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "14165550100", phone_number_id: "123456789" },
            statuses: [statusFixture(status)],
          },
        },
      ],
      id: "waba-1",
    },
  ],
  object: "whatsapp_business_account",
});

export const statusFixture = (status: MetaMessageStatus) => {
  const base = {
    id: status === "delivered" ? "wamid.outbound" : `wamid.${status}`,
    recipient_id: "14165550123",
    status,
    timestamp: "1786924800",
  };
  if (status === "failed") {
    return {
      ...base,
      errors: [
        {
          code: 131_047,
          error_data: { details: "Message failed to send" },
          message: "Re-engagement message",
          title: "Re-engagement message",
        },
      ],
    };
  }
  if (status === "deleted") return base;
  return {
    ...base,
    conversation: { id: "conversation-1", origin: { type: "service" } },
    pricing: { billable: true, category: "service", pricing_model: "CBP" },
  };
};

export const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const sign = (body: string, secret: string) =>
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

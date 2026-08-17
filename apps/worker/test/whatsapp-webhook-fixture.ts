import { Effect, Schema } from "effect";

/** Build one authenticated-message webhook envelope for adapter and HTTP tests. */
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

/** Meta message statuses accepted by the shared signed webhook fixture. */
export type MetaMessageStatus = "deleted" | "delivered" | "failed" | "read" | "sent";

/** Build one status-only webhook using a documented Meta status shape. */
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

/** Build the documented fields for one finite Meta message status. */
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

/** Encode a test payload into the exact JSON text that will be signed. */
export const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Sign exact test payload bytes with Meta's HMAC-SHA256 header format. */
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

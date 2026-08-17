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

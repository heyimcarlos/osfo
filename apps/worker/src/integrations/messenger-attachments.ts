import type { MessengerAttachment } from "@cloudflare/think/messengers";
import { Duration, Effect, Schema } from "effect";

/** Incoming media supported by the chat document-reading capability. */
export const MediaType = Schema.Literals([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Safe download failures contain no provider URLs, credentials, or response bodies. */
export class MessengerAttachmentFailed extends Schema.TaggedError<MessengerAttachmentFailed>()(
  "MessengerAttachmentFailed",
  {
    reason: Schema.Literals([
      "unsupported",
      "missing_metadata",
      "invalid_metadata",
      "limit",
      "unavailable",
      "timeout",
    ]),
  },
) {}

export interface Options {
  readonly telegram: {
    readonly token: string;
    readonly apiBaseURL?: string | undefined;
  };
  readonly whatsapp: {
    readonly accessToken: string;
    readonly apiUrl?: string | undefined;
  };
}

export interface DownloadInput {
  readonly provider: "telegram" | "whatsapp";
  readonly attachment: MessengerAttachment;
  readonly maximumBytes: number;
}

const maximumMetadataBytes = 16_384;
const downloadTimeout = Duration.seconds(15);
const providerIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const TelegramFile = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    file_path: Schema.String.check(
      Schema.isPattern(/^[\w.-]+(?:\/[\w.-]+)*$/u),
      Schema.makeFilter((path) => !path.split("/").some((part) => part === "." || part === "..")),
    ),
  }),
});
const WhatsAppMedia = Schema.Struct({ url: Schema.String });

/** Download only media identifiers preserved by Think after authenticated channel admission. */
export const make = (options: Options, fetcher: typeof fetch = fetch) => ({
  download: Effect.fn("MessengerAttachments.download")(function* (input: DownloadInput) {
    const mediaType = input.attachment.mediaType;
    if (!Schema.is(MediaType)(mediaType)) {
      return yield* new MessengerAttachmentFailed({ reason: "unsupported" });
    }
    if (input.attachment.size !== undefined && input.attachment.size > input.maximumBytes) {
      return yield* new MessengerAttachmentFailed({ reason: "limit" });
    }
    const identifier =
      input.attachment.fetchMetadata?.[input.provider === "telegram" ? "fileId" : "mediaId"];
    if (!Schema.is(providerIdentifier)(identifier)) {
      return yield* new MessengerAttachmentFailed({ reason: "missing_metadata" });
    }
    const request = Effect.gen(function* () {
      if (input.provider === "telegram") {
        const base = (options.telegram.apiBaseURL ?? "https://api.telegram.org").replace(
          /\/+$/u,
          "",
        );
        const metadataBytes = yield* fetchBounded(fetcher, {
          url: `${base}/bot${options.telegram.token}/getFile`,
          init: { method: "POST", body: new URLSearchParams({ file_id: identifier }) },
          maximumBytes: maximumMetadataBytes,
        });
        const metadata = yield* decodeMetadata(TelegramFile, metadataBytes);
        return yield* fetchBounded(fetcher, {
          url: `${base}/file/bot${options.telegram.token}/${metadata.result.file_path}`,
          init: {},
          maximumBytes: input.maximumBytes,
        });
      }
      const base = (options.whatsapp.apiUrl ?? "https://graph.facebook.com").replace(/\/+$/u, "");
      const headers = { authorization: `Bearer ${options.whatsapp.accessToken}` };
      const metadataBytes = yield* fetchBounded(fetcher, {
        url: `${base}/v25.0/${encodeURIComponent(identifier)}`,
        init: { headers },
        maximumBytes: maximumMetadataBytes,
      });
      const metadata = yield* decodeMetadata(WhatsAppMedia, metadataBytes);
      if (!isWhatsAppMediaUrl(metadata.url, base)) {
        return yield* new MessengerAttachmentFailed({ reason: "invalid_metadata" });
      }
      return yield* fetchBounded(fetcher, {
        url: metadata.url,
        init: { headers },
        maximumBytes: input.maximumBytes,
      });
    }).pipe(
      Effect.timeout(downloadTimeout),
      Effect.catchTag("TimeoutError", () => new MessengerAttachmentFailed({ reason: "timeout" })),
    );
    const bytes = yield* request;
    return { bytes, mediaType, name: input.attachment.name };
  }),
});

const decodeMetadata = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  bytes: Uint8Array,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => new MessengerAttachmentFailed({ reason: "invalid_metadata" })),
  );

const isWhatsAppMediaUrl = (value: string, apiBase: string): boolean => {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  )
    return false;
  return (
    url.origin === new URL(apiBase).origin ||
    ["fbsbx.com", "fbcdn.net"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  );
};

// The installed chat adapters buffer the complete body and expose no transport override.
// Keep fetch and stream consumption in one abortable boundary; never follow credentialed redirects.
const fetchBounded = Effect.fn("MessengerAttachments.fetchBounded")(
  (
    fetcher: typeof fetch,
    input: { readonly url: string; readonly init: RequestInit; readonly maximumBytes: number },
  ) =>
    Effect.tryPromise({
      // oxlint-disable-next-line effecttsgo/async-function -- Fetch and ordered stream reads share one cancellation scope.
      try: async (signal) => {
        const response = await fetcher(input.url, { ...input.init, redirect: "manual", signal });
        if (signal.aborted) {
          await response.body?.cancel();
          throw new MessengerAttachmentFailed({ reason: "unavailable" });
        }
        if (!response.ok || response.body === null) {
          await response.body?.cancel();
          throw new MessengerAttachmentFailed({ reason: "unavailable" });
        }
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        const chunks: Array<Uint8Array> = [];
        let length = 0;
        try {
          while (true) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read response chunks in order and stop before retaining an oversized chunk.
            const next = await reader.read();
            if (next.done) break;
            if (length + next.value.byteLength > input.maximumBytes) {
              throw new MessengerAttachmentFailed({ reason: "limit" });
            }
            chunks.push(next.value);
            length += next.value.byteLength;
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return bytes;
        } finally {
          signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
      catch: (cause) =>
        Schema.is(MessengerAttachmentFailed)(cause)
          ? cause
          : new MessengerAttachmentFailed({ reason: "unavailable" }),
    }),
);

export * as MessengerAttachments from "./messenger-attachments";

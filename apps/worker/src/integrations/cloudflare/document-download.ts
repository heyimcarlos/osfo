import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ContentId } from "../../domain/client-content";
import { UserId } from "../../domain";
import * as ArtifactR2 from "./document-artifacts";

const DownloadClaim = Schema.fromJsonString(
  Schema.Struct({
    contentId: ContentId,
    expiresAt: Schema.Int,
    issuedAt: Schema.Int,
    userId: UserId,
  }),
);

export const downloadValidityMs = 5 * 60_000;

/** Create one short-lived authorized download URL without exposing artifact bytes to the model. */
export const makeUrl = (input: {
  readonly baseUrl: string;
  readonly contentId: ContentId;
  readonly secret: string;
  readonly userId: UserId;
}) =>
  Effect.gen(function* () {
    const issuedAt = yield* Clock.currentTimeMillis;
    const encoded = yield* Schema.encodeEffect(DownloadClaim)({
      contentId: input.contentId,
      expiresAt: issuedAt + downloadValidityMs,
      issuedAt,
      userId: input.userId,
    }).pipe(Effect.orDie);
    const payload = encodeBase64Url(new TextEncoder().encode(encoded));
    const signature = encodeBase64Url(yield* Effect.promise(() => sign(input.secret, payload)));
    const url = new URL("/documents/export", input.baseUrl);
    url.searchParams.set("token", `${payload}.${signature}`);
    return url.href;
  });

/** Serve verified retained bytes only after a signed ownership claim is validated. */
export const serve = (bucket: R2Bucket, secret: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = new URL(request.url, "https://worker.invalid").searchParams.get("token");
    if (token === null) return HttpServerResponse.empty({ status: 404 });
    const claim = yield* decodeClaim(secret, token).pipe(Effect.option);
    const now = yield* Clock.currentTimeMillis;
    if (Option.isNone(claim)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    if (
      claim.value.expiresAt - claim.value.issuedAt !== downloadValidityMs ||
      claim.value.issuedAt > now ||
      claim.value.expiresAt < now
    ) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const artifacts = ArtifactR2.make(bucket);
    const metadata = yield* artifacts.inspect(claim.value.contentId).pipe(Effect.option);
    if (Option.isNone(metadata) || metadata.value === null) {
      return HttpServerResponse.empty({ status: 404 });
    }
    if (metadata.value.userId !== claim.value.userId) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const bytes = yield* artifacts.readBytes(metadata.value).pipe(Effect.option);
    if (Option.isNone(bytes)) return HttpServerResponse.empty({ status: 503 });
    const content = metadata.value.artifact.content;
    const format = metadata.value.format;
    return HttpServerResponse.uint8Array(bytes.value, {
      contentType: content.mediaType,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="document.${format}"`,
        "content-length": String(content.byteLength),
        etag: `"sha256-${content.sha256}"`,
        "x-content-sha256": content.sha256,
      },
    });
  }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))));

const decodeClaim = (secret: string, token: string) =>
  Effect.gen(function* () {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return yield* Effect.fail("invalid token");
    const payload = token.slice(0, separator);
    const signature = decodeBase64Url(token.slice(separator + 1));
    const valid = yield* Effect.promise(() => verify(secret, payload, signature));
    if (!valid) return yield* Effect.fail("invalid signature");
    return yield* Schema.decodeEffect(DownloadClaim)(
      new TextDecoder().decode(decodeBase64Url(payload)),
    );
  });

const keyFor = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage],
  );

// oxlint-disable-next-line effecttsgo/async-function -- Web Crypto is a Promise-based boundary.
const sign = async (secret: string, payload: string) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await keyFor(secret, "sign"),
      new TextEncoder().encode(payload),
    ),
  );

// oxlint-disable-next-line effecttsgo/async-function -- Web Crypto is a Promise-based boundary.
const verify = async (secret: string, payload: string, signature: Uint8Array) =>
  crypto.subtle.verify(
    "HMAC",
    await keyFor(secret, "verify"),
    normalized(signature),
    new TextEncoder().encode(payload),
  );

const normalized = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (encoded: string) => {
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

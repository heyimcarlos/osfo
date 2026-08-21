import { ChannelLinkInviteToken } from "@osfo/api";
import { type Crypto, Effect, Encoding, Redacted, Result, Schema } from "effect";

import { ChannelLinkInviteUnavailable, ChannelLinksUnavailable, type SigningKey } from "./model";

export interface InviteTokenClaims {
  readonly e: number;
  readonly i: string;
  readonly k: string;
  readonly v: number;
}

const InviteTokenClaims = Schema.Struct({
  e: Schema.Int.check(Schema.isGreaterThan(0)),
  i: Schema.String.check(Schema.isNonEmpty()),
  k: Schema.String.check(Schema.isNonEmpty()),
  v: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const signInviteToken = (
  crypto: Crypto.Crypto,
  key: SigningKey,
  claims: InviteTokenClaims,
) => {
  const encodedClaims = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return hmacSha256(
    crypto,
    new TextEncoder().encode(Redacted.value(key.secret)),
    new TextEncoder().encode(encodedClaims),
  ).pipe(
    Effect.map((signature) =>
      ChannelLinkInviteToken.make(`${encodedClaims}.${encodeBase64Url(signature)}`),
    ),
    Effect.mapError(
      (cause) => new ChannelLinksUnavailable({ cause, operation: "signInviteToken" }),
    ),
  );
};

export const verifyInviteToken = (
  crypto: Crypto.Crypto,
  keys: ReadonlyArray<SigningKey>,
  token: Redacted.Redacted<typeof ChannelLinkInviteToken.Type>,
) =>
  Effect.gen(function* () {
    const segments = Redacted.value(token).split(".");
    const encodedClaims = segments[0];
    const encodedSignature = segments[1];
    if (segments.length !== 2 || encodedClaims === undefined || encodedSignature === undefined) {
      return yield* new ChannelLinkInviteUnavailable({ reason: "invalid" });
    }
    const claimsText = Encoding.decodeBase64UrlString(encodedClaims);
    const signature = Encoding.decodeBase64Url(encodedSignature);
    if (Result.isFailure(claimsText) || Result.isFailure(signature)) {
      return yield* new ChannelLinkInviteUnavailable({ reason: "invalid" });
    }
    const decodedClaims = Schema.decodeResult(Schema.fromJsonString(InviteTokenClaims))(
      claimsText.success,
    );
    if (Result.isFailure(decodedClaims)) {
      return yield* new ChannelLinkInviteUnavailable({ reason: "invalid" });
    }
    const claims = decodedClaims.success;
    if (claims.v !== 1) {
      return yield* new ChannelLinkInviteUnavailable({ reason: "wrong-version" });
    }
    const key = keys.find((candidate) => candidate.id === claims.k);
    if (key === undefined) {
      return yield* new ChannelLinkInviteUnavailable({ reason: "retired-key" });
    }
    const expected = yield* hmacSha256(
      crypto,
      new TextEncoder().encode(Redacted.value(key.secret)),
      new TextEncoder().encode(encodedClaims),
    ).pipe(
      Effect.mapError(
        (cause) => new ChannelLinksUnavailable({ cause, operation: "verifyInviteToken" }),
      ),
    );
    if (!sameBytes(expected, signature.success)) {
      return yield* new ChannelLinkInviteUnavailable({ reason: "forged" });
    }
    return claims;
  });

const hmacSha256 = (crypto: Crypto.Crypto, secret: Uint8Array, message: Uint8Array) =>
  Effect.gen(function* () {
    const blockSize = 64;
    const normalizedKey =
      secret.length > blockSize ? yield* crypto.digest("SHA-256", secret) : secret;
    const paddedKey = new Uint8Array(blockSize);
    paddedKey.set(normalizedKey);
    const innerPad = paddedKey.map((byte) => byte ^ 0x36);
    const outerPad = paddedKey.map((byte) => byte ^ 0x5c);
    const inner = yield* crypto.digest("SHA-256", concatenate(innerPad, message));
    return yield* crypto.digest("SHA-256", concatenate(outerPad, inner));
  });

const concatenate = (left: Uint8Array, right: Uint8Array) => {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
};

const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
